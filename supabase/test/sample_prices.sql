-- MADE-UP PRICES FOR LOCAL TESTING ONLY. Do not load into production.
-- Creates one matched listing per product per retailer and a price for each.

insert into listings (retailer_id, external_id, raw_name, product_id, match_status, match_confidence)
select r.id, 'test-' || p.id, p.name || ' ' || p.size_value || p.size_unit, p.id, 'matched', 1
from retailers r cross join products p
on conflict (retailer_id, external_id) do nothing;

-- Base price per product, nudged per retailer so no store wins every item.
with base(name, kes) as (values
  ('Jogoo Maize Meal', 150), ('Pembe Maize Flour', 145), ('Ajab Home Baking Flour', 210),
  ('Exe All Purpose Flour', 205), ('Kabras Sugar', 330), ('Mumias Sugar', 340),
  ('Fresh Fri Cooking Oil', 330), ('Elianto Corn Oil', 420), ('Brookside Fresh Milk', 65),
  ('Kimbo Cooking Fat', 360), ('Eggs Tray', 520), ('Festive White Bread', 70)
),
nudge(code, pct) as (values ('naivas', 0.00), ('carrefour', -0.02), ('quickmart', 0.03), ('chandarana', 0.01))
insert into prices (listing_id, price, source, observed_at)
select l.id,
       round(b.kes * (1 + n.pct + ((p.id * 7 + r.id * 3) % 5 - 2) * 0.01), 0),
       'online', now() - interval '1 day'
from listings l
join products p  on p.id = l.product_id
join retailers r on r.id = l.retailer_id
join base b      on b.name = p.name
join nudge n     on n.code = r.code;

-- Chandarana does not stock Elianto in this test set
update listings set match_status = 'rejected'
 where retailer_id = (select id from retailers where code = 'chandarana')
   and product_id = (select id from products where name = 'Elianto Corn Oil');

-- A live promotion at Naivas on Kabras sugar
insert into prices (listing_id, price, promo_price, promo_ends_at, source)
select l.id, 335, 299, now() + interval '5 days', 'online'
from listings l
where l.retailer_id = (select id from retailers where code = 'naivas')
  and l.product_id = (select id from products where name = 'Kabras Sugar');
