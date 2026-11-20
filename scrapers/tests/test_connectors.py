"""Run from scrapers/:  python -m unittest discover -s tests -v

Unit tests for each extractor, plus an end-to-end run of the real runner
against a fake supermarket website and a fake ingest-prices API.
"""
from __future__ import annotations

import gzip
import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pricecheck_connectors.api import PriceApi  # noqa: E402
from pricecheck_connectors.extract import extract  # noqa: E402
from pricecheck_connectors.http import PoliteClient  # noqa: E402
from pricecheck_connectors.models import normalise_offer, parse_price  # noqa: E402
from pricecheck_connectors.runner import run_source  # noqa: E402
from pricecheck_connectors.sitemap import collect_urls  # noqa: E402
from pricecheck_connectors.sources import csv_feed  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
ALL = ["jsonld", "meta", "next", "regex"]
CARREFOUR_REGEX = {"price": r'data-testid="price">\s*KES\s*([\d,.]+)', "old_price": r'css-strike">\s*KES\s*([\d,.]+)'}


def page(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


class Money(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_price("KES 4,316.00"), 4316.0)
        self.assertEqual(parse_price("Ksh 1 299"), 1299.0)
        self.assertEqual(parse_price(129.5), 129.5)
        self.assertEqual(parse_price("99.5"), 99.5)
        self.assertIsNone(parse_price(""))
        self.assertIsNone(parse_price("free"))
        self.assertIsNone(parse_price(0))

    def test_offer(self):
        self.assertEqual(normalise_offer(299, 335), (335, 299))
        self.assertEqual(normalise_offer(335, None), (335, None))
        self.assertEqual(normalise_offer(335, 300), (335, None))  # 'was' lower than now: not an offer


class Extractors(unittest.TestCase):
    def test_jsonld_graph_with_strikethrough(self):
        got = extract(page("product_jsonld.html"), ALL)
        self.assertEqual(got["strategy"], "jsonld")
        self.assertEqual(got["name"], "Kabras Premium White Sugar 2Kg")
        self.assertEqual((got["price"], got["promo_price"]), (335, 299))
        self.assertEqual(got["barcode"], "6161100110014")

    def test_meta_tags(self):
        got = extract(page("product_meta.html"), ALL)
        self.assertEqual(got["strategy"], "meta")
        self.assertEqual(got["name"], "Fresh Fri Cooking Oil 1L & More")
        self.assertEqual(got["price"], 330)

    def test_next_data(self):
        got = extract(page("product_next.html"), ALL)
        self.assertEqual(got["strategy"], "next")
        self.assertEqual((got["price"], got["promo_price"]), (155, 147))

    def test_regex_carrefour_style(self):
        self.assertIsNone(extract(page("product_regex.html"), ["jsonld", "meta", "next"]))
        got = extract(page("product_regex.html"), ALL, CARREFOUR_REGEX)
        self.assertEqual(got["strategy"], "regex")
        self.assertEqual(got["name"], "Domo Jolie Dutch Oven 28cm")  # store suffix stripped
        self.assertEqual((got["price"], got["promo_price"]), (5755, 4316))

    def test_no_price(self):
        self.assertIsNone(extract(page("product_noprice.html"), ALL, CARREFOUR_REGEX))


class Csv(unittest.TestCase):
    def test_chain_feed_mapping(self):
        cfg = {"retailer": "naivas", "source": "feed", "url": str(FIX / "chain_feed.csv"), "id_prefix": "naivas-feed:",
               "columns": {"external_id": "Item Code", "name": "Description", "price": "Retail Price",
                           "promo_price": "Promo Price", "barcode": "Barcode"}}
        res = csv_feed.run("naivas_feed", cfg, PoliteClient(delay_seconds=0))["naivas"]
        self.assertEqual([(i.external_id, i.price, i.promo_price) for i in res.items],
                         [("naivas-feed:A1", 155, None), ("naivas-feed:A2", 335, 299)])
        self.assertEqual(res.pages_failed, 1)  # the broken row is reported, not sent

    def test_manual_template_links_products(self):
        tmp = FIX / "_manual.csv"
        tmp.write_text("retailer,product_id,product,price,promo_price\n"
                       "naivas,5,Kabras Sugar 2kg,335,299\ncarrefour,5,Kabras Sugar 2kg,330,\n"
                       "quickmart,5,Kabras Sugar 2kg,,\n", encoding="utf-8")
        try:
            cfg = {"source": "manual", "url": str(tmp), "id_prefix": "manual:",
                   "columns": {"name": "product"}}
            out = csv_feed.run("manual_checks", cfg, PoliteClient(delay_seconds=0))
            self.assertEqual(sorted(out), ["carrefour", "naivas", "quickmart"])
            n = out["naivas"].items[0]
            self.assertEqual((n.external_id, n.product_id, n.price, n.promo_price), ("manual:pid5", 5, 335, 299))
            self.assertEqual(out["quickmart"].items, [])  # blank price = not checked yet
        finally:
            tmp.unlink()


# ------------------------------------------------------------ fake servers
class FakeSite(BaseHTTPRequestHandler):
    host = ""
    pages = {
        "/mafken/en/sugar/kabras-sugar-2kg/p/101": "product_jsonld.html",
        "/mafken/en/cooking-oil/fresh-fri-1l/p/102": "product_meta.html",
        "/mafken/en/maize-flour/jogoo-2kg/p/103": "product_next.html",
        "/mafken/en/casserole/domo-dutch-oven/p/104": "product_regex.html",
        "/private/en/sugar/secret/p/106": "product_jsonld.html",
    }
    hits: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        FakeSite.hits.append(self.path)
        p = self.path.split("?")[0]
        if p == "/robots.txt":
            return self._send(page("robots.txt").replace("HOST", self.host), "text/plain")
        if p == "/sitemap.xml":
            return self._send(page("sitemap.xml").replace("HOST", self.host), "application/xml")
        if p == "/sitemaps/products0_en.xml.gz":
            return self._send(gzip.compress(page("products0_en.xml").replace("HOST", self.host).encode()),
                              "application/x-gzip", raw=True)
        if p == "/sitemaps/helpcenter_en.xml":
            return self._send(page("helpcenter_en.xml").replace("HOST", self.host), "application/xml")
        if p in self.pages:
            return self._send(page(self.pages[p]), "text/html")
        self.send_response(404)
        self.end_headers()

    def _send(self, body, ctype, raw=False):
        data = body if raw else body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class FakeApi(BaseHTTPRequestHandler):
    sent: list[dict] = []
    reports: list[dict] = []
    known: list[dict] = []

    def log_message(self, *a):
        pass

    def _json(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        assert self.headers["x-api-key"] == "test-key"
        self._json({"listings": FakeApi.known})

    def do_POST(self):
        assert self.headers["x-api-key"] == "test-key"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "run_report" in body:
            FakeApi.reports.append(body["run_report"])
            r = body["run_report"]
            healthy = r["status"] == "ok" and r["items"] > 0
            return self._json({"healthy": healthy, "reason": None if healthy else "returned no products"})
        FakeApi.sent.append(body)
        held = sum(1 for i in body["items"] if i["price"] > 5000)  # pretend big ones were held
        self._json({"listings": len(body["items"]), "prices": len(body["items"]), "held": held, "matches_proposed": 0})


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site, cls.site_url = serve(FakeSite)
        FakeSite.host = cls.site_url.replace("http://", "")
        cls.api_srv, cls.api_url = serve(FakeApi)

    @classmethod
    def tearDownClass(cls):
        cls.site.shutdown()
        cls.api_srv.shutdown()

    def cfg(self, **over):
        c = {"type": "site_pages", "retailer": "carrefour", "source": "online", "id_prefix": "carrefour.ke:",
             "sitemaps": [f"{self.site_url}/sitemap.xml"], "sitemap_include": [r"/sitemaps/products\d+_en"],
             "url_include": [], "id_from_url": r"/p/([^/?#]+)", "extract": ALL, "regex": CARREFOUR_REGEX,
             "delay_seconds": 0}
        c.update(over)
        return c

    def setUp(self):
        FakeApi.sent.clear()
        FakeApi.reports.clear()
        FakeApi.known = []
        FakeSite.hits.clear()

    def test_sitemap_index_gzip_filters_and_robots(self):
        urls = collect_urls(PoliteClient(delay_seconds=0), [f"{self.site_url}/sitemap.xml"],
                            [r"/sitemaps/products\d+_en"], [r"/mafken/"])
        self.assertEqual(len(urls), 5)  # helpcenter sitemap skipped, /private/ excluded by url_include
        self.assertNotIn("/sitemaps/helpcenter_en.xml", FakeSite.hits)

    def test_discover_run_sends_items_and_reports_health(self):
        api = PriceApi(self.api_url, "test-key")
        with redirect_stdout(io.StringIO()) as out:
            ok = run_source("carrefour_site", self.cfg(), mode="discover", api=api)
        self.assertTrue(ok, out.getvalue())
        items = {i["external_id"]: i for i in FakeApi.sent[0]["items"]}
        self.assertEqual(sorted(items), ["carrefour.ke:101", "carrefour.ke:102", "carrefour.ke:103", "carrefour.ke:104"])
        self.assertEqual((items["carrefour.ke:101"]["price"], items["carrefour.ke:101"]["promo_price"]), (335, 299))
        self.assertEqual(items["carrefour.ke:101"]["barcode"], "6161100110014")
        self.assertEqual((items["carrefour.ke:104"]["price"], items["carrefour.ke:104"]["promo_price"]), (5755, 4316))
        self.assertNotIn("/private/en/sugar/secret/p/106", FakeSite.hits)  # robots.txt respected
        self.assertEqual(FakeApi.reports[0]["connector"], "carrefour_site")
        self.assertEqual(FakeApi.reports[0]["items"], 4)
        self.assertEqual(FakeApi.reports[0]["held"], 1)
        self.assertIn("held 1 price", out.getvalue())

    def test_refresh_only_rereads_known_pages(self):
        FakeApi.known = [{"external_id": "carrefour.ke:103", "matched": True,
                          "url": f"{self.site_url}/mafken/en/maize-flour/jogoo-2kg/p/103"}]
        with redirect_stdout(io.StringIO()):
            run_source("carrefour_site", self.cfg(), mode="refresh", api=PriceApi(self.api_url, "test-key"))
        self.assertEqual([i["external_id"] for i in FakeApi.sent[0]["items"]], ["carrefour.ke:103"])
        self.assertFalse(any("sitemap" in h for h in FakeSite.hits))  # no sitemap crawl on refresh

    def test_broken_site_is_reported_unhealthy(self):
        cfg = self.cfg(sitemaps=[f"{self.site_url}/missing-sitemap.xml"])
        with redirect_stdout(io.StringIO()) as out:
            ok = run_source("carrefour_site", cfg, mode="discover", api=PriceApi(self.api_url, "test-key"))
        self.assertFalse(ok)
        self.assertEqual(FakeApi.reports[0]["status"], "failed")
        self.assertIn("ALERT", out.getvalue())

    def test_dry_run_sends_nothing(self):
        with redirect_stdout(io.StringIO()) as out:
            run_source("carrefour_site", self.cfg(), mode="discover", dry_run=True, limit=4)
        self.assertEqual(FakeApi.sent, [])
        self.assertIn("Kabras Premium White Sugar 2Kg", out.getvalue())


if __name__ == "__main__":
    unittest.main()
