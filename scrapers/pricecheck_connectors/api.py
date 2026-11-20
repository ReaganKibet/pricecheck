"""Talks to the ingest-prices edge function."""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

from .models import Item


class PriceApi:
    def __init__(self, base_url: str | None = None, key: str | None = None):
        self.base = (base_url or os.environ.get("PRICE_API_URL", "")).rstrip("/")
        self.key = key or os.environ.get("PRICE_API_KEY", "")
        if not self.base or not self.key:
            raise SystemExit("Set PRICE_API_URL and PRICE_API_KEY (or use --dry-run).")

    def _call(self, method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
        url = f"{self.base}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "content-type": "application/json", "x-api-key": self.key,
        })
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.load(res)

    def known_listings(self, retailer: str, prefix: str) -> list[dict]:
        return self._call("GET", "ingest-prices", query={"retailer": retailer, "prefix": prefix})["listings"]

    def send(self, retailer: str, source: str, items: list[Item], branch_code: str | None = None,
             batch_size: int = 500) -> dict:
        totals = {"listings": 0, "prices": 0, "held": 0, "matches_proposed": 0}
        for i in range(0, len(items), batch_size):
            body = {"retailer": retailer, "source": source, "items": [x.to_api() for x in items[i:i + batch_size]]}
            if branch_code:
                body["branch_code"] = branch_code
            res = self._call("POST", "ingest-prices", body)
            for k in totals:
                totals[k] += int(res.get(k) or 0)
        return totals

    def report_run(self, connector: str, status: str, items: int, held: int = 0, error: str | None = None) -> dict:
        return self._call("POST", "ingest-prices", {"run_report": {
            "connector": connector, "status": status, "items": items, "held": held, "error": error,
        }})
