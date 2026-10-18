"""群头像 / 群友头像的本地缓存。

优先从腾讯 qlogo CDN 抓取并缓存到 data/avatars，失败时生成 SVG 占位图。
这样前端只需要访问本地 /api/avatar/...，断网后也能看到已缓存头像。
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

GROUP_URLS = (
    "https://p.qlogo.cn/gh/{id}/{id}/100",
    "https://p.qlogo.cn/gh/{id}/{id}/0",
)
USER_URLS = (
    "https://q1.qlogo.cn/g?b=qq&nk={id}&s=100",
    "https://q.qlogo.cn/g?b=qq&nk={id}&s=100",
)


def sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    head = data[:400].lstrip().lower()
    if head.startswith(b"<svg") or b"<svg" in head:
        return "image/svg+xml"
    return None


def fallback_svg(text: str, seed: str) -> tuple[bytes, str]:
    chars = "".join(list(text or "?")[:2]) or "?"
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    hue = int(digest[:6], 16) % 360
    hue2 = (hue + 38) % 360
    size = 38 if len(chars) <= 1 else 30
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl({hue}, 82%, 64%)"/>
      <stop offset="1" stop-color="hsl({hue2}, 84%, 50%)"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="26" fill="url(#g)"/>
  <circle cx="78" cy="22" r="26" fill="#ffffff" opacity="0.12"/>
  <text x="50" y="60" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif"
        font-size="{size}" font-weight="700" fill="#ffffff">{escape(chars)}</text>
</svg>"""
    return svg.encode("utf-8"), "image/svg+xml"


class AvatarStore:
    def __init__(self, cache_dir: str | Path, db: Any = None) -> None:
        self.cache_dir = Path(cache_dir)
        self.db = db
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, key: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def group(self, gc: str, name: str = "") -> tuple[bytes, str]:
        return self._get("groups", str(gc), name or str(gc), GROUP_URLS)

    def user(self, uin: str, nick: str = "") -> tuple[bytes, str]:
        return self._get("users", str(uin), nick or str(uin), USER_URLS)

    def _get(self, kind: str, ident: str, label: str, urls: tuple[str, ...]) -> tuple[bytes, str]:
        key = f"{kind}:{ident}"
        path = self.cache_dir / kind / f"{ident}.img"
        with self._lock_for(key):
            if path.is_file():
                data = path.read_bytes()
                mime = sniff_mime(data)
                if mime:
                    return data, mime
            for template in urls:
                data = self._fetch(template.format(id=ident))
                if not data:
                    continue
                mime = sniff_mime(data)
                if not mime:
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(data)
                tmp.replace(path)
                return data, mime
        return fallback_svg(label, f"{kind}:{ident}")

    @staticmethod
    def _fetch(url: str) -> bytes | None:
        req = Request(
            url,
            headers={
                "User-Agent": UA,
                "Referer": "https://qun.qq.com/",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
        )
        try:
            with urlopen(req, timeout=8) as resp:
                if getattr(resp, "status", 200) != 200:
                    return None
                data = resp.read(2_000_000)
                if len(data) < 80:
                    return None
                return data
        except (HTTPError, URLError, TimeoutError, OSError):
            return None
