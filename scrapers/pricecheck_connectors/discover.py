"""Investigate a store's website and suggest a connector config.

    python -m pricecheck_connectors discover https://naivas.online

Run it on your own laptop: it reads robots.txt, finds the sitemap and the
product pages, checks for a shop platform with a JSON catalogue, and tries
every extraction strategy on a few product pages.
"""
from __future__ import annotations

import collections
import json
import re
from urllib.parse import urlsplit

from .extract import extract, scan
from .http import Blocked, PoliteClient
from .sitemap import collect_urls

PRODUCT_HINTS = re.compile(r"/(p|product|products|item|pd)/|/p/\w+|-p-\d+|/dp/", re.I)


def discover(site: str, samples: int = 4) -> dict:
    client = PoliteClient(delay_seconds=2.0)
    parts = urlsplit(site if "://" in site else "https://" + site)
    origin = f"{parts.scheme}://{parts.netloc}"
    host = parts.netloc.replace("www.", "")
    report: dict = {"site": origin}
    say = lambda *a: print("  ", *a)  # noqa: E731

    print(f"\nInvestigating {origin}\n")

    # robots.txt
    allowed = client.allowed(origin + "/")
    sitemaps = client.robots_sitemaps(origin)
    say(f"robots.txt: our bot {'is ALLOWED' if allowed else 'is NOT allowed'} on the home page")
    say(f"sitemaps listed in robots.txt: {sitemaps or 'none'}")
    if not allowed:
        say("Stop here: the site asks bots like ours not to crawl. Use a partnership feed, receipts or manual checks.")
        report["allowed"] = False
        return report

    # home page + platform
    try:
        home = client.get_text(origin + "/")
    except Blocked as e:
        say(f"Blocked: {e}. Try from a Kenyan connection, or use the delivery apps / manual checks for this chain.")
        report["blocked"] = True
        return report
    except Exception as e:
        say(f"Could not load the home page: {e}")
        return report
    low = home.lower()
    platform = ("shopify" if "cdn.shopify.com" in low else
                "woocommerce" if "woocommerce" in low or "wp-content" in low else
                "magento" if "mage/" in low or "magento" in low else
                "nextjs" if "__next_data__" in low else
                "nuxt" if "__nuxt" in low else "unknown")
    say(f"platform clues: {platform}")
    report["platform"] = platform

    if platform in ("shopify", "woocommerce"):
        path = "/products.json?limit=5" if platform == "shopify" else "/wp-json/wc/store/v1/products?per_page=5"
        try:
            data = json.loads(client.get_text(origin + path))
            n = len(data.get("products", data) if isinstance(data, dict) else data)
            say(f"{platform} JSON catalogue works ({n} products in a test page). Use type platform_api.")
            report["suggested"] = {"type": "platform_api", "platform": platform, "base_url": origin,
                                   "id_prefix": f"{host}:", "source": "online", "delay_seconds": 3}
            _print_suggestion(report)
            return report
        except Exception as e:
            say(f"{platform} JSON catalogue not available ({e}); falling back to pages.")

    # sitemaps -> product pages
    candidates = sitemaps or [origin + "/sitemap.xml", origin + "/sitemap_index.xml"]
    urls: list[str] = []
    for sm in candidates:
        try:
            urls = collect_urls(client, [sm], max_sitemaps=8)
            if urls:
                break
        except Exception:
            continue
    product_urls = [u for u in urls if PRODUCT_HINTS.search(urlsplit(u).path)]
    say(f"sitemap pages found: {len(urls)}, of which look like products: {len(product_urls)}")
    if not product_urls:
        product_urls = [u for u in re.findall(r'href="([^"]+)"', home) if PRODUCT_HINTS.search(u)]
        product_urls = [u if u.startswith("http") else origin + u for u in product_urls]
        say(f"product links found on the home page instead: {len(product_urls)}")
    if not product_urls:
        say("No product pages found. Open a product in your browser and run discover on that URL's site section.")
        return report

    # category slugs, to choose which parts of the shop to follow
    cats = collections.Counter()
    for u in product_urls:
        segs = [s for s in urlsplit(u).path.split("/") if s]
        if len(segs) >= 3:
            cats[segs[-3] if segs[-2] == "p" else segs[-2]] += 1
    if cats:
        say("most common categories in product URLs (use these for url_include):")
        for c, n in cats.most_common(15):
            say(f"     {n:>6}  {c}")

    # try the extractors
    say(f"\ntrying extraction on {samples} product pages:")
    worked = collections.Counter()
    step = max(1, len(product_urls) // samples)
    for u in product_urls[::step][:samples]:
        try:
            page = client.get_text(u)
        except Exception as e:
            say(f"  ! {u}: {e}")
            continue
        s = scan(page)
        got = extract(page, ["jsonld", "meta", "next"])
        flags = f"jsonld={len(s.jsonld)} next_data={'yes' if s.next_data else 'no'} meta_price={'yes' if any('price' in k for k in s.meta) else 'no'}"
        if got:
            worked[got["strategy"]] += 1
            promo = f", offer {got['promo_price']}" if got.get("promo_price") else ""
            say(f"  ok  [{got['strategy']}] {got['name']}: {got['price']}{promo}   ({flags})")
        else:
            say(f"  --  no price found automatically   ({flags})  {u}")

    id_rx = r"/p/([^/?#]+)" if all("/p/" in u for u in product_urls[:50]) else r"([^/?#]+)/?(?:[?#].*)?$"
    suggestion = {
        "type": "site_pages", "enabled": False, "retailer": "<retailer code>", "source": "online",
        "id_prefix": f"{host}:", "sitemaps": sitemaps or [candidates[0]],
        "url_include": [], "id_from_url": id_rx,
        "extract": [s for s, _ in worked.most_common()] or ["regex"],
        "delay_seconds": 3, "refresh_limit": 3000, "discover_limit": 500,
    }
    if not worked:
        suggestion["regex"] = {"price": "<pattern with one ( ) group around the price>",
                               "old_price": "<optional: struck-out price>"}
        say("\nNo strategy worked automatically. View the page source of one product, find the price,")
        say("and write a regex for it in the config (see sources.json _help).")
    report["suggested"] = suggestion
    _print_suggestion(report)
    return report


def _print_suggestion(report: dict) -> None:
    print("\nSuggested config (add to scrapers/sources.json, set retailer, url_include, then enabled: true):\n")
    print(json.dumps(report["suggested"], indent=2))
