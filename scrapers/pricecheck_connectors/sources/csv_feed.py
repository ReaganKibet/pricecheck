"""Connector for a CSV file or a published Google Sheet.

Used for two things:
  * manual price checks: someone fills a Google Sheet on their phone
    (template: scrapers/templates/manual_prices.csv)
  * official chain feeds: a chain shares a daily export; map its column
    names in the source config and nothing needs building on their side.

Config:
  "url": "https://docs.google.com/.../pub?output=csv"  or "url_env": "MANUAL_SHEET_CSV_URL"
  "columns": {"external_id": "Item Code", "name": "Description", "price": "Retail Price",
              "promo_price": "Promo Price", "barcode": "Barcode", "product_id": "product_id",
              "retailer": "retailer"}
  "retailer": "naivas"        (fixed retailer, or a "retailer" column for a mixed sheet)
"""
from __future__ import annotations

import csv
import io
import os

from ..http import PoliteClient
from ..models import Item, RunResult, normalise_offer, parse_price


def read_rows(cfg: dict, client: PoliteClient) -> list[dict]:
    url = cfg.get("url") or (os.environ.get(cfg["url_env"]) if cfg.get("url_env") else None)
    if not url:
        raise SystemExit(f"No CSV location: set 'url' or the {cfg.get('url_env')} environment variable.")
    if url.startswith(("http://", "https://")):
        text = client.get_text(url)
    else:
        with open(url, encoding="utf-8-sig") as f:
            text = f.read()
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def run(name: str, cfg: dict, client: PoliteClient) -> dict[str, RunResult]:
    """Returns one RunResult per retailer (a manual sheet can cover several chains)."""
    cols = {"external_id": "external_id", "name": "name", "price": "price", "promo_price": "promo_price",
            "barcode": "barcode", "product_id": "product_id", "retailer": "retailer", **cfg.get("columns", {})}
    trusted_ids = cfg.get("source") in ("manual", "feed")
    out: dict[str, RunResult] = {}
    for n, row in enumerate(read_rows(cfg, client), start=2):
        get = lambda key: (row.get(cols[key]) or "").strip()  # noqa: E731
        retailer = cfg.get("retailer") or get("retailer").lower()
        if not retailer:
            continue
        res = out.setdefault(retailer, RunResult(connector=f"{name}:{retailer}"))
        current, was = parse_price(get("promo_price")), parse_price(get("price"))
        price, promo = normalise_offer(current, was) if current else (was, None)
        item_name = get("name")
        if not price or not item_name:
            res.pages_failed += 1
            res.notes.append(f"row {n}: skipped (needs name and price)")
            continue
        pid = get("product_id")
        ext = get("external_id") or (f"pid{pid}" if pid else item_name.lower().replace(" ", "-"))
        res.items.append(Item(
            external_id=f"{cfg.get('id_prefix', name + ':')}{ext}",
            name=item_name,
            price=price,
            promo_price=promo,
            barcode=get("barcode") or None,
            product_id=int(pid) if (pid.isdigit() and trusted_ids) else None,
        ))
    return out
