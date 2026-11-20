"""Read sitemaps (index files, gzipped files) into a list of page URLs."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Iterable

from .http import PoliteClient

_NS = re.compile(r"\{.*?\}")


def _locs(xml_bytes: bytes) -> tuple[list[str], list[str]]:
    """Return (child sitemaps, page urls)."""
    root = ET.fromstring(xml_bytes)
    kind = _NS.sub("", root.tag)
    locs = [(el.text or "").strip() for el in root.iter() if _NS.sub("", el.tag) == "loc"]
    return (locs, []) if kind == "sitemapindex" else ([], locs)


def collect_urls(client: PoliteClient, sitemaps: Iterable[str], sitemap_include: list[str] | None = None,
                 url_include: list[str] | None = None, url_exclude: list[str] | None = None,
                 max_sitemaps: int = 50) -> list[str]:
    inc_maps = [re.compile(p) for p in (sitemap_include or [])]
    inc = [re.compile(p) for p in (url_include or [])]
    exc = [re.compile(p) for p in (url_exclude or [])]
    queue, seen_maps, urls = list(sitemaps), set(), []
    seen_urls: set[str] = set()
    while queue and len(seen_maps) < max_sitemaps:
        sm = queue.pop(0)
        if sm in seen_maps:
            continue
        seen_maps.add(sm)
        children, pages = _locs(client.get(sm))
        for c in children:
            if not inc_maps or any(p.search(c) for p in inc_maps):
                queue.append(c)
        for u in pages:
            if u in seen_urls:
                continue
            if inc and not any(p.search(u) for p in inc):
                continue
            if any(p.search(u) for p in exc):
                continue
            seen_urls.add(u)
            urls.append(u)
    return urls
