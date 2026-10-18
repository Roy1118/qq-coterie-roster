"""qun.qq.com 群列表 / 群成员接口。"""

from __future__ import annotations

import json
from html import unescape
from typing import Any
from urllib.parse import urlencode

from .auth import QunSession

ORIGIN = "https://qun.qq.com"


class QunApiError(RuntimeError):
    def __init__(self, message: str, payload: Any = None) -> None:
        super().__init__(message)
        self.payload = payload


def _json_or_error(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8", "replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise QunApiError(f"响应不是 JSON: {text[:200]}", text) from exc
    if not isinstance(data, dict):
        raise QunApiError("响应不是对象", data)
    return data


def _check_ec(data: dict[str, Any], what: str) -> dict[str, Any]:
    ec = data.get("ec", data.get("retcode", 0))
    if ec not in (0, None, ""):
        em = data.get("em") or data.get("msg") or ""
        if ec == 4:
            raise QunApiError("QQ 会话已过期，请重新扫码登录", data)
        if ec == 7:
            raise QunApiError("当前登录号不在这个群，或没有权限拉成员", data)
        raise QunApiError(f"{what} 失败 ec={ec} {em}", data)
    return data


def _clean(text: Any) -> str:
    return unescape(str(text or "")).replace("\xa0", " ").replace("&nbsp;", " ").strip()


class QunClient:
    def __init__(self, session: QunSession) -> None:
        self.session = session

    def _headers(self, form: bool = False) -> dict[str, str]:
        h = {
            "Origin": ORIGIN,
            "Referer": f"{ORIGIN}/member.html",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
        }
        if form:
            h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        return h

    def myinfo(self) -> dict[str, Any]:
        url = f"{ORIGIN}/cgi-bin/qunwelcome/myinfo?bkn={self.session.bkn}"
        _, _, body = self.session.request(url, headers=self._headers())
        return _json_or_error(body)

    def group_list(self) -> dict[str, list[dict[str, Any]]]:
        payload = urlencode({"bkn": self.session.bkn}).encode()
        _, _, body = self.session.request(
            f"{ORIGIN}/cgi-bin/qun_mgr/get_group_list",
            data=payload,
            headers=self._headers(form=True),
        )
        data = _check_ec(_json_or_error(body), "get_group_list")
        return {
            "join": data.get("join") or [],
            "create": data.get("create") or [],
            "manage": data.get("manage") or [],
        }

    def members_info_v1(self, group_id: int | str) -> dict[str, Any]:
        """任意已加入群可用，不要求管理员。"""
        qs = urlencode({"gc": str(group_id), "friends": 1, "name": 1, "bkn": self.session.bkn})
        url = f"{ORIGIN}/cgi-bin/qun_info/get_members_info_v1?{qs}"
        _, _, body = self.session.request(url, headers=self._headers())
        return _check_ec(_json_or_error(body), "get_members_info_v1")

    def search_group_members(self, group_id: int | str, start: int = 0, end: int = 20) -> dict[str, Any]:
        """仅群主/管理员。普通成员返回 ec=7 require admin。"""
        payload = urlencode(
            {"gc": str(group_id), "st": start, "end": end, "sort": 0, "bkn": self.session.bkn}
        ).encode()
        _, _, body = self.session.request(
            f"{ORIGIN}/cgi-bin/qun_mgr/search_group_members",
            data=payload,
            headers=self._headers(form=True),
        )
        return _json_or_error(body)

    def fetch_members(self, group_id: int | str, group_name: str = "") -> dict[str, Any]:
        raw = self.members_info_v1(group_id)
        owner = str(raw.get("owner") or "")
        members_raw = raw.get("members") or {}
        if isinstance(members_raw, list):
            items = [(str(item.get("uin") or item.get("u") or ""), item) for item in members_raw]
        else:
            items = list(members_raw.items())

        members = []
        for uin, item in items:
            if not isinstance(item, dict) or not uin:
                continue
            uin = str(uin)
            rm = int(item.get("rm") or 0)
            members.append(
                {
                    "uin": uin,
                    "nick": _clean(item.get("nk")),
                    "card": _clean(item.get("cd")),
                    "join_time": int(item.get("jt") or 0),
                    "last_speak_time": int(item.get("lst") or 0),
                    "level": int(item.get("ll") or 0),
                    "last_active_day": int(item.get("lad") or 0),
                    "is_friend": bool(item.get("fr")),
                    "is_owner": uin == owner,
                    "is_admin": bool(rm) and uin != owner,
                    "rm": rm,
                    "lp": item.get("lp"),
                }
            )
        members.sort(key=lambda m: (not m["is_owner"], not m["is_admin"], m["uin"]))
        return {
            "group_id": str(group_id),
            "group_name": _clean(group_name),
            "owner": owner,
            "mem_num": int(raw.get("mem_num") or len(members)),
            "max_num": int(raw.get("max_num") or 0),
            "exported": len(members),
            "members": members,
        }
