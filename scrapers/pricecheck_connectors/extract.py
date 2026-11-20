"""Read a product's name and price from a product page.

Sites publish prices in different ways, so there are several strategies,
tried in the order a source's config lists them:

  jsonld  schema.org Product data in <script type="application/ld+json">
  meta    product:price:amount / og:price:amount / itemprop="price" tags
  next    Next.js page data (__NEXT_DATA__), found by looking for a product-shaped object
  regex   site-specific patterns from the source config, the last resort

`python -m pricecheck_connectors discover <site>` shows which one works.
"""
from __future__ import annotations

import html
import json
import re
from html.parser import HTMLParser
from typing import Any, Optional

from .models import normalise_offer, parse_price


class _PageScanner(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.jsonld: list[str] = []
        self.next_data: Optional[str] = None
        self.meta: dict[str, str] = {}
        self.itemprops: dict[str, str] = {}
        self.title = ""
        self._capture: Optional[str] = None
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "script":
            if a.get("type", "").lower() == "application/ld+json":
                self._capture, self._buf = "jsonld", []
            elif a.get("id") == "__NEXT_DATA__":
                self._capture, self._buf = "next", []
        elif tag == "title":
            self._capture, self._buf = "title", []
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        if "itemprop" in a:
            prop = a["itemprop"].lower()
            val = a.get("content") or a.get("value")
            if val and prop not in self.itemprops:
                self.itemprops[prop] = val

    def handle_data(self, data):
        if self._capture:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if self._capture and tag in ("script", "title"):
            text = "".join(self._buf).strip()
            if self._capture == "jsonld":
                self.jsonld.append(text)
            elif self._capture == "next":
                self.next_data = text
            elif self._capture == "title":
                self.title = html.unescape(text)
            self._capture = None


def scan(page: str) -> _PageScanner:
    s = _PageScanner()
    try:
        s.feed(page)
    except Exception:
        pass
    return s


# ------------------------------------------------------------------ results
class Extracted(dict):
    """name, price, promo_price, barcode, sku, strategy"""


def extract(page: str, strategies: list[str], regex_cfg: Optional[dict] = None) -> Optional[Extracted]:
    scanned = scan(page)
    for s in strategies:
        fn = {"jsonld": _from_jsonld, "meta": _from_meta, "next": _from_next}.get(s)
        if s == "regex":
            got = _from_regex(page, scanned, regex_cfg or {})
        elif fn:
            got = fn(scanned)
        else:
            continue
        if got and got.get("name") and got.get("price"):
            got["strategy"] = s
            return got
    return None


# ------------------------------------------------------------------ JSON-LD
def _iter_nodes(obj: Any):
    if isinstance(obj, list):
        for x in obj:
            yield from _iter_nodes(x)
    elif isinstance(obj, dict):
        yield obj
        for key in ("@graph", "mainEntity", "itemListElement", "item"):
            if key in obj:
                yield from _iter_nodes(obj[key])


def _is_type(node: dict, name: str) -> bool:
    t = node.get("@type")
    return t == name or (isinstance(t, list) and name in t)


def _from_jsonld(s: _PageScanner) -> Optional[Extracted]:
    for raw in s.jsonld:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                data = json.loads(re.sub(r",\s*([}\]])", r"\1", raw))  # trailing commas
            except json.JSONDecodeError:
                continue
        for node in _iter_nodes(data):
            if not _is_type(node, "Product"):
                continue
            offers = node.get("offers")
            offer_list = offers if isinstance(offers, list) else [offers] if offers else []
            current = was = None
            for o in offer_list:
                if not isinstance(o, dict):
                    continue
                current = parse_price(o.get("price") or o.get("lowPrice"))
                spec = o.get("priceSpecification")
                specs = spec if isinstance(spec, list) else [spec] if spec else []
                for ps in specs:
                    if isinstance(ps, dict):
                        p = parse_price(ps.get("price"))
                        kind = str(ps.get("priceType", "")).lower()
                        if p and ("strikethrough" in kind or "listprice" in kind or "regular" in kind):
                            was = p
                        elif p and current is None:
                            current = p
                if current:
                    break
            price, promo = normalise_offer(current, was)
            if price:
                return Extracted(
                    name=_clean(node.get("name")),
                    price=price,
                    promo_price=promo,
                    barcode=_first(node, "gtin13", "gtin", "gtin12", "gtin8", "gtin14"),
                    sku=_first(node, "sku", "productID", "mpn"),
                )
    return None


# --------------------------------------------------------------------- meta
def _from_meta(s: _PageScanner) -> Optional[Extracted]:
    m, ip = s.meta, s.itemprops
    current = parse_price(m.get("product:sale_price:amount") or m.get("product:price:amount")
                          or m.get("og:price:amount") or ip.get("price"))
    sale = parse_price(m.get("product:sale_price:amount"))
    regular = parse_price(m.get("product:price:amount"))
    was = regular if sale and regular and regular > sale else None
    price, promo = normalise_offer(sale or current, was)
    name = m.get("og:title") or ip.get("name") or s.title
    if not price or not name:
        return None
    return Extracted(
        name=_clean(name), price=price, promo_price=promo,
        barcode=ip.get("gtin13") or ip.get("gtin"),
        sku=m.get("product:retailer_item_id") or ip.get("sku"),
    )


# ----------------------------------------------------------------- Next.js
def _from_next(s: _PageScanner) -> Optional[Extracted]:
    if not s.next_data:
        return None
    try:
        data = json.loads(s.next_data)
    except json.JSONDecodeError:
        return None
    best = None
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            name = node.get("name") or node.get("title")
            price = next((node[k] for k in ("price", "salePrice", "sellingPrice", "finalPrice", "currentPrice")
                          if k in node and not isinstance(node[k], (dict, list))), None)
            if isinstance(name, str) and price is not None and parse_price(price):
                was = next((node[k] for k in ("originalPrice", "regularPrice", "oldPrice", "wasPrice", "listPrice")
                            if k in node and not isinstance(node[k], (dict, list))), None)
                p, promo = normalise_offer(parse_price(price), parse_price(was))
                best = Extracted(name=_clean(name), price=p, promo_price=promo,
                                 barcode=node.get("barcode") or node.get("ean") or node.get("gtin"),
                                 sku=str(node.get("sku") or node.get("id") or "") or None)
                break
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return best


# -------------------------------------------------------------------- regex
def _from_regex(page: str, s: _PageScanner, cfg: dict) -> Optional[Extracted]:
    """cfg: {"price": pattern, "old_price": pattern, "name": pattern} with one capture group each."""
    def grab(key):
        pat = cfg.get(key)
        if not pat:
            return None
        m = re.search(pat, page, re.S | re.I)
        return html.unescape(m.group(1)).strip() if m else None

    current = parse_price(grab("price"))
    was = parse_price(grab("old_price"))
    price, promo = normalise_offer(current, was)
    name = grab("name") or s.meta.get("og:title") or s.title
    if not price or not name:
        return None
    return Extracted(name=_clean(name), price=price, promo_price=promo, barcode=None, sku=None)


# ------------------------------------------------------------------ helpers
def _first(node: dict, *keys) -> Optional[str]:
    for k in keys:
        v = node.get(k)
        if v not in (None, ""):
            return str(v)
    return None


def _clean(name) -> str:
    text = html.unescape(str(name or "")).strip()
    text = re.sub(r"\s*[|\-–]\s*(Carrefour|Naivas|Quickmart|Chandarana|Foodplus)[^|]*$", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text)
