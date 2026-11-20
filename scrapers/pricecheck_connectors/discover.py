"""Investigate a store's website and suggest a connector config.

    python -m pricecheck_connectors discover https://naivas.online

Run it on your own laptop: it reads robots.txt, tests the shop platform's JSON
catalogue (Magento GraphQL, Shopify, WooCommerce), finds the sitemap and the
product pages, tries every extraction strategy on a few product pages, and
shows the HTML around any price it sees so a regex can be written if needed.
"""
from __future__ import annotations

import collections
import json
import re
import time
import urllib.parse
from urllib.parse import urlsplit

from .extract import extract, scan
from .http import Blocked, PoliteClient
from .sitemap import collect_urls

PRODUCT_HINTS = re.compile(r"/(p|product|products|item|pd)/[^/]+|/p/\w+|-p-\d+|/dp/|\.html$", re.I)
NOT_PRODUCT = re.compile(r"/(search|category|categories|collections?|cart|checkout|account|customer|blog|cms|help|faq)\b|\?", re.I)
PRICE_TEXT = re.compile(r"(?:KES|KSh|Ksh|Kshs)\.?\s*[\d,]+(?:\.\d{2})?", re.I)
SITEMAP_GUESSES = ["/sitemap.xml", "/sitemap_index.xml", "/pub/sitemap.xml", "/media/sitemap.xml",
                   "/sitemap/sitemap.xml", "/pub/media/sitemap.xml", "/sitemaps/sitemap.xml"]

MAGENTO_QUERY = """{ products(search: "%s", pageSize: 3) { total_count items { sku name url_key
  price_range { minimum_price { regular_price { value currency } final_price { value } } } } } }"""
MAGENTO_ALL = """{ products(filter: {price: {from: "0.01"}}, pageSize: 3, currentPage: 1) { total_count
  items { sku name } } }"""


def discover(site: str, samples: int = 4) -> dict:
    client = PoliteClient(delay_seconds=2.0, timeout=60.0, retries=2)
    parts = urlsplit(site if "://" in site else "https://" + site)
    origin = f"{parts.scheme}://{parts.netloc}"
    host = parts.netloc.replace("www.", "")
    report: dict = {"site": origin}
    start = time.monotonic()

    def say(*a):
        print("  ", *a, flush=True)

    print(f"\nInvestigating {origin}\n", flush=True)

    # ------------------------------------------------------------ robots.txt
    allowed = client.allowed(origin + "/")
    robot_maps = client.robots_sitemaps(origin)
    say(f"robots.txt: our bot {'is ALLOWED' if allowed else 'is NOT allowed'} on the home page")
    say(f"sitemaps listed in robots.txt: {robot_maps or 'none'}")
    if not allowed:
        say("Stop here: the site asks bots like ours not to crawl. Use a partnership feed, receipts or manual checks.")
        report["allowed"] = False
        return report

    # ------------------------------------------------------- home + platform
    platform = "unknown"
    try:
        home = client.get_text(origin + "/")
        low = home.lower()
        platform = ("shopify" if "cdn.shopify.com" in low else
                    "woocommerce" if "woocommerce" in low or "wp-content" in low else
                    "magento" if "mage/" in low or "magento" in low or "mage-cache" in low else
                    "nextjs" if "__next_data__" in low else
                    "nuxt" if "__nuxt" in low else "unknown")
    except Blocked as e:
        home = ""
        say(f"home page blocked ({e}); carrying on with the sitemap")
    except Exception as e:
        home = ""
        say(f"home page did not load ({type(e).__name__}: {e}); carrying on with the sitemap")
    say(f"platform clues: {platform}")
    report["platform"] = platform

    # ---------------------------------------------- platform JSON catalogues
    if platform in ("magento", "unknown"):
        api = _probe_magento(client, origin, say)
        if api:
            report["suggested"] = {"type": "platform_api", "enabled": False, "platform": "magento",
                                   "base_url": origin, "id_prefix": f"{host}:", "source": "online",
                                   "retailer": "<retailer code>", "delay_seconds": 3, "page_size": 100}
            report["magento_total"] = api
            _print_suggestion(report)
            print(f"\n   ({time.monotonic() - start:.0f}s)", flush=True)
            return report
    if platform in ("shopify", "woocommerce"):
        path = "/products.json?limit=5" if platform == "shopify" else "/wp-json/wc/store/v1/products?per_page=5"
        try:
            data = json.loads(client.get_text(origin + path))
            n = len(data.get("products", data) if isinstance(data, dict) else data)
            say(f"{platform} JSON catalogue works ({n} products in a test page). Use type platform_api.")
            report["suggested"] = {"type": "platform_api", "enabled": False, "platform": platform,
                                   "base_url": origin, "id_prefix": f"{host}:", "source": "online",
                                   "retailer": "<retailer code>", "delay_seconds": 3}
            _print_suggestion(report)
            return report
        except Exception as e:
            say(f"{platform} JSON catalogue not available ({e}); falling back to pages.")

    # ------------------------------------------------------------- sitemaps
    urls: list[str] = []
    used_map = None
    for sm in robot_maps + [origin + g for g in SITEMAP_GUESSES]:
        try:
            urls = collect_urls(client, [sm], max_sitemaps=10)
        except Exception as e:
            say(f"sitemap {sm}: {type(e).__name__}")
            continue
        if urls:
            used_map = sm
            say(f"sitemap {sm}: {len(urls)} pages")
            break
    if not urls and home:
        links = re.findall(r'href="([^"#]+)"', home)
        urls = sorted({(u if u.startswith("http") else origin + u) for u in links if not u.startswith(("mailto:", "tel:"))})
        say(f"no sitemap; using {len(urls)} links from the home page")
    if not urls:
        say("No pages found to test. Open one product in your browser and send its link.")
        return report

    # URL shapes, so we can see which pages are products
    shapes = collections.Counter()
    example = {}
    for u in urls:
        segs = [s for s in urlsplit(u).path.split("/") if s]
        shape = "/" + "/".join(segs[:1]) + ("/…" * (len(segs) - 1)) + (" (.html)" if u.endswith(".html") else "")
        shapes[shape] += 1
        example.setdefault(shape, u)
    say("page URL shapes in the sitemap (count, shape, example):")
    for shape, n in shapes.most_common(12):
        say(f"   {n:>6}  {shape:<28} {example[shape]}")

    product_urls = [u for u in urls if PRODUCT_HINTS.search(urlsplit(u).path) and not NOT_PRODUCT.search(u)]
    if not product_urls:
        # Take the biggest group of deep pages: on most shops that's the products.
        deep = [s for s, _ in shapes.most_common() if s.count("/") >= 2 or ".html" in s]
        if deep:
            product_urls = [u for u in urls if _shape(u) == deep[0]]
            say(f"no obvious product pattern; testing the biggest group of deep pages: {deep[0]}")
    say(f"pages that look like products: {len(product_urls)}")

    # categories (for url_include)
    cats = collections.Counter()
    for u in product_urls:
        segs = [s for s in urlsplit(u).path.split("/") if s]
        if len(segs) >= 3:
            cats[segs[-3] if segs[-2] == "p" else segs[-2]] += 1
    if cats:
        say("most common categories in product URLs (use these for url_include):")
        for c, n in cats.most_common(20):
            say(f"     {n:>6}  {c}")

    # ---------------------------------------------------------- extraction
    say(f"\ntrying extraction on {samples} product pages:")
    worked = collections.Counter()
    step = max(1, len(product_urls) // samples)
    for u in product_urls[::step][:samples]:
        try:
            page = client.get_text(u)
        except Exception as e:
            say(f"  ! {u}: {type(e).__name__}: {e}")
            continue
        s = scan(page)
        got = extract(page, ["jsonld", "meta", "next"])
        flags = (f"jsonld={len(s.jsonld)} next_data={'yes' if s.next_data else 'no'} "
                 f"meta_price={'yes' if any('price' in k for k in s.meta) else 'no'} size={len(page)//1024}KB")
        if got:
            worked[got["strategy"]] += 1
            promo = f", offer {got['promo_price']}" if got.get("promo_price") else ""
            say(f"  ok  [{got['strategy']}] {got['name']}: {got['price']}{promo}   ({flags})  {u}")
        else:
            say(f"  --  no price found automatically   ({flags})  {u}")
            say(f"      title: {s.title[:100]!r}")
            for m in list(PRICE_TEXT.finditer(page))[:3]:
                snippet = re.sub(r"\s+", " ", page[max(0, m.start() - 160): m.end() + 40])
                say(f"      price seen in HTML: …{snippet}…")
            if not PRICE_TEXT.search(page):
                say("      no 'KES'/'Ksh' price in the HTML: prices are probably loaded by JavaScript")

    id_rx = r"/p/([^/?#]+)" if product_urls and all("/p/" in u for u in product_urls[:50]) else r"([^/?#]+)/?(?:[?#].*)?$"
    suggestion = {
        "type": "site_pages", "enabled": False, "retailer": "<retailer code>", "source": "online",
        "id_prefix": f"{host}:", "sitemaps": [used_map] if used_map else [],
        "url_include": [], "id_from_url": id_rx,
        "extract": [s for s, _ in worked.most_common()] or ["regex"],
        "delay_seconds": 3, "refresh_limit": 3000, "discover_limit": 500,
    }
    if not worked:
        suggestion["regex"] = {"price": "<pattern with one ( ) group around the price>",
                               "old_price": "<optional: struck-out price>"}
    report["suggested"] = suggestion
    _print_suggestion(report)
    print(f"\n   ({time.monotonic() - start:.0f}s)", flush=True)
    return report


def _shape(u: str) -> str:
    segs = [s for s in urlsplit(u).path.split("/") if s]
    return "/" + "/".join(segs[:1]) + ("/…" * (len(segs) - 1)) + (" (.html)" if u.endswith(".html") else "")


def _probe_magento(client: PoliteClient, origin: str, say) -> int | None:
    """Magento 2 shops answer GraphQL product queries at /graphql. Returns the catalogue size if it works."""
    url = origin + "/graphql?query=" + urllib.parse.quote(MAGENTO_QUERY % "sugar")
    try:
        data = json.loads(client.get_text(url))
    except PermissionError:
        say("Magento GraphQL: robots.txt disallows /graphql")
        return None
    except Exception as e:
        say(f"Magento GraphQL: not available ({type(e).__name__}: {str(e)[:80]})")
        return None
    if data.get("errors"):
        say(f"Magento GraphQL answered with errors: {str(data['errors'])[:200]}")
        return None
    items = (((data.get("data") or {}).get("products") or {}).get("items")) or []
    say(f"Magento GraphQL WORKS: a search for 'sugar' returned {len(items)} products, e.g.")
    for it in items[:3]:
        mp = (it.get("price_range") or {}).get("minimum_price") or {}
        say(f"     {it.get('name')}: regular {((mp.get('regular_price') or {}).get('value'))}, "
            f"now {((mp.get('final_price') or {}).get('value'))}  (sku {it.get('sku')})")
    try:
        all_data = json.loads(client.get_text(origin + "/graphql?query=" + urllib.parse.quote(MAGENTO_ALL)))
        total = ((all_data.get("data") or {}).get("products") or {}).get("total_count")
        if total:
            say(f"full catalogue through GraphQL: {total} products")
            return int(total)
        say(f"full-catalogue query did not work ({str(all_data.get('errors'))[:150]}); search per product instead")
        return len(items) or None
    except Exception as e:
        say(f"full-catalogue query failed ({type(e).__name__}); search per product instead")
        return len(items) or None


def _print_suggestion(report: dict) -> None:
    print("\nSuggested config (add to scrapers/sources.json, set retailer, url_include, then enabled: true):\n",
          flush=True)
    print(json.dumps(report["suggested"], indent=2), flush=True)
