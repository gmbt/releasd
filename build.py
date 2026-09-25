#!/usr/bin/env python3
"""Prebuild Bandcamp data for the releasd page -> site/data/bandcamp.json.

Rinse FM is queried live by the page (its GraphQL API allows CORS).
Bandcamp does not allow CORS, so its data is fetched here (GitHub Action, every 3h)
via the JSON endpoints the Bandcamp mobile app uses (unofficial, no auth).
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
DATA = SITE / "data"
CACHE = ROOT / "cache" / "tralbums.json"   # per-release details; persisted between runs via actions/cache
BC = "https://bandcamp.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
DATE_FMT = "%d %b %Y %H:%M:%S GMT"

# Bandcamp rate-limits per IP with a burst bucket (~150+ quick calls -> HTTP 429 for ~1 min,
# retry-after: 3). Requests are sequential with a delay that grows on 429 and shrinks on success.
DELAY = float(os.environ.get("BC_DELAY", "0.7"))
MIN_DELAY, MAX_DELAY = DELAY, 8.0
_delay = DELAY
_lock = threading.Lock()
_stats = {"requests": 0, "retries": 0}


def http(url: str, payload: dict | None = None, tries: int = 8) -> str:
    """Single-file sequential HTTP with adaptive throttling (honours Retry-After on 429)."""
    global _delay
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"User-Agent": UA}
    if data:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers)
    for i in range(tries):
        with _lock:
            time.sleep(_delay)
            _stats["requests"] += 1
            try:
                with request.urlopen(req, timeout=30) as r:
                    body = r.read().decode("utf-8", "replace")
                _delay = max(MIN_DELAY, _delay * 0.9)
                return body
            except error.HTTPError as e:
                if e.code == 429 and i < tries - 1:
                    _stats["retries"] += 1
                    wait = max(float(e.headers.get("Retry-After") or 0), 5.0) * (i + 1)
                    _delay = min(MAX_DELAY, _delay * 1.5)
                    time.sleep(wait)
                    continue
                if e.code >= 500 and i < tries - 1:
                    time.sleep(2.0 * (i + 1))
                    continue
                raise
            except (error.URLError, TimeoutError):
                if i == tries - 1:
                    raise
                time.sleep(2.0 * (i + 1))
    raise RuntimeError("unreachable")


def api(path: str, payload: dict) -> dict:
    return json.loads(http(f"{BC}/api/{path}", payload))


def data_attr(page: str, name: str) -> dict | None:
    m = re.search(rf'data-{name}="([^"]*)"', page)
    return json.loads(html.unescape(m.group(1))) if m else None


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, DATE_FMT).replace(tzinfo=timezone.utc)


def fan_id(username: str) -> int:
    blob = data_attr(http(f"{BC}/{username}"), "blob")
    if not blob or "fan_data" not in blob:
        raise RuntimeError("no fan data on profile page (private profile or wrong username?)")
    return int(blob["fan_data"]["fan_id"])


def following(fid: int) -> list[dict]:
    token, out = "9999999999:9999999999", []
    while True:
        r = api("fancollection/1/following_bands",
                {"fan_id": fid, "older_than_token": token, "count": 500})
        out += r.get("followeers") or []
        if not r.get("more_available") or not r.get("last_token"):
            return out
        token = r["last_token"]


def band_from_follow(f: dict) -> dict:
    hints = f.get("url_hints") or {}
    sub, custom = hints.get("subdomain"), hints.get("custom_domain")
    url = f"https://{custom}" if custom else f"https://{sub}.bandcamp.com"
    return {"band_id": f["band_id"], "name": f["name"], "url": url,
            "subdomain": sub, "source": "follow"}


def band_from_url(url: str) -> dict:
    b = data_attr(http(url.rstrip("/")), "band")
    if not b:
        raise RuntimeError("no band data on page")
    return {"band_id": b["id"], "name": b["name"], "url": b.get("url") or url,
            "subdomain": b.get("subdomain"), "source": "config"}


def band_releases(band: dict, since: datetime, now: datetime) -> list[dict]:
    d = api("mobile/24/band_details", {"band_id": band["band_id"]})
    out = []
    for it in d.get("discography") or []:
        rd = it.get("release_date")
        if not rd:
            continue
        dt = parse_date(rd)
        if dt < since:
            continue
        art = it.get("art_id")
        out.append({
            "id": f"{it['item_type']}:{it['item_id']}",
            "item_id": it["item_id"],
            "item_type": it["item_type"],
            "title": it.get("title"),
            "artist": it.get("artist_name") or it.get("band_name"),
            "band_id": it.get("band_id"),
            "via": [{"name": band["name"], "url": band["url"], "subdomain": band.get("subdomain")}],
            "art": f"https://f4.bcbits.com/img/a{art}_7.jpg" if art else None,
            "release_date": dt.isoformat(),
            "preorder": dt > now,
        })
    return out


def enrich(rel: dict) -> dict:
    t = api("mobile/24/tralbum_details",
            {"band_id": rel["band_id"], "tralbum_id": rel["item_id"],
             "tralbum_type": rel["item_type"][0]})
    tracks = t.get("tracks") or []
    rel["url"] = t.get("bandcamp_url")
    rel["label"] = t.get("label")
    rel["tracks"] = len(tracks)
    rel["duration"] = round(sum(x.get("duration") or 0 for x in tracks))
    return rel


def main() -> int:
    cfg = json.loads((ROOT / "config.json").read_text())
    bc = cfg.get("bandcamp") or {}
    days = int(cfg.get("days_back", 30))
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    errors: list[str] = []
    bands: dict[int, dict] = {}

    if bc.get("fan"):
        try:
            for f in following(fan_id(bc["fan"])):
                b = band_from_follow(f)
                bands[b["band_id"]] = b
        except Exception as e:  # noqa: BLE001
            errors.append(f"fan {bc['fan']}: {e}")
    for url in bc.get("labels") or []:
        try:
            b = band_from_url(url)
            bands[b["band_id"]] = b
        except Exception as e:  # noqa: BLE001
            errors.append(f"label {url}: {e}")

    excl = {str(x).rstrip("/") for x in bc.get("exclude") or []}
    bands = {k: v for k, v in bands.items()
             if not ({str(k), v.get("subdomain") or "", v["url"]} & excl)}

    releases: dict[str, dict] = {}
    for b in bands.values():
        try:
            for r in band_releases(b, since, now):
                if r["id"] in releases:  # followed both artist and label
                    releases[r["id"]]["via"] += r["via"]
                else:
                    releases[r["id"]] = r
        except Exception as e:  # noqa: BLE001
            errors.append(f"band {b['name']}: {e}")

    # per-release details rarely change -> cache them between runs
    cache: dict[str, dict] = {}
    if CACHE.exists():
        try:
            cache = json.loads(CACHE.read_text())
        except json.JSONDecodeError:
            cache = {}
    fetched = 0
    for r in releases.values():
        c = cache.get(r["id"])
        if c and c.get("url"):
            r.update(c)
            continue
        try:
            enrich(r)
            cache[r["id"]] = {k: r[k] for k in ("url", "label", "tracks", "duration")}
            fetched += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"tralbum {r['title']}: {e}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    keep = {r["id"] for r in releases.values()}
    CACHE.write_text(json.dumps({k: v for k, v in cache.items() if k in keep}, ensure_ascii=False))

    out_releases = sorted(releases.values(), key=lambda r: r["release_date"], reverse=True)
    DATA.mkdir(parents=True, exist_ok=True)
    out = {
        "generated_at": now.isoformat(timespec="seconds"),
        "days_back": days,
        "fan": bc.get("fan"),
        "bands": sorted(bands.values(), key=lambda b: b["name"].lower()),
        "releases": out_releases,
        "errors": errors,
    }
    (DATA / "bandcamp.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    shutil.copy(ROOT / "config.json", SITE / "config.json")
    print(f"{len(bands)} bands, {len(out_releases)} releases in last {days}d, {fetched} details fetched, "
          f"{_stats['requests']} requests, {_stats['retries']} retries after 429, {len(errors)} errors")
    for e in errors:
        print("  !", e, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
