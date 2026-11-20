"""PriceCheck connectors.

  python -m pricecheck_connectors list
  python -m pricecheck_connectors discover https://naivas.online
  python -m pricecheck_connectors run carrefour_site --dry-run --limit 5
  python -m pricecheck_connectors run carrefour_site               # daily refresh
  python -m pricecheck_connectors run carrefour_site --mode discover
  python -m pricecheck_connectors run --all [--mode refresh|discover]

Run from the scrapers/ folder. Live runs need PRICE_API_URL and PRICE_API_KEY.
Exit code 0 = all healthy, 2 = something needs attention (GitHub then emails you).
"""
from __future__ import annotations

import argparse
import sys

from .discover import discover
from .runner import load_config, run_source


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pricecheck_connectors", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="show configured sources")
    d = sub.add_parser("discover", help="investigate a store website and suggest a config")
    d.add_argument("site")
    d.add_argument("--samples", type=int, default=4)
    r = sub.add_parser("run", help="run one source, or all enabled sources")
    r.add_argument("source", nargs="?")
    r.add_argument("--all", action="store_true", help="every enabled source")
    r.add_argument("--mode", choices=["refresh", "discover"], default="refresh")
    r.add_argument("--dry-run", action="store_true", help="print what would be sent; send nothing")
    r.add_argument("--limit", type=int)
    args = ap.parse_args(argv)

    if args.cmd == "discover":
        discover(args.site, args.samples)
        return 0

    cfg = load_config()
    if args.cmd == "list":
        for name, c in cfg.items():
            state = "on " if c.get("enabled") else "off"
            print(f"  [{state}] {name:<20} {c['type']:<13} {c.get('retailer', '(per row)'):<11} {c.get('source', '')}")
        return 0

    if args.all:
        names = [n for n, c in cfg.items() if c.get("enabled")]
        if args.mode == "discover":
            names = [n for n in names if cfg[n]["type"] == "site_pages"]
    elif args.source:
        if args.source not in cfg:
            print(f"Unknown source {args.source}. Try: list")
            return 1
        names = [args.source]
    else:
        print("Give a source name or --all")
        return 1

    healthy = True
    for name in names:
        healthy &= run_source(name, cfg[name], args.mode, args.dry_run, args.limit)
    return 0 if healthy else 2


if __name__ == "__main__":
    sys.exit(main())
