-- PriceCheck migration 2: trust between price sources, price sanity checks,
-- and connector run history for health alerts.

-- ---------------------------------------------------------------------------
-- 1. Sources and their trust order
--    feed       official file or API from the chain          (most trusted)
--    receipt    read from a shopper's receipt (real shelf price)
--    manual     a person checked the shelf or the chain's site
--    online     the chain's own website
--    aggregator a delivery app (Glovo, Bolt Food, Uber Eats)   (least trusted)
-- ---------------------------------------------------------------------------
alter table prices drop constraint if exists prices_source_check;
alter table prices add constraint prices_source_check
  check (source in ('feed','receipt','manual','online','aggregator'));

create or replace function source_rank(s text)
returns int language sql immutable as $$
  select case s when 'feed' then 1 when 'receipt' then 2 when 'manual' then 3
                when 'online' then 4 when 'aggregator' then 5 else 9 end
$$;

-- ---------------------------------------------------------------------------
-- 2. Price sanity: a price that jumps more than 40% from the last live price
--    for the same listing is held for review instead of reaching shoppers.
-- ---------------------------------------------------------------------------
alter table prices add column if not exists status text not null default 'live'
  check (status in ('live','held','rejected'));
alter table prices add column if not exists previous_price numeric(10,2);
alter table prices add column if not exists held_reason text;

create index if not exists prices_listing_live on prices (listing_id, observed_at desc) where status = 'live';

create or replace function hold_suspicious_price()
returns trigger language plpgsql as $$
declare
  last_price numeric;
begin
  if new.status <> 'live' then return new; end if;
  select price into last_price
    from prices
   where listing_id = new.listing_id and status = 'live'
   order by observed_at desc
   limit 1;
  if last_price is not null and abs(new.price - last_price) / last_price > 0.40 then
    new.status := 'held';
    new.previous_price := last_price;
    new.held_reason := format('price moved %s%% (from %s to %s)',
      round((new.price - last_price) / last_price * 100), last_price, new.price);
  end if;
  return new;
end $$;

drop trigger if exists prices_sanity on prices;
create trigger prices_sanity before insert on prices
  for each row execute function hold_suspicious_price();

create or replace view held_prices as
select p.id as price_id, r.name as retailer, l.raw_name, p.source,
       p.previous_price, p.price as new_price, p.held_reason, p.observed_at, l.url
from prices p
join listings l on l.id = p.listing_id
join retailers r on r.id = l.retailer_id
where p.status = 'held'
order by p.observed_at desc;

create or replace function approve_price(p_price_id bigint)
returns void language sql as $$
  update prices set status = 'live' where id = p_price_id and status = 'held'
$$;

create or replace function reject_price(p_price_id bigint)
returns void language sql as $$
  update prices set status = 'rejected' where id = p_price_id and status = 'held'
$$;

-- ---------------------------------------------------------------------------
-- 3. Which price shoppers see: among live prices seen in the last 7 days,
--    the most trusted source wins (newest first within a source). If nothing
--    is that recent, the newest live price is used and compare-basket flags
--    it as possibly out of date.
-- ---------------------------------------------------------------------------
create or replace view latest_prices as
select distinct on (l.product_id, l.retailer_id)
  l.product_id,
  l.retailer_id,
  r.code  as retailer_code,
  r.name  as retailer_name,
  l.id    as listing_id,
  p.price,
  case when p.promo_price is not null
        and (p.promo_ends_at is null or p.promo_ends_at > now())
       then p.promo_price end as promo_price,
  p.promo_ends_at,
  p.source,
  p.branch_id,
  p.observed_at
from prices p
join listings l  on l.id = p.listing_id and l.match_status = 'matched'
join retailers r on r.id = l.retailer_id and r.active
where p.status = 'live'
order by l.product_id, l.retailer_id,
         (p.observed_at > now() - interval '7 days') desc,
         source_rank(p.source),
         p.observed_at desc;

-- ---------------------------------------------------------------------------
-- 4. Connector runs and health
-- ---------------------------------------------------------------------------
create table if not exists connector_runs (
  id           bigserial primary key,
  connector    text not null,
  status       text not null check (status in ('ok','failed')),
  items        int not null default 0,
  held         int not null default 0,
  error        text,
  healthy      boolean not null,
  reason       text,
  finished_at  timestamptz not null default now()
);
create index if not exists connector_runs_recent on connector_runs (connector, finished_at desc);
alter table connector_runs enable row level security;

-- Records a run and judges it. Unhealthy when the run failed, returned
-- nothing, or returned under 60% of its usual count (median of the last
-- 5 healthy runs): usually the store changed its website.
create or replace function record_connector_run(
  p_connector text, p_status text, p_items int, p_held int default 0, p_error text default null
) returns json language plpgsql as $$
declare
  baseline numeric;
  ok boolean;
  why text;
begin
  select percentile_cont(0.5) within group (order by items) into baseline
    from (select items from connector_runs
           where connector = p_connector and status = 'ok' and healthy
           order by finished_at desc limit 5) recent;

  if p_status <> 'ok' then
    ok := false; why := coalesce('run failed: ' || p_error, 'run failed');
  elsif p_items = 0 then
    ok := false; why := 'returned no products';
  elsif baseline is not null and p_items < baseline * 0.6 then
    ok := false; why := format('returned %s products, usually about %s', p_items, round(baseline));
  else
    ok := true; why := null;
  end if;

  insert into connector_runs (connector, status, items, held, error, healthy, reason)
  values (p_connector, p_status, p_items, coalesce(p_held, 0), p_error, ok, why);

  return json_build_object('healthy', ok, 'reason', why, 'usual_items', round(baseline));
end $$;

create or replace view connector_health as
select distinct on (connector) connector, status, healthy, reason, items, held, finished_at
from connector_runs
order by connector, finished_at desc;
