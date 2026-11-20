# Price connectors

One connector per price source. Every connector produces the same format and sends it to the
`ingest-prices` edge function, so adding a supermarket or a source never touches the rest of the system.

```
pricecheck_connectors/
  sources/site_pages.py    a chain's own website: sitemap -> product pages
  sources/platform_api.py  Shopify / WooCommerce JSON catalogues
  sources/csv_feed.py      CSV or published Google Sheet: manual checks and official chain feeds
  extract.py               reads name + price from a page (JSON-LD, meta tags, Next.js data, regex)
  http.py                  polite client: honest user agent, robots.txt, delays, retries, block detection
  runner.py                collect -> clean -> send -> report health -> alert
  discover.py              investigates a store website and suggests its config
sources.json               which sources exist, their settings, and whether they're switched on
templates/manual_prices.csv  the sheet for manual price checks
```

No extra packages: plain Python 3.10+.

## How trust works

Each price is stored with its source. When several sources have a price for the same product at the
same chain, shoppers see the most trusted one seen in the last 7 days:

**feed** (official from the chain) > **receipt** > **manual** > **online** (chain's website) > **aggregator** (delivery apps)

Any price that moves more than 40% from the last one is **held** for review instead of going live,
so a scraping glitch never reaches a shopper:

```sql
select * from held_prices;            -- what's waiting
select approve_price(<price_id>);      -- it's real
select reject_price(<price_id>);       -- it's a glitch
select * from connector_health;        -- last run of every connector
```

## Switching on a chain's website (once per chain)

Run this on your laptop, from the `scrapers` folder:

```bash
python -m pricecheck_connectors discover https://naivas.online
```

It checks `robots.txt`, finds the sitemap and product pages, lists the categories it sees, tries every
extraction method on a few products, and prints a ready config. Then:

1. Paste the suggestion over that chain's entry in `sources.json`, set `retailer`, and list the grocery
   categories in `url_include` (skip electronics, homeware and so on).
2. Check it: `python -m pricecheck_connectors run naivas_site --mode discover --dry-run --limit 5`
3. If the names and prices look right, set `"enabled": true`, commit and push.

Status on 2026-11-20:

| Chain | Website | Status |
|---|---|---|
| Carrefour | carrefour.ke | Sitemap and product URL pattern confirmed. Run `discover` to pick categories and confirm the extractor. |
| Naivas | naivas.online | Not reachable from the build environment. Run `discover`. |
| Quickmart | quickmart.co.ke | Allows general crawlers (blocks named AI-training bots). Run `discover`. |
| Chandarana | foodplus.co.ke | Run `discover`. If its robots.txt disallows us, rely on manual checks for now. |

If a site shows a "checking your browser" page to GitHub's servers (common with Cloudflare), the
run is reported as blocked. Run that connector from a Kenyan connection instead, e.g. your laptop
with Windows Task Scheduler, or a small VPS.

## Manual price checks (fastest way to start the pilot)

1. Upload `templates/manual_prices.csv` to Google Sheets. It lists every catalogue product for each chain.
2. Whoever checks prices fills in `price` (shelf price) and `promo_price` (offer price, if any) from
   their phone. Blank rows are skipped.
3. File > Share > Publish to web > choose the sheet > CSV. Copy that link.
4. Add it as the `MANUAL_SHEET_CSV_URL` secret on GitHub and set `manual_checks` to `"enabled": true`.

Rows carry the catalogue `product_id`, so manual prices link straight to the right product with no matching step.

To refresh the template after growing the catalogue:

```sql
select r.code as retailer, p.id as product_id, product_label(p) as product
from retailers r cross join products p order by r.id, p.id;
```

## Official feed from a chain

When a chain agrees to share prices, take whatever their system exports. Add a `csv_feed` entry with
`"source": "feed"` and map their column names, for example:

```json
"naivas_feed": {
  "enabled": true, "type": "csv_feed", "retailer": "naivas", "source": "feed",
  "url_env": "NAIVAS_FEED_URL", "id_prefix": "naivas-feed:",
  "columns": {"external_id": "Item Code", "name": "Description", "price": "Retail Price",
              "promo_price": "Promo Price", "barcode": "Barcode"}
}
```

Barcodes in a feed match products automatically.

## Schedule and alerts

`.github/workflows/prices.yml` runs every enabled source daily at 06:17 Nairobi time (refresh known
products), and on Mondays at 07:43 (also look for new products). You can also start it from the
GitHub Actions tab, for one source, with a dry run.

Repository secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `PRICE_API_URL` | `https://<project-ref>.supabase.co/functions/v1` |
| `PRICE_API_KEY` | the same `PRICE_API_KEY` set on Supabase |
| `MANUAL_SHEET_CSV_URL` | published CSV link of the manual-check sheet (optional) |
| `ALERT_WEBHOOK_URL` | optional: receives `{"text": "..."}` for alerts, e.g. a Lua webhook that WhatsApps you |

A run is unhealthy when it fails, finds nothing, or finds under 60% of its usual product count
(usually the store changed its website). The job then fails, and GitHub emails you.

## Tests

```bash
python -m unittest discover -s tests -v
```

They run the real runner against a fake supermarket website and a fake API: sitemaps (including
gzip), robots.txt, all four extraction methods, offers, refresh vs discover, CSV feeds, manual sheets,
health reports and alerts.
