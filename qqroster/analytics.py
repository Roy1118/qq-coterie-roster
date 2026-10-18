"""跨群重合、活跃度、关系网络等分析逻辑。

所有计算都在本地 SQLite 上完成。
"""

from __future__ import annotations

import time
from typing import Any, Iterable

from .db import Database

DAY = 86400


def _cutoff(days: int) -> int:
    return int(time.time()) - int(days) * DAY


def _chunks(items: list[str], size: int = 400) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _rows(conn, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _placeholders(n: int) -> str:
    return ",".join("?" * n)


def overview(db: Database) -> dict[str, Any]:
    now = int(time.time())
    c7, c30, c90 = _cutoff(7), _cutoff(30), _cutoff(90)
    with db.session() as conn:
        groups = conn.execute("SELECT COUNT(*) n FROM groups").fetchone()["n"]
        memberships = conn.execute("SELECT COUNT(*) n FROM members").fetchone()["n"]
        unique_members = conn.execute("SELECT COUNT(DISTINCT uin) n FROM members").fetchone()["n"]
        multi = conn.execute(
            "SELECT COUNT(*) n FROM (SELECT uin FROM members GROUP BY uin "
            "HAVING COUNT(DISTINCT gc) >= 2)"
        ).fetchone()["n"]
        active7 = conn.execute(
            "SELECT COUNT(DISTINCT uin) n FROM members WHERE last_speak_time >= ?", (c7,)
        ).fetchone()["n"]
        active30 = conn.execute(
            "SELECT COUNT(DISTINCT uin) n FROM members WHERE last_speak_time >= ?", (c30,)
        ).fetchone()["n"]
        active90 = conn.execute(
            "SELECT COUNT(DISTINCT uin) n FROM members WHERE last_speak_time >= ?", (c90,)
        ).fetchone()["n"]
        new30 = conn.execute(
            "SELECT COUNT(DISTINCT uin) n FROM members WHERE join_time >= ?", (c30,)
        ).fetchone()["n"]
        friends = conn.execute(
            "SELECT COUNT(DISTINCT uin) n FROM members WHERE is_friend = 1"
        ).fetchone()["n"]
        potential_friends = conn.execute(
            "SELECT COUNT(*) n FROM (SELECT uin FROM members GROUP BY uin "
            "HAVING COUNT(DISTINCT gc) >= 3 AND MAX(is_friend) = 0)"
        ).fetchone()["n"]
        last_sync = conn.execute("SELECT MAX(synced_at) v FROM groups").fetchone()["v"]

        top_members = _rows(
            conn,
            """
            SELECT uin, MAX(nick) nick, MAX(card) card,
                   COUNT(DISTINCT gc) group_count,
                   MAX(last_speak_time) last_speak_time,
                   MAX(is_friend) is_friend
            FROM members
            GROUP BY uin
            HAVING COUNT(DISTINCT gc) >= 2
            ORDER BY group_count DESC, last_speak_time DESC
            LIMIT 12
            """,
        )

        pairs = _rows(
            conn,
            """
            SELECT a.gc a_gc, b.gc b_gc, COUNT(*) shared
            FROM members a
            JOIN members b ON a.uin = b.uin AND a.gc < b.gc
            GROUP BY a.gc, b.gc
            ORDER BY shared DESC, a.gc, b.gc
            LIMIT 10
            """,
        )
        names = {g["gc"]: g["name"] for g in _rows(conn, "SELECT gc, name FROM groups")}
        for p in pairs:
            p["a_name"] = names.get(p["a_gc"]) or p["a_gc"]
            p["b_name"] = names.get(p["b_gc"]) or p["b_gc"]

        hist_rows = _rows(
            conn,
            """
            WITH p AS (SELECT uin, MAX(last_speak_time) last FROM members GROUP BY uin)
            SELECT CASE
                WHEN last >= ? THEN '7d'
                WHEN last >= ? THEN '30d'
                WHEN last >= ? THEN '90d'
                WHEN last > 0 THEN 'older'
                ELSE 'never' END AS bucket,
                COUNT(*) n
            FROM p GROUP BY bucket
            """,
            (c7, c30, c90),
        )
        hist_map = {r["bucket"]: r["n"] for r in hist_rows}
        histogram = [
            {"key": "7d", "label": "7 天内", "count": int(hist_map.get("7d", 0))},
            {"key": "30d", "label": "8-30 天", "count": int(hist_map.get("30d", 0))},
            {"key": "90d", "label": "31-90 天", "count": int(hist_map.get("90d", 0))},
            {"key": "older", "label": "90 天以上", "count": int(hist_map.get("older", 0))},
            {"key": "never", "label": "从未发言", "count": int(hist_map.get("never", 0))},
        ]

        trend_rows = _rows(
            conn,
            """
            SELECT CAST((? - join_time) / 604800 AS INTEGER) weeks_ago, COUNT(*) n
            FROM members
            WHERE join_time > 0 AND join_time >= ?
            GROUP BY weeks_ago
            """,
            (now, now - 8 * 7 * DAY),
        )
        trend_map = {int(r["weeks_ago"]): int(r["n"]) for r in trend_rows}
        join_trend = [
            {"label": f"{w}周前" if w else "本周", "count": trend_map.get(w, 0)}
            for w in range(7, -1, -1)
        ]

    return {
        "groups": int(groups),
        "memberships": int(memberships),
        "unique_members": int(unique_members),
        "multi_group_members": int(multi),
        "active_7d": int(active7),
        "active_30d": int(active30),
        "active_90d": int(active90),
        "new_30d": int(new30),
        "friends": int(friends),
        "potential_friends": int(potential_friends),
        "last_sync": last_sync,
        "top_members": top_members,
        "top_pairs": pairs,
        "activity_histogram": histogram,
        "join_trend": join_trend,
    }


def groups_with_stats(db: Database) -> list[dict[str, Any]]:
    c7, c30, c90 = _cutoff(7), _cutoff(30), _cutoff(90)
    with db.session() as conn:
        rows = _rows(
            conn,
            """
            SELECT g.gc, g.name, g.role, g.owner, g.mem_num, g.max_num,
                   g.synced_at, g.updated_at,
                   COUNT(m.uin) member_count,
                   COALESCE(SUM(CASE WHEN m.last_speak_time >= ? THEN 1 ELSE 0 END), 0) active_7d,
                   COALESCE(SUM(CASE WHEN m.last_speak_time >= ? THEN 1 ELSE 0 END), 0) active_30d,
                   COALESCE(SUM(CASE WHEN m.last_speak_time = 0 OR m.last_speak_time < ?
                                     THEN 1 ELSE 0 END), 0) inactive_90d,
                   COALESCE(SUM(CASE WHEN m.join_time >= ? THEN 1 ELSE 0 END), 0) new_30d
            FROM groups g
            LEFT JOIN members m ON m.gc = g.gc
            GROUP BY g.gc
            ORDER BY member_count DESC, g.name ASC, g.gc ASC
            """,
            (c7, c30, c90, c30),
        )
    for r in rows:
        r["member_count"] = int(r["member_count"] or 0)
        r["active_7d"] = int(r["active_7d"] or 0)
        r["active_30d"] = int(r["active_30d"] or 0)
        r["inactive_90d"] = int(r["inactive_90d"] or 0)
        r["new_30d"] = int(r["new_30d"] or 0)
        r["synced"] = bool(r["synced_at"])
    return rows


def group_detail(db: Database, gc: str) -> dict[str, Any] | None:
    group = db.get_group(gc)
    if not group:
        return None
    members = db.members_of(gc)
    c7, c30, c90 = _cutoff(7), _cutoff(30), _cutoff(90)
    active7 = [m for m in members if m["last_speak_time"] >= c7]
    active30 = [m for m in members if m["last_speak_time"] >= c30]
    inactive = [m for m in members if m["last_speak_time"] == 0 or m["last_speak_time"] < c90]
    new30 = [m for m in members if m["join_time"] >= c30]
    top = sorted(active30, key=lambda m: m["last_speak_time"], reverse=True)[:12]
    recent = sorted([m for m in members if m["join_time"]], key=lambda m: m["join_time"], reverse=True)[:12]
    return {
        "group": group,
        "members": members,
        "stats": {
            "total": len(members),
            "active_7d": len(active7),
            "active_30d": len(active30),
            "inactive_90d": len(inactive),
            "new_30d": len(new30),
            "friends": sum(1 for m in members if m["is_friend"]),
            "owners": sum(1 for m in members if m["is_owner"]),
            "admins": sum(1 for m in members if m["is_admin"]),
        },
        "top_active": top,
        "recent_joiners": recent,
    }


def overlap(db: Database, gcs: list[str]) -> dict[str, Any]:
    gcs = [str(g) for g in dict.fromkeys(gcs) if str(g)]
    if not gcs:
        return {"groups": [], "common": [], "stats": {}, "memberships": {}}

    with db.session() as conn:
        selected = _rows(
            conn,
            f"SELECT gc, name, role, mem_num, synced_at FROM groups WHERE gc IN ({_placeholders(len(gcs))})",
            gcs,
        )
        order = {gc: i for i, gc in enumerate(gcs)}
        selected.sort(key=lambda g: order.get(g["gc"], 999))
        sizes = {
            r["gc"]: int(r["n"])
            for r in _rows(
                conn,
                f"SELECT gc, COUNT(*) n FROM members WHERE gc IN ({_placeholders(len(gcs))}) GROUP BY gc",
                gcs,
            )
        }
        union_count = conn.execute(
            f"SELECT COUNT(DISTINCT uin) n FROM members WHERE gc IN ({_placeholders(len(gcs))})",
            gcs,
        ).fetchone()["n"]

        common_rows = _rows(
            conn,
            f"""
            SELECT uin,
                   COUNT(DISTINCT gc) n,
                   MAX(last_speak_time) last_speak_time,
                   MAX(join_time) join_time,
                   MAX(is_friend) is_friend
            FROM members
            WHERE gc IN ({_placeholders(len(gcs))})
            GROUP BY uin
            HAVING COUNT(DISTINCT gc) = ?
            ORDER BY last_speak_time DESC, uin ASC
            """,
            [*gcs, len(gcs)],
        )
        common_uins = [r["uin"] for r in common_rows]

        memberships: dict[str, list[dict[str, Any]]] = {}
        for chunk in _chunks(common_uins):
            rows = _rows(
                conn,
                f"""
                SELECT m.uin, m.gc, g.name group_name, m.nick, m.card,
                       m.last_speak_time, m.join_time, m.is_owner, m.is_admin
                FROM members m
                LEFT JOIN groups g ON g.gc = m.gc
                WHERE m.uin IN ({_placeholders(len(chunk))})
                ORDER BY g.name ASC
                """,
                chunk,
            )
            for r in rows:
                memberships.setdefault(r["uin"], []).append(r)

        exclusive_rows = _rows(
            conn,
            f"""
            SELECT m.gc, COUNT(*) n
            FROM members m
            WHERE m.gc IN ({_placeholders(len(gcs))})
              AND m.uin NOT IN (
                  SELECT uin FROM members
                  WHERE gc IN ({_placeholders(len(gcs))})
                  GROUP BY uin HAVING COUNT(DISTINCT gc) > 1
              )
            GROUP BY m.gc
            """,
            [*gcs, *gcs],
        )
        exclusive = {r["gc"]: int(r["n"]) for r in exclusive_rows}

    common = []
    for r in common_rows:
        groups = memberships.get(r["uin"], [])
        nick = next((g["nick"] for g in groups if g.get("nick")), "")
        card = next((g["card"] for g in groups if g.get("card")), "")
        common.append(
            {
                "uin": r["uin"],
                "nick": nick,
                "card": card,
                "last_speak_time": int(r["last_speak_time"] or 0),
                "join_time": int(r["join_time"] or 0),
                "is_friend": bool(r["is_friend"]),
                "group_count": len(groups),
                "groups": groups,
            }
        )

    total_common = len(common_uins)
    total_sizes = sum(sizes.get(g, 0) for g in gcs)
    stats = {
        "common": total_common,
        "union": int(union_count or 0),
        "jaccard": round(total_common / union_count, 4) if union_count else 0,
        "overlap_coefficient": round(total_common / min(sizes.values()), 4)
        if sizes and min(sizes.values())
        else 0,
        "sum_members": total_sizes,
        "exclusive": [{"gc": g, "count": exclusive.get(g, 0)} for g in gcs],
    }
    if len(gcs) == 2:
        a, b = gcs
        stats.update(
            {
                "only_a": sizes.get(a, 0) - total_common,
                "only_b": sizes.get(b, 0) - total_common,
                "both": total_common,
            }
        )

    return {
        "groups": [{**g, "member_count": sizes.get(g["gc"], 0)} for g in selected],
        "common": common,
        "stats": stats,
        "memberships": memberships,
    }


def matrix(db: Database, gcs: list[str] | None = None, limit: int = 40) -> dict[str, Any]:
    with db.session() as conn:
        if gcs:
            gcs = [str(g) for g in dict.fromkeys(gcs) if str(g)]
            groups = _rows(
                conn,
                f"SELECT gc, name FROM groups WHERE gc IN ({_placeholders(len(gcs))})",
                gcs,
            )
            order = {gc: i for i, gc in enumerate(gcs)}
            groups.sort(key=lambda g: order.get(g["gc"], 999))
        else:
            groups = _rows(
                conn,
                "SELECT gc, name FROM groups ORDER BY mem_num DESC, name ASC LIMIT ?",
                (int(limit),),
            )
        ids = [g["gc"] for g in groups]
        if len(ids) < 2:
            return {"nodes": groups, "edges": []}
        sizes = {
            r["gc"]: int(r["n"])
            for r in _rows(
                conn,
                f"SELECT gc, COUNT(*) n FROM members WHERE gc IN ({_placeholders(len(ids))}) GROUP BY gc",
                ids,
            )
        }
        edges = _rows(
            conn,
            f"""
            SELECT a.gc a, b.gc b, COUNT(*) shared
            FROM members a
            JOIN members b ON a.uin = b.uin AND a.gc < b.gc
            WHERE a.gc IN ({_placeholders(len(ids))}) AND b.gc IN ({_placeholders(len(ids))})
            GROUP BY a.gc, b.gc
            ORDER BY shared DESC
            """,
            [*ids, *ids],
        )
    for g in groups:
        g["member_count"] = sizes.get(g["gc"], 0)
    for e in edges:
        e["shared"] = int(e["shared"])
    return {"nodes": groups, "edges": edges}


def member_search(db: Database, q: str = "", limit: int = 200) -> list[dict[str, Any]]:
    q = (q or "").strip()
    like = f"%{q}%"
    where = ""
    params: list[Any] = []
    if q:
        where = "WHERE m.uin LIKE ? OR m.nick LIKE ? OR m.card LIKE ?"
        params = [like, like, like]
    with db.session() as conn:
        rows = _rows(
            conn,
            f"""
            SELECT m.uin, MAX(m.nick) nick, MAX(m.card) card,
                   COUNT(DISTINCT m.gc) group_count,
                   MAX(m.last_speak_time) last_speak_time,
                   MAX(m.join_time) join_time,
                   MAX(m.is_friend) is_friend,
                   MAX(m.is_owner) is_owner,
                   MAX(m.is_admin) is_admin
            FROM members m
            {where}
            GROUP BY m.uin
            ORDER BY group_count DESC, last_speak_time DESC
            LIMIT ?
            """,
            [*params, int(limit)],
        )
        uins = [r["uin"] for r in rows]
        names: dict[str, list[dict[str, str]]] = {}
        for chunk in _chunks(uins):
            for r in _rows(
                conn,
                f"""
                SELECT m.uin, m.gc, COALESCE(NULLIF(g.name, ''), g.gc) group_name
                FROM members m LEFT JOIN groups g ON g.gc = m.gc
                WHERE m.uin IN ({_placeholders(len(chunk))})
                ORDER BY g.name ASC
                """,
                chunk,
            ):
                names.setdefault(r["uin"], []).append(
                    {"gc": r["gc"], "name": r["group_name"]}
                )
    for r in rows:
        r["groups"] = names.get(r["uin"], [])
        r["is_friend"] = bool(r["is_friend"])
        r["is_owner"] = bool(r["is_owner"])
        r["is_admin"] = bool(r["is_admin"])
    return rows


def member_profile(db: Database, uin: str) -> dict[str, Any] | None:
    uin = str(uin)
    with db.session() as conn:
        memberships = _rows(
            conn,
            """
            SELECT m.*, COALESCE(NULLIF(g.name, ''), g.gc) group_name
            FROM members m LEFT JOIN groups g ON g.gc = m.gc
            WHERE m.uin = ?
            ORDER BY m.last_speak_time DESC
            """,
            (uin,),
        )
        if not memberships:
            return None
        co_rows = _rows(
            conn,
            """
            SELECT b.uin, COUNT(DISTINCT b.gc) shared
            FROM members a
            JOIN members b ON a.gc = b.gc AND a.uin <> b.uin
            WHERE a.uin = ?
            GROUP BY b.uin
            ORDER BY shared DESC
            LIMIT 10
            """,
            (uin,),
        )
        co_uins = [r["uin"] for r in co_rows]
        co_names: dict[str, str] = {}
        if co_uins:
            for r in _rows(
                conn,
                f"SELECT uin, MAX(nick) nick FROM members WHERE uin IN ({_placeholders(len(co_uins))}) GROUP BY uin",
                co_uins,
            ):
                co_names[r["uin"]] = r["nick"]
    aliases = []
    for m in memberships:
        for value in (m.get("nick"), m.get("card")):
            if value and value not in aliases:
                aliases.append(value)
    last = max((m["last_speak_time"] for m in memberships), default=0)
    first_join = min((m["join_time"] for m in memberships if m["join_time"]), default=0)
    return {
        "uin": uin,
        "nick": next((m["nick"] for m in memberships if m["nick"]), ""),
        "aliases": aliases,
        "group_count": len(memberships),
        "last_speak_time": last,
        "first_join_time": first_join,
        "is_friend": any(m["is_friend"] for m in memberships),
        "is_owner": any(m["is_owner"] for m in memberships),
        "is_admin": any(m["is_admin"] for m in memberships),
        "memberships": memberships,
        "co_members": [
            {"uin": r["uin"], "shared": int(r["shared"]), "nick": co_names.get(r["uin"], "")}
            for r in co_rows
        ],
    }


def activity(
    db: Database,
    mode: str = "active",
    days: int = 30,
    gc: str | None = None,
    limit: int = 300,
) -> dict[str, Any]:
    cutoff = _cutoff(days)
    gc = str(gc) if gc else None
    where = []
    params: list[Any] = []
    if gc:
        where.append("m.gc = ?")
        params.append(gc)
    if mode == "active":
        where.append("m.last_speak_time >= ?")
        params.append(cutoff)
    elif mode == "lurker":
        where.append("(m.last_speak_time = 0 OR m.last_speak_time < ?)")
        params.append(cutoff)
    elif mode == "new":
        where.append("m.join_time >= ?")
        params.append(cutoff)
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    with db.session() as conn:
        if gc:
            rows = _rows(
                conn,
                f"""
                SELECT m.uin, m.nick, m.card, m.gc,
                       COALESCE(NULLIF(g.name, ''), g.gc) group_name,
                       m.last_speak_time, m.join_time, m.is_friend, m.is_owner, m.is_admin
                FROM members m LEFT JOIN groups g ON g.gc = m.gc
                {clause}
                ORDER BY m.last_speak_time DESC, m.uin ASC
                LIMIT ?
                """,
                [*params, int(limit)],
            )
        else:
            rows = _rows(
                conn,
                f"""
                SELECT m.uin, MAX(m.nick) nick, MAX(m.card) card,
                       COUNT(DISTINCT m.gc) group_count,
                       MAX(m.last_speak_time) last_speak_time,
                       MAX(m.join_time) join_time,
                       MAX(m.is_friend) is_friend,
                       MAX(m.is_owner) is_owner,
                       MAX(m.is_admin) is_admin
                FROM members m
                {clause}
                GROUP BY m.uin
                ORDER BY last_speak_time DESC, m.uin ASC
                LIMIT ?
                """,
                [*params, int(limit)],
            )
            uins = [r["uin"] for r in rows]
            names: dict[str, list[dict[str, str]]] = {}
            for chunk in _chunks(uins):
                for r in _rows(
                    conn,
                    f"""
                    SELECT m.uin, m.gc, COALESCE(NULLIF(g.name, ''), g.gc) group_name
                    FROM members m LEFT JOIN groups g ON g.gc = m.gc
                    WHERE m.uin IN ({_placeholders(len(chunk))})
                    """,
                    chunk,
                ):
                    names.setdefault(r["uin"], []).append({"gc": r["gc"], "name": r["group_name"]})
            for r in rows:
                r["groups"] = names.get(r["uin"], [])
                r["is_friend"] = bool(r["is_friend"])
                r["is_owner"] = bool(r["is_owner"])
                r["is_admin"] = bool(r["is_admin"])
    return {"mode": mode, "days": days, "gc": gc, "rows": rows, "cutoff": cutoff}


def multi_group(db: Database, min_groups: int = 2, limit: int = 300) -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = _rows(
            conn,
            """
            SELECT uin, MAX(nick) nick, MAX(card) card,
                   COUNT(DISTINCT gc) group_count,
                   MAX(last_speak_time) last_speak_time,
                   MAX(join_time) join_time,
                   MAX(is_friend) is_friend
            FROM members
            GROUP BY uin
            HAVING COUNT(DISTINCT gc) >= ?
            ORDER BY group_count DESC, last_speak_time DESC
            LIMIT ?
            """,
            (int(min_groups), int(limit)),
        )
        uins = [r["uin"] for r in rows]
        names: dict[str, list[dict[str, str]]] = {}
        for chunk in _chunks(uins):
            for r in _rows(
                conn,
                f"""
                SELECT m.uin, m.gc, COALESCE(NULLIF(g.name, ''), g.gc) group_name
                FROM members m LEFT JOIN groups g ON g.gc = m.gc
                WHERE m.uin IN ({_placeholders(len(chunk))})
                ORDER BY g.name ASC
                """,
                chunk,
            ):
                names.setdefault(r["uin"], []).append({"gc": r["gc"], "name": r["group_name"]})
    for r in rows:
        r["groups"] = names.get(r["uin"], [])
        r["is_friend"] = bool(r["is_friend"])
    return rows


def network(db: Database, min_shared: int = 1, max_nodes: int = 40, max_edges: int = 160) -> dict[str, Any]:
    data = matrix(db, limit=max_nodes)
    edges = [e for e in data["edges"] if e["shared"] >= min_shared][:max_edges]
    connected = {e["a"] for e in edges} | {e["b"] for e in edges}
    nodes = [n for n in data["nodes"] if n["gc"] in connected] or data["nodes"]
    return {"nodes": nodes, "edges": edges}
