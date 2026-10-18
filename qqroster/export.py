"""CSV / JSON 导出。"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from . import analytics
from .db import Database


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M")


def _fmt_time(ts: Any) -> str:
    try:
        ts = int(ts or 0)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def _write(rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")

    def safe(value: Any) -> Any:
        # 防止 CSV 公式注入（Excel 会把 = + - @ 开头的单元格当公式执行）
        if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
            return "'" + value
        return value

    writer.writerows([[safe(v) for v in row] for row in rows])
    # Excel 友好：带 UTF-8 BOM
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def groups_csv(db: Database) -> tuple[str, bytes]:
    rows: list[list[Any]] = [
        ["群号", "群名", "我的身份", "群主", "成员数", "活跃(7天)", "活跃(30天)", "30天潜水", "30天新成员", "最后同步"]
    ]
    for g in analytics.groups_with_stats(db):
        rows.append(
            [
                g["gc"],
                g["name"],
                {"create": "群主", "manage": "管理员", "join": "成员"}.get(g["role"], g["role"]),
                g["owner"],
                g["member_count"],
                g["active_7d"],
                g["active_30d"],
                g["inactive_90d"],
                g["new_30d"],
                g["synced_at"] or "",
            ]
        )
    return f"groups-{_stamp()}.csv", _write(rows)


def members_csv(db: Database, gc: str | None = None) -> tuple[str, bytes]:
    rows: list[list[Any]] = [
        [
            "群号",
            "群名",
            "QQ号",
            "昵称",
            "群名片",
            "身份",
            "是否好友",
            "入群时间",
            "最后发言",
            "群等级",
        ]
    ]
    groups = {g["gc"]: g["name"] for g in db.list_groups()}
    with db.session() as conn:
        if gc:
            records = conn.execute(
                "SELECT * FROM members WHERE gc = ? ORDER BY last_speak_time DESC, uin",
                (str(gc),),
            ).fetchall()
        else:
            records = conn.execute(
                "SELECT * FROM members ORDER BY gc, last_speak_time DESC, uin"
            ).fetchall()
    for m in records:
        role = "群主" if m["is_owner"] else ("管理员" if m["is_admin"] else "成员")
        rows.append(
            [
                m["gc"],
                groups.get(m["gc"], ""),
                m["uin"],
                m["nick"],
                m["card"],
                role,
                "是" if m["is_friend"] else "否",
                _fmt_time(m["join_time"]),
                _fmt_time(m["last_speak_time"]),
                m["level"],
            ]
        )
    safe_gc = "".join(ch for ch in gc if ch.isalnum() or ch in "-_")[:40] if gc else ""
    suffix = f"-{safe_gc}" if safe_gc else ""
    return f"members{suffix}-{_stamp()}.csv", _write(rows)


def overlap_csv(db: Database, gcs: list[str]) -> tuple[str, bytes]:
    data = analytics.overlap(db, gcs)
    header = [
        "QQ号",
        "昵称",
        "群名片",
        "所在群数",
        "所在群",
        "最后发言",
        "是否好友",
    ]
    rows: list[list[Any]] = [header]
    for m in data.get("common", []):
        names = " / ".join(g.get("group_name") or g.get("gc") or "" for g in m.get("groups", []))
        rows.append(
            [
                m["uin"],
                m["nick"],
                m["card"],
                m["group_count"],
                names,
                _fmt_time(m["last_speak_time"]),
                "是" if m["is_friend"] else "否",
            ]
        )
    return f"overlap-{_stamp()}.csv", _write(rows)


def activity_csv(db: Database, mode: str, days: int, gc: str | None) -> tuple[str, bytes]:
    data = analytics.activity(db, mode=mode, days=days, gc=gc, limit=100000)
    rows: list[list[Any]] = [["QQ号", "昵称", "群名片", "所在群", "最后发言", "入群时间", "是否好友"]]
    for m in data.get("rows", []):
        names = m.get("group_name") or " / ".join(
            g.get("name") or g.get("gc") or "" for g in m.get("groups", [])
        )
        rows.append(
            [
                m["uin"],
                m.get("nick", ""),
                m.get("card", ""),
                names,
                _fmt_time(m.get("last_speak_time")),
                _fmt_time(m.get("join_time")),
                "是" if m.get("is_friend") else "否",
            ]
        )
    return f"activity-{mode}-{_stamp()}.csv", _write(rows)


def dump_json(db: Database) -> tuple[str, bytes]:
    payload = db.export_dump()
    return (
        f"qq-roster-backup-{_stamp()}.json",
        json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
    )
