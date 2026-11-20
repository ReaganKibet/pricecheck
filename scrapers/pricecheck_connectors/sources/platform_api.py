"""Connectors for common shop platforms that publish their catalogue as JSON.
Much lighter on the store than reading pages: a few requests return
hundreds of products. `discover` tells you if a site runs one of these.

  shopify      /products.json?limit=250&page=N
  woocommerce  /wp-json/wc/store/v1/products?per_page=100&page=N
  magento      /graphql products query (Magento 2), whole catalogue by page,
               or one search per term in "search_terms" if the site limits that
"""
from __future__ import annotations

import json
import urllib.parse

from ..http import PoliteClient
from ..models import Item, RunResult, normalise_offer, parse_price


def run(name: str, cfg: dict, client: PoliteClient, limit: int | None) -> RunResult:
    kind, base, prefix = cfg["platform"], cfg["base_url"].rstrip("/"), cfg["id_prefix"]
    result = RunResult(connector=name)
    cap = limit or cfg.get("max_products", 20000)
    if kind == "magento":
        return _magento(name, cfg, client, base, prefix, cap, result)
    page = 1
    while len(result.items) < cap and page <= cfg.get("max_pages", 400):
        if kind == "shopify":
            url = f"{base}/products.json?limit=250&page={page}"
        elif kind == "woocommerce":
            url = f"{base}/wp-json/wc/store/v1/products?per_page=100&page={page}"
        else:
            raise SystemExit(f"unknown platform {kind}")
        try:
            data = json.loads(client.get_text(url))
        except PermissionError:
            result.skipped_by_robots += 1
            break
        result.pages_fetched += 1
        products = data.get("products", []) if isinstance(data, dict) else data
        if not products:
            break
        for p in products:
            result.items.extend(_shopify(p, base, prefix) if kind == "shopify" else _woo(p, prefix))
        page += 1
    result.items = result.items[:cap]
    return result


def _shopify(p: dict, base: str, prefix: str) -> list[Item]:
    items = []
    for v in p.get("variants", []):
        price, promo = normalise_offer(parse_price(v.get("price")), parse_price(v.get("compare_at_price")))
        if not price:
            continue
        title = p.get("title", "")
        if v.get("title") and v["title"] != "Default Title":
            title = f"{title} {v['title']}"
        items.append(Item(external_id=f"{prefix}{v['id']}", name=title, price=price, promo_price=promo,
                          barcode=v.get("barcode") or None, url=f"{base}/products/{p.get('handle')}"))
    return items


def _woo(p: dict, prefix: str) -> list[Item]:
    prices = p.get("prices") or {}
    minor = int(prices.get("currency_minor_unit", 2) or 0)
    div = 10 ** minor

    def amount(key):
        v = prices.get(key)
        return (int(v) / div) if v not in (None, "") else None

    price, promo = normalise_offer(amount("sale_price") or amount("price"), amount("regular_price"))
    if not price:
        return []
    return [Item(external_id=f"{prefix}{p['id']}", name=p.get("name", ""), price=price, promo_price=promo,
                 url=p.get("permalink"))]


MAGENTO_FIELDS = """total_count page_info { total_pages } items { sku name url_key url_suffix
  price_range { minimum_price { regular_price { value } final_price { value } } } }"""


def _magento(name: str, cfg: dict, client: PoliteClient, base: str, prefix: str, cap: int,
             result: RunResult) -> RunResult:
    size = int(cfg.get("page_size", 100))
    seen: set[str] = set()

    def fetch(args: str) -> dict:
        q = "{ products(%s) { %s } }" % (args, MAGENTO_FIELDS)
        data = json.loads(client.get_text(f"{base}/graphql?query={urllib.parse.quote(q)}"))
        result.pages_fetched += 1
        if data.get("errors"):
            raise RuntimeError(f"Magento GraphQL error: {str(data['errors'])[:200]}")
        return (data.get("data") or {}).get("products") or {}

    def add(items: list) -> None:
        for it in items:
            sku = str(it.get("sku") or "")
            if not sku or sku in seen:
                continue
            seen.add(sku)
            mp = (it.get("price_range") or {}).get("minimum_price") or {}
            regular = parse_price((mp.get("regular_price") or {}).get("value"))
            final = parse_price((mp.get("final_price") or {}).get("value"))
            price, promo = normalise_offer(final or regular, regular)
            if not price:
                continue
            slug = it.get("url_key")
            url = f"{base}/{slug}{it.get('url_suffix') or '.html'}" if slug else None
            result.items.append(Item(external_id=f"{prefix}{sku}", name=it.get("name") or "", price=price,
                                     promo_price=promo, url=url))

    try:
        if cfg.get("search_terms"):
            for term in cfg["search_terms"]:
                if len(result.items) >= cap:
                    break
                add(fetch('search: %s, pageSize: %d' % (json.dumps(term), size)).get("items") or [])
        else:
            page, pages = 1, 1
            while page <= pages and len(result.items) < cap and page <= cfg.get("max_pages", 400):
                got = fetch('filter: {price: {from: "0.01"}}, pageSize: %d, currentPage: %d' % (size, page))
                pages = int((got.get("page_info") or {}).get("total_pages") or 1)
                add(got.get("items") or [])
                page += 1
    except PermissionError:
        result.skipped_by_robots += 1
    result.items = result.items[:cap]
    return result
