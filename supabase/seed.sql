-- Retailers covered at launch
insert into retailers (code, name, website) values
  ('naivas',     'Naivas',             'https://naivas.online'),
  ('carrefour',  'Carrefour',          'https://www.carrefour.ke'),
  ('quickmart',  'Quickmart',          null),
  ('chandarana', 'Chandarana Foodplus', null)
on conflict (code) do nothing;

-- Starter catalogue: a few everyday items to show the shape.
-- Grow this to the top 300 items before the pilot.
-- aliases = words shoppers actually type or say, including Swahili.
insert into products (name, brand, category, size_value, size_unit, pack_count, aliases) values
  ('Jogoo Maize Meal',          'Jogoo',     'maize flour',   2,   'kg', 1,  '{unga,"unga wa ugali","maize flour"}'),
  ('Pembe Maize Flour',         'Pembe',     'maize flour',   2,   'kg', 1,  '{unga,"unga wa ugali","maize flour"}'),
  ('Ajab Home Baking Flour',    'Ajab',      'wheat flour',   2,   'kg', 1,  '{"unga wa ngano","baking flour","wheat flour"}'),
  ('Exe All Purpose Flour',     'Exe',       'wheat flour',   2,   'kg', 1,  '{"unga wa ngano","baking flour","wheat flour"}'),
  ('Kabras Sugar',              'Kabras',    'sugar',         2,   'kg', 1,  '{sukari,sugar}'),
  ('Mumias Sugar',              'Mumias',    'sugar',         2,   'kg', 1,  '{sukari,sugar}'),
  ('Fresh Fri Cooking Oil',     'Fresh Fri', 'cooking oil',   1,   'l',  1,  '{mafuta,"mafuta ya kupika","cooking oil"}'),
  ('Elianto Corn Oil',          'Elianto',   'cooking oil',   1,   'l',  1,  '{mafuta,"mafuta ya kupika","cooking oil"}'),
  ('Brookside Fresh Milk',      'Brookside', 'milk',          500, 'ml', 1,  '{maziwa,milk}'),
  ('Kimbo Cooking Fat',         'Kimbo',     'cooking fat',   1,   'kg', 1,  '{kimbo,"fat ya kupika","cooking fat"}'),
  ('Eggs Tray',                 null,        'eggs',          30,  'pcs',30, '{mayai,"tray ya mayai",eggs}'),
  ('Festive White Bread',       'Festive',   'bread',         400, 'g',  1,  '{mkate,bread}')
on conflict do nothing;
