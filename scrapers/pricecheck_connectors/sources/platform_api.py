"""Connectors for common shop platforms that publish their catalogue as JSON.
Much lighter on the store than reading pages: a few requests return
hundreds of products. `discover` tells you if a site runs one of these.

  shopify      /products.json?limit=250&page=N
  woocommerce  /wp-json/wc/store/v1/products?per_page=100&page=N
"""
from __future__ import annotations

import json

from ..http import PoliteClient
from ..models import Item, RunResult, normalise_offer, parse_price


def run(name: str, cfg: dict, client: PoliteClient, limit: int | None) -> RunResult:
    kind, base, prefix = cfg["platform"], cfg["base_url"].rstrip("/"), cfg["id_prefix"]
    result = RunResult(connector=name)
    cap = limit or cfg.get("max_products", 20000)
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
