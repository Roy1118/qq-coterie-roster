"""SQLite 本地存储。

所有数据都保存在本机 data/roster.db，不上传任何服务器。
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    gc         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT 'join',
    owner      TEXT NOT NULL DEFAULT '',
    mem_num    INTEGER NOT NULL DEFAULT 0,
    max_num    INTEGER NOT NULL DEFAULT 0,
    synced_at  TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
    gc              TEXT NOT NULL,
    uin             TEXT NOT NULL,
    nick            TEXT NOT NULL DEFAULT '',
    card            TEXT NOT NULL DEFAULT '',
    join_time       INTEGER NOT NULL DEFAULT 0,
    last_speak_time INTEGER NOT NULL DEFAULT 0,
    last_active_day INTEGER NOT NULL DEFAULT 0,
    level           INTEGER NOT NULL DEFAULT 0,
    is_friend       INTEGER NOT NULL DEFAULT 0,
    is_owner        INTEGER NOT NULL DEFAULT 0,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    synced_at       TEXT NOT NULL,
    PRIMARY KEY (gc, uin),
    FOREIGN KEY (gc) REFERENCES groups(gc) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_members_uin  ON members(uin);
CREATE INDEX IF NOT EXISTS idx_members_last ON members(last_speak_time);
CREATE INDEX IF NOT EXISTS idx_members_join ON members(join_time);
"""


class Database:
    """轻量 SQLite 封装；每次操作使用独立连接，方便后台同步线程并发读写。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        self.init_schema()

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.session() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)

    # ---------------------------------------------------------------- meta
    def get_meta(self, key: str, default: str | None = None) -> str | None:
        with self.session() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        with self._write_lock, self.session() as conn:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def delete_meta(self, key: str) -> None:
        with self._write_lock, self.session() as conn:
            conn.execute("DELETE FROM meta WHERE key = ?", (key,))

    # -------------------------------------------------------------- groups
    def upsert_groups(self, rows: Iterable[dict[str, Any]]) -> int:
        now = now_iso()
        count = 0
        with self._write_lock, self.session() as conn:
            for row in rows:
                gc = str(row.get("gc") or "").strip()
                if not gc:
                    continue
                conn.execute(
                    """
                    INSERT INTO groups(gc, name, role, owner, mem_num, max_num, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(gc) DO UPDATE SET
                        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE groups.name END,
                        role = CASE WHEN excluded.role <> '' THEN excluded.role ELSE groups.role END,
                        owner = CASE WHEN excluded.owner <> '' THEN excluded.owner ELSE groups.owner END,
                        mem_num = CASE WHEN excluded.mem_num > 0 THEN excluded.mem_num ELSE groups.mem_num END,
                        max_num = CASE WHEN excluded.max_num > 0 THEN excluded.max_num ELSE groups.max_num END,
                        updated_at = excluded.updated_at
                    """,
                    (
                        gc,
                        str(row.get("name") or ""),
                        str(row.get("role") or "join"),
                        str(row.get("owner") or ""),
                        int(row.get("mem_num") or 0),
                        int(row.get("max_num") or 0),
                        now,
                    ),
                )
                count += 1
        return count

    def list_groups(self) -> list[dict[str, Any]]:
        with self.session() as conn:
            rows = conn.execute(
                "SELECT * FROM groups ORDER BY mem_num DESC, name ASC, gc ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_group(self, gc: str) -> dict[str, Any] | None:
        with self.session() as conn:
            row = conn.execute("SELECT * FROM groups WHERE gc = ?", (str(gc),)).fetchone()
        return dict(row) if row else None

    def delete_group(self, gc: str) -> bool:
        with self._write_lock, self.session() as conn:
            cur = conn.execute("DELETE FROM groups WHERE gc = ?", (str(gc),))
        return cur.rowcount > 0

    # ------------------------------------------------------------- members
    def replace_members(self, gc: str, members: Iterable[dict[str, Any]]) -> int:
        """整群替换成员，能反映退群/新入群；只有拉取成功后才调用。"""
        gc = str(gc)
        now = now_iso()
        rows = []
        for m in members:
            uin = str(m.get("uin") or "").strip()
            if not uin:
                continue
            rows.append(
                (
                    gc,
                    uin,
                    str(m.get("nick") or ""),
                    str(m.get("card") or ""),
                    int(m.get("join_time") or 0),
                    int(m.get("last_speak_time") or 0),
                    int(m.get("last_active_day") or 0),
                    int(m.get("level") or 0),
                    1 if m.get("is_friend") else 0,
                    1 if m.get("is_owner") else 0,
                    1 if m.get("is_admin") else 0,
                    now,
                )
            )
        with self._write_lock, self.session() as conn:
            conn.execute(
                "INSERT INTO groups(gc, name, role, updated_at) VALUES(?, '', 'join', ?) "
                "ON CONFLICT(gc) DO NOTHING",
                (gc, now),
            )
            conn.execute("DELETE FROM members WHERE gc = ?", (gc,))
            conn.executemany(
                """
                INSERT INTO members(
                    gc, uin, nick, card, join_time, last_speak_time, last_active_day,
                    level, is_friend, is_owner, is_admin, synced_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.execute(
                "UPDATE groups SET mem_num = ?, synced_at = ?, updated_at = ? WHERE gc = ?",
                (len(rows), now, now, gc),
            )
        return len(rows)

    def members_of(self, gc: str) -> list[dict[str, Any]]:
        with self.session() as conn:
            rows = conn.execute(
                "SELECT * FROM members WHERE gc = ? ORDER BY last_speak_time DESC, uin ASC",
                (str(gc),),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------------------------------------------------------- bulk / io
    def clear_data(self, include_session: bool = True) -> None:
        with self._write_lock, self.session() as conn:
            conn.execute("DELETE FROM members")
            conn.execute("DELETE FROM groups")
            if include_session:
                conn.execute("DELETE FROM meta WHERE key IN ('session_cookie', 'account_uin')")

    def export_dump(self) -> dict[str, Any]:
        with self.session() as conn:
            groups = [dict(r) for r in conn.execute("SELECT * FROM groups ORDER BY gc").fetchall()]
            members = [
                dict(r) for r in conn.execute("SELECT * FROM members ORDER BY gc, uin").fetchall()
            ]
        return {
            "app": "qq-group-roster",
            "version": 1,
            "exported_at": now_iso(),
            "groups": groups,
            "members": members,
        }

    def import_dump(self, data: dict[str, Any]) -> dict[str, int]:
        if not isinstance(data, dict):
            raise ValueError("导入文件必须是 JSON 对象")
        groups = data.get("groups") or []
        members = data.get("members") or []
        if not isinstance(groups, list) or not isinstance(members, list):
            raise ValueError("groups / members 必须是数组")

        group_rows = []
        for g in groups:
            if not isinstance(g, dict) or not g.get("gc"):
                continue
            group_rows.append(
                {
                    "gc": str(g.get("gc")),
                    "name": str(g.get("name") or ""),
                    "role": str(g.get("role") or "join"),
                    "owner": str(g.get("owner") or ""),
                    "mem_num": int(g.get("mem_num") or 0),
                    "max_num": int(g.get("max_num") or 0),
                }
            )
        self.upsert_groups(group_rows)

        by_group: dict[str, list[dict[str, Any]]] = {}
        for m in members:
            if not isinstance(m, dict):
                continue
            gc = str(m.get("gc") or "")
            uin = str(m.get("uin") or "")
            if not gc or not uin:
                continue
            by_group.setdefault(gc, []).append(m)

        total = 0
        for gc, rows in by_group.items():
            total += self.replace_members(gc, rows)
        return {"groups": len(group_rows), "members": total}

    def counts(self) -> dict[str, int]:
        with self.session() as conn:
            g = conn.execute("SELECT COUNT(*) AS n FROM groups").fetchone()["n"]
            m = conn.execute("SELECT COUNT(*) AS n FROM members").fetchone()["n"]
            u = conn.execute("SELECT COUNT(DISTINCT uin) AS n FROM members").fetchone()["n"]
        return {"groups": int(g), "memberships": int(m), "unique_members": int(u)}
