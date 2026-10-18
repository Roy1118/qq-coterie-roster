"""本地 HTTP 服务与 JSON API。"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import analytics, export
from .auth import start_qr_login
from .client import QunApiError
from .db import Database
from .sync import SessionMissing, SyncManager, verify_and_save_cookie

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 20 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class QrStore:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._lock = threading.Lock()
        self._items: dict[str, Any] = {}

    def start(self) -> dict[str, Any]:
        item = start_qr_login()
        with self._lock:
            now = time.time()
            for key in [k for k, v in self._items.items() if now - v.created > 200]:
                self._items.pop(key, None)
            self._items[item.id] = item
        image = base64.b64encode(item.image).decode("ascii")
        return {"id": item.id, "image": f"data:image/png;base64,{image}", "expires_in": 180}

    def poll(self, login_id: str) -> dict[str, Any]:
        with self._lock:
            item = self._items.get(login_id)
        if item is None:
            return {"status": "expired", "hint": "二维码不存在，请刷新"}
        try:
            result = item.poll()
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "hint": f"扫码状态查询失败：{exc}"}
        if result.get("status") == "ok":
            cookie = item.session.cookie_header()
            uin = str(result.get("uin") or item.session.uin or "")
            if cookie:
                self.db.set_meta("session_cookie", cookie)
            if uin:
                self.db.set_meta("account_uin", uin)
            with self._lock:
                self._items.pop(login_id, None)
            result["logged_in"] = True
            result["uin"] = uin
        return result


class App:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.sync = SyncManager(db)
        self.qr = QrStore(db)

    def session_info(self) -> dict[str, Any]:
        cookie = self.db.get_meta("session_cookie") or ""
        with self.db.session() as conn:
            last_sync = conn.execute("SELECT MAX(synced_at) v FROM groups").fetchone()["v"]
        return {
            "logged_in": bool(cookie) and ("skey=" in cookie or "p_skey=" in cookie),
            "has_cookie": bool(cookie),
            "uin": self.db.get_meta("account_uin") or "",
            "last_sync": last_sync,
            "counts": self.db.counts(),
            "syncing": self.sync.running(),
        }


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "QQGroupRoster/1.0"

    # ------------------------------------------------------------- helpers
    def log_message(self, fmt: str, *args: Any) -> None:
        if self.path.startswith("/api/"):
            sys.stderr.write("[api] %s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, download_name: str | None = None) -> None:
        if not path.is_file():
            raise ApiError(404, "文件不存在")
        body = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if ctype.startswith("text/html"):
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
            )
        if download_name:
            self.send_header(
                "Content-Disposition",
                f"attachment; filename*=UTF-8''{quote(download_name, safe='')}",
            )
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "请求体过大")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        ctype = (self.headers.get("Content-Type") or "").lower()
        if "application/json" not in ctype:
            raise ApiError(415, "请求必须使用 application/json")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"JSON 解析失败：{exc}") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是 JSON 对象")
        return data

    def _check_origin(self) -> None:
        origin = self.headers.get("Origin")
        if not origin:
            return
        parsed = urlsplit(origin)
        host = (parsed.hostname or "").lower()
        request_host = (urlsplit("//" + (self.headers.get("Host") or "")).hostname or "").lower()
        allowed = {"127.0.0.1", "localhost", "::1", request_host}
        if parsed.scheme not in {"http", "https"} or not host or host not in allowed:
            raise ApiError(403, "拒绝跨站请求")

    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlsplit(self.path).query)

    @staticmethod
    def _one(qs: dict[str, list[str]], key: str, default: str = "") -> str:
        values = qs.get(key)
        return values[0] if values else default

    @staticmethod
    def _int(qs: dict[str, list[str]], key: str, default: int, lo: int = 1, hi: int = 100000) -> int:
        try:
            value = int(qs.get(key, [str(default)])[0])
        except (TypeError, ValueError):
            value = default
        return max(lo, min(hi, value))

    @staticmethod
    def _group_ids(raw: str) -> list[str]:
        return [x.strip() for x in raw.replace(" ", ",").split(",") if x.strip()]

    # --------------------------------------------------------------- routes
    def do_GET(self) -> None:  # noqa: N802
        try:
            self._check_origin()
            self._route_get()
        except ApiError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": f"服务器错误：{exc}"}, 500)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._check_origin()
            self._route_post()
        except ApiError as exc:
            self._json({"error": str(exc)}, exc.status)
        except (SessionMissing, QunApiError) as exc:
            self._json({"error": str(exc)}, 400)
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": f"服务器错误：{exc}"}, 500)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._check_origin()
            path = urlsplit(self.path).path
            if path.startswith("/api/groups/"):
                gc = unquote(path.rsplit("/", 1)[-1])
                ok = self.app.db.delete_group(gc)
                if not ok:
                    raise ApiError(404, "群不存在")
                self._json({"ok": True})
            else:
                raise ApiError(404, "接口不存在")
        except ApiError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": f"服务器错误：{exc}"}, 500)

    def _route_get(self) -> None:
        path = urlsplit(self.path).path
        qs = self._query()

        if path == "/api/health":
            self._json({"ok": True, "version": "1.0.0"})
            return
        if path == "/api/session":
            self._json(self.app.session_info())
            return
        if path == "/api/groups":
            self._json({"groups": analytics.groups_with_stats(self.app.db)})
            return
        if path.startswith("/api/groups/"):
            gc = unquote(path.rsplit("/", 1)[-1])
            detail = analytics.group_detail(self.app.db, gc)
            if not detail:
                raise ApiError(404, "群不存在或尚未同步")
            self._json(detail)
            return
        if path == "/api/stats":
            self._json(analytics.overview(self.app.db))
            return
        if path == "/api/overlap":
            groups = self._group_ids(self._one(qs, "groups"))
            if not groups:
                raise ApiError(400, "请至少选择一个群")
            self._json(analytics.overlap(self.app.db, groups))
            return
        if path == "/api/matrix":
            groups = self._group_ids(self._one(qs, "groups"))
            limit = self._int(qs, "limit", 40, 2, 80)
            self._json(analytics.matrix(self.app.db, groups or None, limit))
            return
        if path == "/api/members":
            self._json(
                {
                    "members": analytics.member_search(
                        self.app.db,
                        self._one(qs, "q"),
                        self._int(qs, "limit", 200, 1, 2000),
                    )
                }
            )
            return
        if path.startswith("/api/members/"):
            uin = unquote(path.rsplit("/", 1)[-1])
            profile = analytics.member_profile(self.app.db, uin)
            if not profile:
                raise ApiError(404, "没有这个群友")
            self._json(profile)
            return
        if path == "/api/multi-group":
            self._json(
                {
                    "members": analytics.multi_group(
                        self.app.db,
                        self._int(qs, "min", 2, 2, 100),
                        self._int(qs, "limit", 300, 1, 3000),
                    )
                }
            )
            return
        if path == "/api/activity":
            mode = self._one(qs, "mode", "active")
            if mode not in {"active", "lurker", "new"}:
                raise ApiError(400, "mode 必须是 active / lurker / new")
            self._json(
                analytics.activity(
                    self.app.db,
                    mode=mode,
                    days=self._int(qs, "days", 30, 1, 3650),
                    gc=self._one(qs, "gc") or None,
                    limit=self._int(qs, "limit", 300, 1, 5000),
                )
            )
            return
        if path == "/api/network":
            self._json(
                analytics.network(
                    self.app.db,
                    self._int(qs, "min_shared", 1, 1, 10000),
                    self._int(qs, "max_nodes", 40, 2, 80),
                )
            )
            return
        if path == "/api/sync":
            self._json(self.app.sync.snapshot())
            return
        if path == "/api/export":
            self._export(qs)
            return

        # 静态文件
        if path in {"/", "/index.html"}:
            self._file(STATIC_DIR / "index.html")
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path.startswith("/static/"):
            rel = unquote(path[len("/static/") :])
            target = (STATIC_DIR / rel).resolve()
            try:
                target.relative_to(STATIC_DIR.resolve())
            except ValueError as exc:
                raise ApiError(403, "非法路径") from exc
            self._file(target)
            return
        raise ApiError(404, "页面不存在")

    def _export(self, qs: dict[str, list[str]]) -> None:
        kind = self._one(qs, "kind", "members")
        if kind == "groups":
            name, body = export.groups_csv(self.app.db)
        elif kind == "members":
            name, body = export.members_csv(self.app.db, self._one(qs, "gc") or None)
        elif kind == "overlap":
            groups = self._group_ids(self._one(qs, "groups"))
            if not groups:
                raise ApiError(400, "导出重合名单需要先选择群")
            name, body = export.overlap_csv(self.app.db, groups)
        elif kind == "activity":
            mode = self._one(qs, "mode", "active")
            name, body = export.activity_csv(
                self.app.db,
                mode=mode,
                days=self._int(qs, "days", 30, 1, 3650),
                gc=self._one(qs, "gc") or None,
            )
        elif kind == "json":
            name, body = export.dump_json(self.app.db)
        else:
            raise ApiError(400, "未知导出类型")

        self.send_response(200)
        ctype = "application/json" if kind == "json" else "text/csv; charset=utf-8"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Content-Disposition", f"attachment; filename*=UTF-8''{quote(name, safe='')}"
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _route_post(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/auth/qr":
            self._json(self.app.qr.start())
            return
        if path == "/api/auth/qr/poll":
            body = self._read_json()
            login_id = str(body.get("id") or "")
            if not login_id:
                raise ApiError(400, "缺少二维码 id")
            self._json(self.app.qr.poll(login_id))
            return
        if path == "/api/auth/cookie":
            body = self._read_json()
            cookie = str(body.get("cookie") or "").strip()
            if not cookie:
                raise ApiError(400, "Cookie 不能为空")
            result = verify_and_save_cookie(self.app.db, cookie)
            self._json({"ok": True, **result})
            return
        if path == "/api/auth/logout":
            self.app.db.delete_meta("session_cookie")
            self.app.db.delete_meta("account_uin")
            self._json({"ok": True})
            return
        if path == "/api/sync":
            body = self._read_json()
            mode = str(body.get("mode") or "full")
            groups = body.get("groups") or []
            if not isinstance(groups, list):
                raise ApiError(400, "groups 必须是数组")
            self.app.sync.start(mode, [str(g) for g in groups])
            self._json(self.app.sync.snapshot())
            return
        if path == "/api/sync/stop":
            self.app.sync.stop()
            self._json(self.app.sync.snapshot())
            return
        if path == "/api/import":
            body = self._read_json()
            payload = body.get("data") if isinstance(body.get("data"), dict) else body
            result = self.app.db.import_dump(payload)
            self._json({"ok": True, **result})
            return
        if path == "/api/data/clear":
            body = self._read_json()
            if str(body.get("confirm") or "") != "DELETE":
                raise ApiError(400, '请输入 DELETE 确认清空')
            self.app.db.clear_data(include_session=False)
            self._json({"ok": True})
            return
        if path.startswith("/api/groups/") and path.endswith("/sync"):
            gc = unquote(path[len("/api/groups/") : -len("/sync")].strip("/"))
            if not self.app.db.get_group(gc):
                raise ApiError(404, "群不存在")
            self.app.sync.start("members", [gc])
            self._json(self.app.sync.snapshot())
            return
        raise ApiError(404, "接口不存在")


def build_server(host: str, port: int, db_path: str | Path) -> ThreadingHTTPServer:
    app = App(Database(db_path))
    handler = type("AppHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="小团体花名册")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=8765, help="端口，默认 8765")
    parser.add_argument("--data", default=str(Path("data") / "roster.db"), help="数据库路径")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args(argv)

    server = build_server(args.host, args.port, args.data)
    url = f"http://{args.host}:{args.port}/"
    print("=" * 58)
    print("  小团体花名册")
    print(f"  本地地址: {url}")
    print(f"  数据文件: {Path(args.data).resolve()}")
    print("  所有数据仅保存在本机，Ctrl+C 退出")
    print("=" * 58)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print("  警告：当前监听非本机地址，局域网内其他设备也可能访问你的群数据。")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
