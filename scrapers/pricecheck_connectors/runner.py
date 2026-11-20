"""Runs a connector end to end: collect -> check -> send -> report health -> alert."""
from __future__ import annotations

import json
import os
import traceback
import urllib.request
from pathlib import Path

from .api import PriceApi
from .http import Blocked, PoliteClient
from .models import Item, RunResult
from .sources import csv_feed, platform_api, site_pages

CONFIG_PATH = Path(__file__).resolve().parent.parent / "sources.json"


def load_config(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    return {k: v for k, v in cfg.items() if not k.startswith("_")}


def _clean(items: list[Item]) -> list[Item]:
    """Drop duplicates and obviously broken rows before anything is sent."""
    seen: dict[str, Item] = {}
    for it in items:
        if not it.name or not it.price or it.price <= 0 or it.price > 1_000_000:
            continue
        if it.promo_price is not None and not (0 < it.promo_price < it.price):
            it.promo_price = None
        seen[it.external_id] = it
    return list(seen.values())


def run_source(name: str, cfg: dict, mode: str = "refresh", dry_run: bool = False,
               limit: int | None = None, api: PriceApi | None = None) -> bool:
    """Returns True when every run it made was healthy."""
    client = PoliteClient(delay_seconds=cfg.get("delay_seconds", 3.0),
                          respect_robots=cfg.get("respect_robots", True))
    if not dry_run and api is None:
        api = PriceApi()
    kind = cfg["type"]
    retailer = cfg.get("retailer")
    results: dict[str, RunResult] = {}
    error = None
    try:
        if kind == "site_pages":
            known = [] if dry_run else api.known_listings(retailer, cfg["id_prefix"])
            if dry_run and mode == "refresh":
                mode = "discover"  # nothing known offline: sample from the sitemap instead
            results[retailer] = site_pages.run(name, cfg, client, mode, known, limit)
        elif kind == "platform_api":
            results[retailer] = platform_api.run(name, cfg, client, limit)
        elif kind == "csv_feed":
            results = csv_feed.run(name, cfg, client)
        else:
            raise SystemExit(f"{name}: unknown type {kind}")
    except Blocked as e:
        error = f"blocked by the site: {e}"
    except SystemExit:
        raise
    except Exception as e:  # report, don't crash the whole schedule
        error = f"{type(e).__name__}: {e}"
        if os.environ.get("PRICECHECK_DEBUG"):
            traceback.print_exc()

    if error and not results:
        results[retailer or name] = RunResult(connector=name)

    all_ok = True
    for ret, res in results.items():
        items = _clean(res.items)
        label = res.connector
        print(f"\n== {label} ({ret}, {cfg.get('source', 'online')}) ==")
        print(f"   pages fetched {res.pages_fetched}, failed {res.pages_failed}, "
              f"skipped by robots.txt {res.skipped_by_robots}, products {len(items)}")
        for n in res.notes[:10]:
            print(f"   note: {n}")
        if dry_run:
            for it in items[:limit or 10]:
                promo = f" (offer {it.promo_price:,.2f})" if it.promo_price else ""
                print(f"   {it.price:>10,.2f}{promo}  {it.name}  [{it.external_id}]")
            if error:
                print(f"   ERROR: {error}")
                all_ok = False
            continue

        held = 0
        status = "failed" if error else "ok"
        if items and not error:
            try:
                sent = api.send(ret, cfg.get("source", "online"), items, cfg.get("branch_code"))
                held = sent["held"]
                print(f"   sent: {sent}")
            except Exception as e:
                status, error = "failed", f"sending failed: {e}"
        verdict = api.report_run(label, status, len(items), held, error)
        print(f"   health: {verdict}")
        if not verdict.get("healthy"):
            all_ok = False
            alert(f"PriceCheck: {label} needs attention. {verdict.get('reason') or error}")
        elif held:
            alert(f"PriceCheck: {label} held {held} price(s) that moved more than 40%. "
                  f"Review them in the held_prices view.")
    return all_ok


def alert(text: str) -> None:
    """Print, and post to ALERT_WEBHOOK_URL if set (Slack, a Lua webhook that WhatsApps you, etc.).
    A failed GitHub Actions run also emails the repo owner."""
    print(f"   ALERT: {text}")
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(), method="POST",
                                     headers={"content-type": "application/json"})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        print(f"   (alert webhook failed: {e})")
