#!/usr/bin/env python3
"""生成演示数据（全部虚构），用于录屏、截图和演示动画。

真实使用时数据来自 qun.qq.com；这个脚本只是造一批**虚构**的群和群友，
让你可以在不登录真实 QQ 账号的前提下录制视频、做截图。

用法：

    # 只生成 JSON 备份
    python tools/make_demo_data.py --json docs/demo-data.json

    # 直接写入一个独立的数据库（含假登录态，仅用于本地演示）
    python tools/make_demo_data.py --db "%TEMP%/roster-demo/roster.db"

注意：写入的数据库里含一个**假的** session cookie 占位值（skey=@DEMO-ONLY），
它不能用于访问任何腾讯接口，只为了让界面显示「已登录」。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 演示用群名 / 群号（群号是编造的，与真实群无关）
GROUPS: list[tuple[str, str]] = [
    ("夜猫子交流群", "728394615"),
    ("摄影同好会", "641207938"),
    ("独立游戏研究所", "883015274"),
    ("机械键盘研究所", "502738194"),
    ("早八人互助会", "756180493"),
    ("咖啡续命小组", "930472186"),
    ("猫咪行为观察", "618305729"),
    ("深夜食堂探店", "847192635"),
    ("爬山不拍照群", "705938241"),
    ("前端搬砖互助", "926471083"),
    ("胶片冲洗交流", "539180627"),
    ("桌面绿植养护", "814073526"),
    ("手冲咖啡研习", "672919348"),
    ("公路车骑行团", "498261750"),
    ("老式游戏机收藏", "761048293"),
    ("城市观鸟小组", "835720149"),
    ("深夜代码局", "591384627"),
    ("桌游跑团据点", "904816372"),
    ("露营装备交流", "648209175"),
    ("搬家搬砖互助", "782935461"),
]

# 群规模权重：前几个群明显更大
GROUP_WEIGHT = [
    3.0, 2.4, 2.0, 1.6, 1.4, 1.3, 1.2, 1.1, 1.0, 1.0,
    0.9, 0.9, 0.8, 0.8, 0.7, 0.7, 0.6, 0.6, 0.5, 0.5,
]

NICK_A = [
    "夜航", "柚子", "橘子", "麦芽", "凉白", "芒果", "半糖", "无糖", "拿铁", "西柚",
    "小林", "三点", "咕咕", "阿七", "一颗", "关灯", "早八", "麦克", "路人", "土豆",
    "橙子", "抹茶", "阿呆", "小满", "花卷", "青柠", "山楂", "年糕", "汤圆", "秋刀",
    "知了", "海盐", "蜜桃", "芝麻", "豌豆", "云朵", "风铃", "空山", "长夜", "晚风",
    "旧巷", "落雨", "半盏", "青椒", "洋葱", "锅里", "沙发", "键盘", "鼠标", "耳机",
    "镜头", "光斑", "快门", "胶卷", "显影", "定影", "暗房", "底片", "脚架", "光圈",
    "单车", "链条", "齿轮", "坡道", "补给", "水壶", "能量", "配速", "心率", "拉伸",
    "绿萝", "多肉", "龟背", "薄荷", "迷迭", "罗勒", "百里", "绣球", "栀子", "文竹",
    "猫条", "猫砂", "逗猫", "撸猫", "猫抓", "猫窝", "毛球", "尾巴", "耳朵", "肉垫",
]

NICK_B = [
    "不加冰", "汽水", "不说话", "不加班", "要去睡", "要加糖", "不加香菜", "睡着了", "气泡水", "布丁",
    "的猫", "的狗", "的鱼", "的盆栽", "本尊", "本体", "同学", "老师", "老周", "打工",
    "一枚", "两只", "三斤", "四两", "半只", "全场", "本人", "下士", "小队长", "指挥官",
    "在摸鱼", "在加班", "在睡觉", "在赶稿", "在写码", "在调试", "在改稿", "在打包", "在剪辑", "在跑图",
    "吃夜宵", "喝冷萃", "啃面包", "泡面王", "下厨中", "点外卖", "带饭人", "干饭魂", "甜口党", "咸口党",
    "不自律", "很克制", "再睡会", "起不来", "已阵亡", "还在肝", "已退休", "躺平中", "原地转圈", "漂浮",
]

CARD_PREFIX = ["", "", "", "潜水-", "摄影-", "跑团-", "夜猫-", "咖啡-", "骑行-", "植友-"]


def build_people(rnd: random.Random, count: int) -> list[dict]:
    people: list[dict] = []
    nicks: set[str] = set()
    uins: set[str] = set()
    guard = 0
    while len(people) < count and guard < count * 40:
        guard += 1
        nick = rnd.choice(NICK_A) + rnd.choice(NICK_B)
        if nick in nicks:
            continue
        uin = str(100000000 + rnd.randrange(899999999))
        if uin in uins:
            continue
        nicks.add(nick)
        uins.add(uin)
        people.append({"uin": uin, "nick": nick})
    return people


def last_speak_offset(rnd: random.Random) -> int:
    """返回「距今多少秒前最后一次发言」，分布贴近真实群聊。"""
    r = rnd.random()
    if r < 0.12:
        return rnd.randrange(0, 3600 * 6)
    if r < 0.30:
        return rnd.randrange(3600 * 6, 3600 * 24 * 3)
    if r < 0.45:
        return rnd.randrange(3600 * 24 * 3, 3600 * 24 * 7)
    if r < 0.70:
        return rnd.randrange(3600 * 24 * 7, 3600 * 24 * 30)
    if r < 0.85:
        return rnd.randrange(3600 * 24 * 30, 3600 * 24 * 90)
    if r < 0.94:
        return rnd.randrange(3600 * 24 * 90, 3600 * 24 * 180)
    return rnd.randrange(3600 * 24 * 180, 3600 * 24 * 420)


def join_offset(rnd: random.Random) -> int:
    if rnd.random() < 0.14:
        return rnd.randrange(3600 * 12, 3600 * 24 * 7)
    return rnd.randrange(3600 * 24 * 7, 3600 * 24 * 365 * 7)


def build(seed: int = 20261018, people_count: int = 1800) -> dict:
    rnd = random.Random(seed)
    now = int(datetime(2026, 10, 18, 21, 30).timestamp())

    people = build_people(rnd, people_count)
    memberships: dict[int, list[int]] = {i: [] for i in range(len(GROUPS))}

    for person_idx, _person in enumerate(people):
        k = 1 + int((rnd.random() ** 3.6) * 8)
        chosen: set[int] = set()
        if rnd.random() < 0.75:
            chosen.add(0)  # 大多数人都待在第 1 个群
        guard = 0
        while len(chosen) < k and guard < 60:
            guard += 1
            chosen.add(rnd.choices(range(len(GROUPS)), weights=GROUP_WEIGHT)[0])
        for gi in chosen:
            memberships[gi].append(person_idx)

    groups: list[dict] = []
    for gi, (name, gc) in enumerate(GROUPS):
        groups.append({
            "gc": gc,
            "name": name,
            "role": "create" if gi == 0 else ("manage" if gi in (1, 2) else "join"),
            "owner": people[gi]["uin"],
            "mem_num": len(memberships[gi]),
            "max_num": 2000 if gi < 4 else 500,
        })

    members: list[dict] = []
    for gi, (_name, gc) in enumerate(GROUPS):
        roster = memberships[gi]
        admin_slots = set(rnd.sample(roster, min(len(roster), rnd.randint(1, 4)))) if roster else set()
        owner_person = gi % len(people)
        for person_idx in roster:
            person = people[person_idx]
            card = person["nick"]
            if rnd.random() < 0.30:
                card = rnd.choice(CARD_PREFIX) + person["nick"]
            members.append({
                "gc": gc,
                "uin": person["uin"],
                "nick": person["nick"],
                "card": card,
                "join_time": now - join_offset(rnd),
                "last_speak_time": now - last_speak_offset(rnd),
                "last_active_day": 0,
                "level": rnd.randint(0, 6),
                "is_friend": rnd.random() < 0.18,
                "is_owner": person_idx == owner_person,
                "is_admin": person_idx in admin_slots and person_idx != owner_person,
            })

    return {
        "app": "qq-group-roster",
        "version": 1,
        "exported_at": datetime(2026, 10, 18, 21, 30).isoformat(timespec="seconds"),
        "demo": True,
        "groups": groups,
        "members": members,
    }


def write_db(payload: dict, db_path: Path) -> None:
    from qqroster.db import Database

    for suffix in ("", "-wal", "-shm"):
        side = db_path.with_name(db_path.name + suffix)
        if side.exists():
            side.unlink()

    db = Database(db_path)
    result = db.import_dump(payload)
    # 假登录态占位值：只让界面显示「已登录」，无法用于任何真实请求
    db.set_meta("session_cookie", "uin=o100000000; skey=@DEMO-ONLY-NOT-A-REAL-COOKIE")
    db.set_meta("account_uin", "100000000")
    print(f"已写入 {db_path}")
    print(f"  群 {result['groups']} 个 · 成员关系 {result['members']} 条")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成演示数据（虚构，不含真实 QQ 数据）")
    parser.add_argument("--json", help="输出 JSON 备份的路径")
    parser.add_argument("--db", help="直接写入的数据库路径")
    parser.add_argument("--seed", type=int, default=20261018)
    parser.add_argument("--people", type=int, default=1800, help="虚构人数")
    args = parser.parse_args()

    if not args.json and not args.db:
        parser.error("至少指定 --json 或 --db 之一")

    payload = build(seed=args.seed, people_count=args.people)

    if args.json:
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已写入 {path}")
        print(f"  群 {len(payload['groups'])} 个 · 成员关系 {len(payload['members'])} 条")

    if args.db:
        write_db(payload, Path(args.db))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())