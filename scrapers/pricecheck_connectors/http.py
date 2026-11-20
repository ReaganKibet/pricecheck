"""A polite HTTP client: honest user agent, robots.txt, a delay per site,
retries with back-off, and clear errors when a site blocks us."""
from __future__ import annotations

import gzip
import time
import urllib.error
import urllib.request
import urllib.robotparser
from typing import Optional
from urllib.parse import urlsplit

USER_AGENT = "PriceCheckBot/0.2 (Kenyan supermarket price comparison; +https://pricecheck-demo.netlify.app)"
ROBOTS_AGENT = "PriceCheckBot"


class Blocked(Exception):
    """The site refused us (403/429 after retries, or a bot challenge page)."""


class PoliteClient:
    def __init__(self, delay_seconds: float = 3.0, timeout: float = 30.0, retries: int = 3,
                 respect_robots: bool = True):
        self.delay = delay_seconds
        self.timeout = timeout
        self.retries = retries
        self.respect_robots = respect_robots
        self._last_hit: dict[str, float] = {}
        self._robots: dict[str, Optional[urllib.robotparser.RobotFileParser]] = {}

    # ------------------------------------------------------------- robots
    def allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                body = self._raw_get(f"{origin}/robots.txt", check_robots=False)
                rp.parse(body.decode("utf-8", "replace").splitlines())
                self._robots[origin] = rp
            except Exception:
                self._robots[origin] = None  # no robots.txt: everything allowed
        rp = self._robots[origin]
        return True if rp is None else rp.can_fetch(ROBOTS_AGENT, url)

    def robots_sitemaps(self, origin: str) -> list[str]:
        self.allowed(origin + "/")
        rp = self._robots.get(origin)
        return list(rp.site_maps() or []) if rp else []

    # -------------------------------------------------------------- fetch
    def get(self, url: str) -> bytes:
        return self._raw_get(url, check_robots=True)

    def get_text(self, url: str) -> str:
        return self.get(url).decode("utf-8", "replace")

    def _raw_get(self, url: str, check_robots: bool) -> bytes:
        if check_robots and not self.allowed(url):
            raise PermissionError(f"robots.txt disallows {url}")
        host = urlsplit(url).netloc
        last_error: Exception | None = None
        for attempt in range(self.retries):
            wait = self.delay - (time.monotonic() - self._last_hit.get(host, 0))
            if wait > 0:
                time.sleep(wait)
            self._last_hit[host] = time.monotonic()
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Encoding": "gzip",
                "Accept-Language": "en-KE,en;q=0.9",
            })
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    data = res.read()
                    if res.headers.get("Content-Encoding") == "gzip" or url.endswith(".gz"):
                        try:
                            data = gzip.decompress(data)
                        except OSError:
                            pass
                    if _looks_like_challenge(data):
                        raise Blocked(f"bot challenge page at {url}")
                    return data
            except urllib.error.HTTPError as e:
                last_error = e
                if e.code == 404:
                    raise
                if e.code in (403, 429, 503) and attempt == self.retries - 1:
                    raise Blocked(f"HTTP {e.code} from {host}") from e
                if e.code < 500 and e.code not in (403, 429):
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last_error = e
            time.sleep(min(30, self.delay * (2 ** attempt)))
        raise last_error if last_error else RuntimeError(f"could not fetch {url}")


def _looks_like_challenge(data: bytes) -> bool:
    head = data[:4000].lower()
    return (b"cf-chl" in head or b"just a moment..." in head or b"attention required! | cloudflare" in head
            or b"captcha" in head and b"<form" in head)
