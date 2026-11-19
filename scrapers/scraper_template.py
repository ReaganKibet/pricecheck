"""
Scraper template: copy this to naivas.py, carrefour.py, qsoko.py and fill in
the three TODOs for each store.

How to find a store's price feed:
  1. Open the store's website in Chrome, open DevTools (F12) > Network > Fetch/XHR.
  2. Browse a category page. Look for a request whose response is JSON with
     product names and prices. That URL is your FEED_URL.
  3. Check the store's terms of use before collecting prices automatically.
     Run at most once or twice a day and keep requests slow (see DELAY_SECONDS).

Run:
  PRICE_API_URL=https://<ref>.supabase.co/functions/v1 PRICE_API_KEY=... python3 naivas.py
Standard library only, so it runs anywhere (a cron job, GitHub Actions, a small VPS).
"""
import json
import os
import time
import urllib.request

RETAILER = "naivas"            # TODO 1: retailer code from the retailers table
FEED_URL = "https://..."       # TODO 2: the JSON endpoint found in DevTools; use {page} for paging
DELAY_SECONDS = 3              # pause between requests; be polite
MAX_PAGES = 200
BATCH_SIZE = 500

API_URL = os.environ["PRICE_API_URL"].rstrip("/")
API_KEY = os.environ["PRICE_API_KEY"]


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "PriceCheckBot/0.1 (contact: you@example.com)"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def to_item(raw: dict) -> dict | None:
    """TODO 3: map one product from the store's JSON to our format."""
    try:
        return {
            "external_id": str(raw["id"]),
            "name": raw["name"],
            "price": float(raw["price"]),
            "promo_price": float(raw["special_price"]) if raw.get("special_price") else None,
            "promo_ends_at": raw.get("special_to_date"),
            "barcode": raw.get("barcode"),
            "url": raw.get("url"),
        }
    except (KeyError, TypeError, ValueError):
        return None  # skip products we can't read


def send(items: list[dict]) -> None:
    body = json.dumps({"retailer": RETAILER, "source": "online", "items": items}).encode()
    req = urllib.request.Request(
        f"{API_URL}/ingest-prices",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "x-api-key": API_KEY},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        print("ingested:", json.load(res))


def main() -> None:
    collected: dict[str, dict] = {}
    for page in range(1, MAX_PAGES + 1):
        data = fetch_json(FEED_URL.format(page=page))
        products = data.get("products") or data.get("items") or []  # adjust to the feed's shape
        if not products:
            break
        for raw in products:
            item = to_item(raw)
            if item and item["price"] > 0:
                collected[item["external_id"]] = item
        time.sleep(DELAY_SECONDS)

    items = list(collected.values())
    print(f"{RETAILER}: {len(items)} products")
    for i in range(0, len(items), BATCH_SIZE):
        send(items[i : i + BATCH_SIZE])


if __name__ == "__main__":
    main()
