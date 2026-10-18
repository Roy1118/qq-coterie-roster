from __future__ import annotations

import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from qqroster import analytics, export
from qqroster.client import QunClient
from qqroster.db import Database

NOW = int(time.time())
D = 86400


def make_db() -> Database:
    path = Path(tempfile.mkdtemp()) / "test.db"
    db = Database(path)
    db.upsert_groups(
        [
            {"gc": "g1", "name": "一群", "role": "create", "owner": "u1", "mem_num": 3},
            {"gc": "g2", "name": "二群", "role": "join", "owner": "u9", "mem_num": 3},
            {"gc": "g3", "name": "三群", "role": "manage", "owner": "u9", "mem_num": 2},
        ]
    )
    db.replace_members(
        "g1",
        [
            {"uin": "u1", "nick": "阿一", "card": "群一名片", "join_time": NOW - 10 * D, "last_speak_time": NOW - D, "is_owner": True, "is_friend": True},
            {"uin": "u2", "nick": "阿二", "join_time": NOW - 100 * D, "last_speak_time": NOW - 40 * D},
            {"uin": "u3", "nick": "阿三", "join_time": NOW - 5 * D, "last_speak_time": 0},
        ],
    )
    db.replace_members(
        "g2",
        [
            {"uin": "u1", "nick": "阿一", "card": "群二名片", "join_time": NOW - 20 * D, "last_speak_time": NOW - 2 * D, "is_admin": True},
            {"uin": "u2", "nick": "阿二", "join_time": NOW - 60 * D, "last_speak_time": NOW - 5 * D},
            {"uin": "u4", "nick": "阿四", "join_time": NOW - 200 * D, "last_speak_time": NOW - 100 * D},
        ],
    )
    db.replace_members(
        "g3",
        [
            {"uin": "u1", "nick": "阿一", "join_time": NOW - 30 * D, "last_speak_time": NOW - 3 * D},
            {"uin": "u5", "nick": "阿五", "join_time": NOW - 3 * D, "last_speak_time": NOW - 2 * D},
        ],
    )
    return db


class AnalyticsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = make_db()
        self.addCleanup(shutil.rmtree, Path(self.db.path).parent, ignore_errors=True)

    def test_counts(self) -> None:
        self.assertEqual(self.db.counts(), {"groups": 3, "memberships": 8, "unique_members": 5})

    def test_overview(self) -> None:
        data = analytics.overview(self.db)
        self.assertEqual(data["groups"], 3)
        self.assertEqual(data["unique_members"], 5)
        self.assertEqual(data["multi_group_members"], 2)  # u1, u2
        self.assertGreaterEqual(data["active_7d"], 3)  # u1/u2/u5
        self.assertEqual(data["potential_friends"], 0)
        self.assertEqual(len(data["activity_histogram"]), 5)
        self.assertEqual(len(data["join_trend"]), 8)

    def test_overlap_two_groups(self) -> None:
        data = analytics.overlap(self.db, ["g1", "g2"])
        self.assertEqual(data["stats"]["common"], 2)
        self.assertEqual(data["stats"]["only_a"], 1)
        self.assertEqual(data["stats"]["only_b"], 1)
        self.assertEqual(data["stats"]["union"], 4)
        self.assertAlmostEqual(data["stats"]["jaccard"], 0.5, places=4)
        uins = {m["uin"] for m in data["common"]}
        self.assertEqual(uins, {"u1", "u2"})
        u1 = next(m for m in data["common"] if m["uin"] == "u1")
        self.assertEqual(u1["group_count"], 3)
        self.assertEqual(len(u1["groups"]), 3)

    def test_overlap_three_groups(self) -> None:
        data = analytics.overlap(self.db, ["g1", "g2", "g3"])
        self.assertEqual(data["stats"]["common"], 1)
        self.assertEqual(data["common"][0]["uin"], "u1")
        self.assertEqual(data["stats"]["union"], 5)

    def test_member_search_and_profile(self) -> None:
        rows = analytics.member_search(self.db, "阿一")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["uin"], "u1")
        self.assertEqual(rows[0]["group_count"], 3)
        self.assertEqual(len(rows[0]["groups"]), 3)

        profile = analytics.member_profile(self.db, "u1")
        self.assertIsNotNone(profile)
        assert profile is not None
        self.assertEqual(profile["group_count"], 3)
        self.assertTrue(profile["is_owner"])
        self.assertTrue(profile["is_admin"])
        self.assertIn("群一名片", profile["aliases"])
        co = {c["uin"]: c["shared"] for c in profile["co_members"]}
        self.assertEqual(co.get("u2"), 2)

    def test_activity_modes(self) -> None:
        active = analytics.activity(self.db, "active", days=7)
        self.assertEqual({r["uin"] for r in active["rows"]}, {"u1", "u2", "u5"})

        lurker = analytics.activity(self.db, "lurker", days=90)
        self.assertEqual({r["uin"] for r in lurker["rows"]}, {"u3", "u4"})

        new = analytics.activity(self.db, "new", days=7)
        self.assertEqual({r["uin"] for r in new["rows"]}, {"u3", "u5"})

        scoped = analytics.activity(self.db, "active", days=7, gc="g1")
        self.assertEqual({r["uin"] for r in scoped["rows"]}, {"u1"})

    def test_matrix_and_network(self) -> None:
        data = analytics.matrix(self.db)
        edges = {(e["a"], e["b"]): e["shared"] for e in data["edges"]}
        self.assertEqual(edges[("g1", "g2")], 2)
        self.assertEqual(edges[("g1", "g3")], 1)
        self.assertEqual(edges[("g2", "g3")], 1)
        net = analytics.network(self.db, min_shared=2)
        self.assertEqual(len(net["edges"]), 1)
        self.assertEqual(len(net["nodes"]), 2)

    def test_groups_with_stats(self) -> None:
        groups = {g["gc"]: g for g in analytics.groups_with_stats(self.db)}
        self.assertEqual(groups["g1"]["member_count"], 3)
        self.assertEqual(groups["g1"]["active_7d"], 1)
        self.assertTrue(groups["g1"]["synced"])

    def test_export_csv(self) -> None:
        name, body = export.members_csv(self.db, "g1")
        text = body.decode("utf-8-sig")
        self.assertIn("一群", text)
        self.assertIn("阿一", text)
        self.assertNotIn("阿四", text)
        self.assertTrue(name.startswith("members-g1-"))

        name, body = export.overlap_csv(self.db, ["g1", "g2"])
        text = body.decode("utf-8-sig")
        self.assertIn("u1", text)
        self.assertNotIn("u3", text)

    def test_csv_formula_injection_is_escaped(self) -> None:
        body = export._write([["=1+1", "normal", -1, "@cmd"]])
        text = body.decode("utf-8-sig")
        self.assertIn("'=1+1", text)
        self.assertIn("'@cmd", text)
        self.assertIn("-1", text)

    def test_clear_data_keeps_session(self) -> None:
        self.db.set_meta("session_cookie", "skey=test")
        self.db.clear_data(include_session=False)
        self.assertEqual(self.db.counts()["groups"], 0)
        self.assertEqual(self.db.get_meta("session_cookie"), "skey=test")

    def test_dump_import_roundtrip(self) -> None:
        dump = self.db.export_dump()
        self.assertEqual(len(dump["groups"]), 3)
        self.assertEqual(len(dump["members"]), 8)
        raw = json.dumps(dump, ensure_ascii=False)

        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        db2 = Database(tmp / "roundtrip.db")
        result = db2.import_dump(json.loads(raw))
        self.assertEqual(result["groups"], 3)
        self.assertEqual(result["members"], 8)
        self.assertEqual(db2.counts()["unique_members"], 5)


class FakeClient(QunClient):
    def __init__(self) -> None:
        super().__init__(session=None)  # type: ignore[arg-type]

    def members_info_v1(self, group_id):  # noqa: ANN001
        return {
            "owner": "10001",
            "mem_num": "3",
            "max_num": 200,
            "members": {
                "10001": {"nk": "群主&amp;", "cd": "老大", "jt": 100, "lst": 200, "ll": 9, "fr": 1, "rm": 0},
                "10002": {"nk": "管理", "cd": "", "jt": 101, "lst": 201, "ll": 8, "fr": 0, "rm": 1},
                "10003": {"nk": "成员", "cd": "小弟", "jt": 102, "lst": 0, "ll": 1, "fr": 0, "rm": 0},
            },
        }


class ClientParsingTest(unittest.TestCase):
    def test_fetch_members(self) -> None:
        result = FakeClient().fetch_members("g1", "测试群")
        self.assertEqual(result["group_name"], "测试群")
        self.assertEqual(result["owner"], "10001")
        self.assertEqual(result["mem_num"], 3)
        self.assertEqual(result["max_num"], 200)
        self.assertEqual(result["exported"], 3)
        by_uin = {m["uin"]: m for m in result["members"]}
        self.assertTrue(by_uin["10001"]["is_owner"])
        self.assertFalse(by_uin["10001"]["is_admin"])
        self.assertTrue(by_uin["10002"]["is_admin"])
        self.assertEqual(by_uin["10001"]["nick"], "群主&")
        self.assertEqual(by_uin["10003"]["card"], "小弟")
        self.assertTrue(by_uin["10001"]["is_friend"])


if __name__ == "__main__":
    unittest.main()
