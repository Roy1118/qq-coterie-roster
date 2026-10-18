"""后台同步：拉群列表、逐群拉成员，并记录进度。"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from html import unescape
from typing import Any

from .auth import QunSession
from .client import QunApiError, QunClient
from .db import Database


class SessionMissing(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_client(db: Database) -> QunClient:
    cookie = db.get_meta("session_cookie") or ""
    if "skey=" not in cookie and "p_skey=" not in cookie:
        raise SessionMissing("还没有登录 QQ。请先扫码登录或粘贴 Cookie。")
    session = QunSession()
    session.load_cookie_header(cookie)
    if not session.logged_in():
        raise SessionMissing("QQ 会话缺少 skey，请重新登录。")
    return QunClient(session)


def verify_and_save_cookie(db: Database, cookie: str) -> dict[str, Any]:
    session = QunSession()
    session.load_cookie_header(cookie)
    if not session.logged_in():
        raise ValueError("Cookie 中没有 skey / p_skey，无法登录 qun.qq.com")
    client = QunClient(session)
    data = client.group_list()
    total = sum(len(v or []) for v in data.values())
    uin = session.uin
    db.set_meta("session_cookie", session.cookie_header())
    if uin:
        db.set_meta("account_uin", uin)
    return {"uin": uin, "groups": total}


def collect_groups(db: Database, client: QunClient | None = None) -> list[dict[str, Any]]:
    client = client or load_client(db)
    data = client.group_list()
    by_gc: dict[str, dict[str, Any]] = {}
    for role in ("join", "manage", "create"):
        for g in data.get(role, []) or []:
            gc = str(g.get("gc") or "").strip()
            if not gc:
                continue
            by_gc[gc] = {
                "gc": gc,
                "name": unescape(str(g.get("gn") or "")).replace("\xa0", " ").strip(),
                "role": role,
                "owner": str(g.get("owner") or ""),
                "mem_num": int(g.get("mem_num") or 0),
                "max_num": int(g.get("max_num") or 0),
            }
    rows = list(by_gc.values())
    db.upsert_groups(rows)
    return rows


class SyncManager:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.job: dict[str, Any] = {
            "running": False,
            "mode": None,
            "phase": "idle",
            "current": "",
            "groups_total": 0,
            "groups_done": 0,
            "members_total": 0,
            "members_done": 0,
            "skipped": 0,
            "errors": [],
            "message": "",
            "started_at": None,
            "finished_at": None,
        }

    # ------------------------------------------------------------- public
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            data = dict(self.job)
            data["errors"] = list(self.job.get("errors") or [])
        return data

    def running(self) -> bool:
        with self._lock:
            return bool(self.job.get("running"))

    def start(self, mode: str = "full", groups: list[str] | None = None, delay: float = 0.35) -> None:
        if mode not in {"full", "groups", "members", "pending"}:
            raise ValueError("mode 必须是 full / groups / members / pending")
        with self._lock:
            if self.job.get("running"):
                raise RuntimeError("已有同步任务在进行中")
            self._stop.clear()
            self.job = {
                "running": True,
                "mode": mode,
                "phase": "groups" if mode in {"full", "groups"} else "members",
                "current": "",
                "groups_total": 0,
                "groups_done": 0,
                "members_total": 0,
                "members_done": 0,
                "skipped": 0,
                "errors": [],
                "message": "准备同步…",
                "started_at": _now(),
                "finished_at": None,
            }
            self._thread = threading.Thread(
                target=self._run, args=(mode, list(groups or []), float(delay)), daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            if self.job.get("running"):
                self._stop.set()
                self.job["message"] = "正在停止…"

    # ------------------------------------------------------------ internal
    def _update(self, **kwargs: Any) -> None:
        with self._lock:
            self.job.update(kwargs)

    def _error(self, gc: str, name: str, exc: Exception) -> None:
        with self._lock:
            errors = self.job.setdefault("errors", [])
            if len(errors) < 30:
                errors.append({"gc": gc, "name": name, "error": str(exc)})

    def _run(self, mode: str, selected: list[str], delay: float) -> None:
        try:
            client = load_client(self.db)
            if mode in {"full", "groups"}:
                self._update(phase="groups", current="获取群列表", message="正在获取群列表…")
                live = collect_groups(self.db, client)
                self._update(
                    groups_total=len(live),
                    members_total=sum(int(g.get("mem_num") or 0) for g in live),
                    message=f"找到 {len(live)} 个群",
                )
                if mode == "groups":
                    self._update(
                        running=False,
                        phase="done",
                        current="",
                        message=f"群列表已更新，共 {len(live)} 个群",
                        finished_at=_now(),
                    )
                    return
                ids = [g["gc"] for g in live]
                names = {g["gc"]: g.get("name") or g["gc"] for g in live}
                roles = {g["gc"]: g.get("role") or "join" for g in live}
            else:
                if mode == "pending":
                    ids = [g["gc"] for g in self.db.list_groups() if not g.get("synced_at")]
                    if not ids:
                        self._update(
                            running=False,
                            phase="done",
                            current="",
                            message="没有待同步的群",
                            finished_at=_now(),
                        )
                        return
                else:
                    ids = selected or [g["gc"] for g in self.db.list_groups()]
                db_groups = {g["gc"]: g for g in self.db.list_groups()}
                names = {gc: (db_groups.get(gc) or {}).get("name") or gc for gc in ids}
                roles = {gc: (db_groups.get(gc) or {}).get("role") or "join" for gc in ids}
                self._update(
                    phase="members",
                    groups_total=len(ids),
                    members_total=sum(int((db_groups.get(gc) or {}).get("mem_num") or 0) for gc in ids),
                    message=f"准备同步 {len(ids)} 个群",
                )

            for index, gc in enumerate(ids, start=1):
                if self._stop.is_set():
                    self._update(
                        running=False,
                        phase="stopped",
                        current="",
                        message=f"已停止（完成 {self.job.get('groups_done', 0)}/{len(ids)} 个群）",
                        finished_at=_now(),
                    )
                    return
                name = names.get(gc) or gc
                self._update(current=name, message=f"正在同步 {name}（{index}/{len(ids)}）")
                try:
                    result = client.fetch_members(gc, group_name=name)
                    fetched = result.get("members") or []
                    if not fetched and int(result.get("mem_num") or 0) > 0:
                        raise QunApiError("接口返回 0 个成员，已跳过以避免清空本地数据", result)
                    count = self.db.replace_members(gc, fetched)
                    self.db.upsert_groups(
                        [
                            {
                                "gc": gc,
                                "name": result.get("group_name") or name,
                                "role": roles.get(gc) or "join",
                                "owner": result.get("owner") or "",
                                "mem_num": count,
                                "max_num": int(result.get("max_num") or 0),
                            }
                        ]
                    )
                    with self._lock:
                        self.job["groups_done"] = index
                        self.job["members_done"] = int(self.job.get("members_done") or 0) + count
                        if self.job["members_done"] > int(self.job.get("members_total") or 0):
                            self.job["members_total"] = self.job["members_done"]
                except QunApiError as exc:
                    payload = exc.payload if isinstance(exc.payload, dict) else {}
                    if payload.get("ec") == 7:
                        with self._lock:
                            self.job["groups_done"] = index
                            self.job["skipped"] = int(self.job.get("skipped") or 0) + 1
                        self._error(gc, name, exc)
                    elif payload.get("ec") == 4:
                        raise
                    else:
                        with self._lock:
                            self.job["groups_done"] = index
                        self._error(gc, name, exc)
                except Exception as exc:  # noqa: BLE001
                    with self._lock:
                        self.job["groups_done"] = index
                    self._error(gc, name, exc)
                time.sleep(delay)

            self._update(
                running=False,
                phase="done",
                current="",
                message=(
                    f"同步完成：{self.job.get('groups_done', 0)} 个群，"
                    f"{self.job.get('members_done', 0)} 人次"
                ),
                finished_at=_now(),
            )
        except SessionMissing as exc:
            self._update(
                running=False,
                phase="error",
                current="",
                message=str(exc),
                finished_at=_now(),
            )
        except QunApiError as exc:
            self._update(
                running=False,
                phase="error",
                current="",
                message=str(exc),
                finished_at=_now(),
            )
        except Exception as exc:  # noqa: BLE001
            self._update(
                running=False,
                phase="error",
                current="",
                message=f"同步失败：{exc}",
                finished_at=_now(),
            )
