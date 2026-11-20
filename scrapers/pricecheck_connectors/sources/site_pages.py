"""Connector for a chain's own website, read one product page at a time.

Two modes keep it light on the store's servers:
  refresh   re-read only pages we already know (from earlier runs). Daily.
  discover  read the sitemap and fetch up to `discover_limit` pages we have
            not seen yet. Weekly, to pick up new products.
"""
from __future__ import annotations

import re

from ..extract import extract
from ..http import Blocked, PoliteClient
from ..models import Item, RunResult
from ..sitemap import collect_urls


def run(name: str, cfg: dict, client: PoliteClient, mode: str, known: list[dict], limit: int | None) -> RunResult:
    result = RunResult(connector=name)
    id_pattern = re.compile(cfg.get("id_from_url") or r"([^/?#]+)/?(?:[?#].*)?$")
    prefix = cfg["id_prefix"]
    strategies = cfg.get("extract", ["jsonld", "meta", "next", "regex"])

    if mode == "refresh":
        # Matched products first: they are the ones shoppers compare.
        ordered = sorted(known, key=lambda k: not k.get("matched"))
        urls = [k["url"] for k in ordered if k.get("url")]
        cap = limit or cfg.get("refresh_limit", 3000)
    else:
        known_urls = {k["url"] for k in known}
        all_urls = collect_urls(client, cfg["sitemaps"], cfg.get("sitemap_include"),
                                cfg.get("url_include"), cfg.get("url_exclude"))
        urls = [u for u in all_urls if u not in known_urls]
        result.notes.append(f"sitemap: {len(all_urls)} product pages, {len(urls)} new")
        cap = limit or cfg.get("discover_limit", 500)

    for url in urls[:cap]:
        try:
            page = client.get_text(url)
        except PermissionError:
            result.skipped_by_robots += 1
            continue
        except Blocked:
            raise
        except Exception:
            result.pages_failed += 1
            continue
        result.pages_fetched += 1
        got = extract(page, strategies, cfg.get("regex"))
        if not got:
            result.pages_failed += 1
            continue
        m = id_pattern.search(url)
        ext = m.group(1) if m else url
        result.items.append(Item(
            external_id=f"{prefix}{ext}",
            name=got["name"],
            price=got["price"],
            promo_price=got.get("promo_price"),
            barcode=got.get("barcode"),
            url=url,
        ))
    return result
