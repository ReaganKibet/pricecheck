# PriceCheck — starter repo

WhatsApp assistant that tells Kenyan shoppers which supermarket is cheapest for their whole list.

```
pricecheck/
  supabase/
    migrations/   database schema (catalogue, listings, price history, shoppers, lists)
    seed.sql      retailers + a starter catalogue of 12 everyday products
    test/         made-up prices for local testing only
    functions/
      _shared/        parsing, matching and comparison logic (+ unit tests)
      match-items/    list lines -> catalogue products (or a question to ask)
      compare-basket/ basket -> totals per supermarket, best store, split advice
      get-offers/     live promotions on a list's items and same-type products
      ingest-prices/  scrapers and retailer feeds post prices here
      lists/          save / load a shopper's list by phone number
  lua-agent/      Lua AI agent: persona + Shopping skill (5 tools)
  scrapers/       template for one scraper per supermarket
```

**Design rule:** all price logic lives in the Supabase functions. The Lua agent only calls them,
so WhatsApp, Lua web chat and a future web app always give the same numbers. The AI reads lists
and talks to people; it never adds up prices.

## What's been tested

- 14 unit tests on parsing ("2 x unga 2kg", "sukari kilo 2", "nusu kilo", "maziwa 500ml x4") and
  on comparison (promo prices, missing items, split-shop threshold, any-brand swaps never change
  pack size, no rounding drift, stale-price flags). Run: `npx tsx --test supabase/functions/_shared/logic.test.ts`
- The schema loaded on Postgres 16 with pg_trgm and pgvector; search, the price view, the listing
  matcher and the review queue were run against sample data.
- All five edge functions pass `deno check`.
- The Lua agent typechecks and passes `lua compile --strict-types` (1 agent, 1 skill, 5 tools).
- Not yet run: the edge functions on a live Supabase project, and the agent on a live Lua
  sandbox. Steps 1–2 below do that.

## 1. Supabase

```bash
supabase link --project-ref <ref>
supabase db push                        # runs the migration
psql "$DATABASE_URL" -f supabase/seed.sql
supabase secrets set PRICE_API_KEY=$(openssl rand -hex 24)   # keep this value
bash supabase/deploy.sh
```

Check it works (load `supabase/test/sample_prices.sql` into a dev project first if you want numbers):

```bash
curl -s -X POST https://<ref>.supabase.co/functions/v1/match-items \
  -H "x-api-key: <PRICE_API_KEY>" -H "content-type: application/json" \
  -d '{"items":["sukari kilo 2","maziwa 500ml x4","Jogoo 2kg"]}'
```

## 2. Lua agent

```bash
cd lua-agent
npm install
lua auth configure
lua init          # pick "Create new agent"; if it rewrites src/index.ts, restore ours from git
lua env set PRICE_API_URL https://<ref>.supabase.co/functions/v1
lua env set PRICE_API_KEY <PRICE_API_KEY>
lua test          # try match_shopping_items and compare_basket
lua chat          # send: "unga 2kg, sukari kilo 2, mafuta 1 litre, tray ya mayai"
lua push && lua deploy
lua channels configure whatsapp   # then web chat for the website
```

## 3. Prices

1. Copy `scrapers/scraper_template.py` once per store and fill in its three TODOs.
2. Each run posts to `ingest-prices`. New store listings are matched automatically by barcode;
   name matches are only *suggested*.
3. Approve suggestions in the SQL editor:

```sql
select * from match_review_queue;                        -- suggested matches, best first
select approve_match(<listing_id>);                      -- accept the suggestion
select approve_match(<listing_id>, <product_id>);        -- or link to another product
select id, raw_name from listings where match_status = 'unmatched';  -- no suggestion yet
update listings set match_status = 'rejected' where id = <listing_id>; -- not in catalogue
```

Only `matched` listings count in comparisons, so a wrong guess never reaches a shopper.

## 4. Grow the catalogue

Add the top 300 everyday products to `products` before the pilot. The `aliases` column holds the
words shoppers really use (`unga`, `sukari`, `mafuta ya kupika`, `mayai`); that is what makes
Swahili and Sheng lists match.

## Known gaps / next steps

- "unga" alone asks *maize or wheat flour?* That's deliberate. If pilot users nearly always mean
  maize flour, drop `unga` from the wheat-flour aliases.
- Receipt skill (photo -> items, prices, branch) and branch-level comparison are not built yet;
  the `receipts`, `branches` and `prices.branch_id` columns are ready for them.
- `products.embedding` is ready for semantic matching (pgvector) once trigram matching isn't enough.
- Web compare page and landing page with the WhatsApp QR code.
- Split-shop threshold defaults to Ksh 200; tune it from pilot feedback.
