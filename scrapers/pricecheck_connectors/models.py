"""The one format every connector produces, whatever the source."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Item:
    external_id: str              # unique per retailer, namespaced: "carrefour.ke:10009"
    name: str
    price: float                  # regular shelf price, KES
    promo_price: Optional[float] = None   # current price when on offer
    promo_ends_at: Optional[str] = None
    barcode: Optional[str] = None
    url: Optional[str] = None
    product_id: Optional[int] = None      # only manual checks and official feeds may set this

    def to_api(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


@dataclass
class RunResult:
    connector: str
    items: list[Item] = field(default_factory=list)
    pages_fetched: int = 0
    pages_failed: int = 0
    skipped_by_robots: int = 0
    notes: list[str] = field(default_factory=list)


_MONEY = re.compile(r"(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?")


def parse_price(value) -> Optional[float]:
    """'KES 4,316.00' -> 4316.0 ; 129.5 -> 129.5 ; '' -> None"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    m = _MONEY.search(str(value).replace("\xa0", " "))
    if not m:
        return None
    whole = re.sub(r"[,\s]", "", m.group(1))
    cents = m.group(2) or "0"
    price = float(f"{whole}.{cents}")
    return price if price > 0 else None


def normalise_offer(current: Optional[float], was: Optional[float]) -> tuple[Optional[float], Optional[float]]:
    """Return (regular price, promo price) from the price shown and a struck-out 'was' price."""
    if current is None:
        return None, None
    if was is not None and was > current:
        return was, current
    return current, None
