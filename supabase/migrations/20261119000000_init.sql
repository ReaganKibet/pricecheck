-- PriceCheck: initial schema
-- One canonical product catalogue, each store's listings linked to it,
-- and an append-only price history.

create extension if not exists pg_trgm;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Retailers and branches
-- ---------------------------------------------------------------------------
create table retailers (
  id          smallserial primary key,
  code        text not null unique,          -- 'naivas', 'carrefour', ...
  name        text not null,
  website     text,
  active      boolean not null default true
);

create table branches (
  id           serial primary key,
  retailer_id  smallint not null references retailers(id),
  code         text not null,                -- store's own id or a slug
  name         text not null,                -- 'Naivas Westlands'
  town         text,
  lat          double precision,
  lng          double precision,
  unique (retailer_id, code)
);

-- ---------------------------------------------------------------------------
-- Canonical products: one row per real product, whatever the store calls it
-- ---------------------------------------------------------------------------

-- array_to_string is not marked immutable, so generated columns can't use it
-- directly. This wrapper is safe: joining text with a space never changes.
create or replace function join_words(arr text[])
returns text language sql immutable parallel safe as $$
  select coalesce(array_to_string(arr, ' '), '')
$$;

create table products (
  id           serial primary key,
  name         text not null,                -- 'Jogoo Maize Meal'
  brand        text,
  category     text not null,                -- 'maize flour' (used for any-brand mode)
  size_value   numeric(10,3) not null,       -- 2
  size_unit    text not null check (size_unit in ('g','kg','ml','l','pcs')),
  pack_count   int not null default 1,       -- 1, or 30 for a tray of eggs
  barcode      text unique,
  aliases      text[] not null default '{}', -- 'unga', 'unga wa ugali', ...
  search_text  text generated always as (
                 lower(coalesce(brand,'') || ' ' || name || ' ' || category || ' ' ||
                       join_words(aliases))
               ) stored,
  embedding    vector(1536),                 -- optional, for semantic matching later
  created_at   timestamptz not null default now()
);

create index products_search_trgm on products using gin (search_text gin_trgm_ops);
create index products_category_size on products (category, size_value, size_unit);

-- Size in a base unit (g, ml or pcs) so 2 kg and 2000 g compare as equal.
create or replace function base_size(v numeric, u text)
returns numeric language sql immutable as $$
  select case u when 'kg' then v * 1000 when 'l' then v * 1000 else v end
$$;

create or replace function base_unit(u text)
returns text language sql immutable as $$
  select case u when 'kg' then 'g' when 'l' then 'ml' else u end
$$;

-- ---------------------------------------------------------------------------
-- Listings: each store's own record of a product
-- ---------------------------------------------------------------------------
create table listings (
  id                serial primary key,
  retailer_id       smallint not null references retailers(id),
  external_id       text not null,           -- the store's product id or URL slug
  raw_name          text not null,
  barcode           text,
  url               text,
  product_id        int references products(id),      -- set once matched
  suggested_product int references products(id),      -- proposed match awaiting review
  match_confidence  real,
  match_status      text not null default 'unmatched'
                    check (match_status in ('unmatched','suggested','matched','rejected')),
  updated_at        timestamptz not null default now(),
  unique (retailer_id, external_id)
);

create index listings_product on listings (product_id);
create index listings_status on listings (match_status);

-- ---------------------------------------------------------------------------
-- Prices: append-only history. Never update a row; insert a new observation.
-- ---------------------------------------------------------------------------
create table prices (
  id             bigserial primary key,
  listing_id     int not null references listings(id),
  branch_id      int references branches(id),  -- null = online price
  price          numeric(10,2) not null check (price > 0),
  promo_price    numeric(10,2) check (promo_price > 0),
  promo_ends_at  timestamptz,
  source         text not null check (source in ('online','receipt','feed','manual')),
  observed_at    timestamptz not null default now()
);

create index prices_listing_time on prices (listing_id, observed_at desc);

-- Latest known price per product per retailer (chain level, any branch).
-- Effective price = live promo price if there is one, else the shelf price.
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
order by l.product_id, l.retailer_id, p.observed_at desc;

-- ---------------------------------------------------------------------------
-- Matching helpers
-- ---------------------------------------------------------------------------

-- Fuzzy search over the catalogue. Used for shopper list items and for
-- proposing matches for new store listings.
create or replace function search_products(q text, max_results int default 5)
returns table (
  id int, name text, brand text, category text,
  size_value numeric, size_unit text, pack_count int, score real
)
language sql stable as $$
  select p.id, p.name, p.brand, p.category, p.size_value, p.size_unit, p.pack_count,
         greatest(similarity(p.search_text, lower(q)),
                  word_similarity(lower(q), p.search_text)) as score
  from products p
  where p.search_text % lower(q) or lower(q) <% p.search_text
  order by score desc, p.id
  limit max_results
$$;

-- Size written in a store's product name: 'JOGOO MAIZE MEAL 2KG' -> (2, 'kg')
create or replace function extract_size(t text, out size_value numeric, out size_unit text)
language plpgsql immutable as $$
declare
  m text[];
begin
  m := regexp_match(lower(t), '(\d+(?:\.\d+)?)\s*(kgs?|g|gms?|grams?|ml|ltrs?|litres?|liters?|lt|l|pcs)\M');
  if m is null then return; end if;
  size_value := m[1]::numeric;
  size_unit := case
    when m[2] like 'kg%' then 'kg'
    when m[2] in ('g','gm','gms','gram','grams') then 'g'
    when m[2] = 'ml' then 'ml'
    when m[2] = 'pcs' then 'pcs'
    else 'l' end;
end $$;

-- Store name with sizes removed, so sizes don't distort the fuzzy match
create or replace function strip_size(t text)
returns text language sql immutable as $$
  select trim(regexp_replace(t,
    '\d+(\.\d+)?\s*(kgs?|g|gms?|grams?|ml|ltrs?|litres?|liters?|lt|l|pcs)\M', ' ', 'gi'))
$$;

-- Readable product label: 'Jogoo Maize Meal 2kg'
create or replace function product_label(p products)
returns text language sql stable as $$
  select case when p.brand is null or p.name ilike p.brand || '%' then '' else p.brand || ' ' end
         || p.name || ' ' || trim_scale(p.size_value)::text
         || case when p.size_unit = 'pcs' then ' pcs' else p.size_unit end
$$;

-- Propose catalogue matches for unmatched store listings.
-- Barcode matches are linked straight away; fuzzy matches above the
-- threshold are only suggested and wait for a person to approve them.
-- When the store name contains a size, only a product of that size is proposed.
create or replace function propose_listing_matches(min_score real default 0.45)
returns int
language plpgsql as $$
declare
  n int := 0;
  rec record;
  best record;
  sz record;
begin
  -- 1. Exact barcode
  update listings l
     set product_id = p.id, match_status = 'matched', match_confidence = 1,
         updated_at = now()
    from products p
   where l.match_status in ('unmatched','suggested')
     and l.barcode is not null and l.barcode = p.barcode;
  get diagnostics n = row_count;

  -- 2. Fuzzy name match -> suggestion only
  for rec in select id, raw_name from listings where match_status = 'unmatched' loop
    sz := extract_size(rec.raw_name);
    select s.* into best
      from search_products(strip_size(rec.raw_name), 10) s
     where sz.size_value is null
        or (base_unit(s.size_unit) = base_unit(sz.size_unit)
            and base_size(s.size_value, s.size_unit) = base_size(sz.size_value, sz.size_unit))
     order by s.score desc
     limit 1;
    if best.id is not null and best.score >= min_score then
      update listings
         set suggested_product = best.id, match_confidence = best.score,
             match_status = 'suggested', updated_at = now()
       where id = rec.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Review queue: what a person needs to approve or reject.
create or replace view match_review_queue as
select l.id as listing_id, r.name as retailer, l.raw_name,
       p.id as suggested_product_id,
       product_label(p) as suggested_product,
       l.match_confidence
from listings l
join retailers r on r.id = l.retailer_id
left join products p on p.id = l.suggested_product
where l.match_status = 'suggested'
order by l.match_confidence desc;

create or replace function approve_match(p_listing_id int, p_product_id int default null)
returns void language sql as $$
  update listings
     set product_id = coalesce(p_product_id, suggested_product),
         match_status = 'matched', match_confidence = 1, updated_at = now()
   where id = p_listing_id
$$;

-- ---------------------------------------------------------------------------
-- Shoppers, saved lists, receipts
-- ---------------------------------------------------------------------------
create table shoppers (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null unique,          -- E.164, e.g. +2547XXXXXXXX
  name         text,
  town         text,
  any_brand    boolean not null default false,
  created_at   timestamptz not null default now()
);

create table lists (
  id          uuid primary key default gen_random_uuid(),
  shopper_id  uuid not null references shoppers(id) on delete cascade,
  name        text not null default 'My usual list',
  updated_at  timestamptz not null default now(),
  unique (shopper_id, name)
);

create table list_items (
  id          serial primary key,
  list_id     uuid not null references lists(id) on delete cascade,
  product_id  int not null references products(id),
  quantity    numeric(8,2) not null default 1 check (quantity > 0),
  any_brand   boolean not null default false
);

create table receipts (
  id            uuid primary key default gen_random_uuid(),
  shopper_id    uuid references shoppers(id),
  image_url     text,
  retailer_id   smallint references retailers(id),
  branch_id     int references branches(id),
  purchased_at  timestamptz,
  status        text not null default 'received'
                check (status in ('received','processed','rejected')),
  created_at    timestamptz not null default now()
);

-- All tables are reached through edge functions with the service role.
-- Turn on row level security so nothing is exposed through the public API.
alter table retailers   enable row level security;
alter table branches    enable row level security;
alter table products    enable row level security;
alter table listings    enable row level security;
alter table prices      enable row level security;
alter table shoppers    enable row level security;
alter table lists       enable row level security;
alter table list_items  enable row level security;
alter table receipts    enable row level security;
