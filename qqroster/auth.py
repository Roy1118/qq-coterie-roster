"""qun.qq.com 扫码登录与 Cookie 会话。

协议参考：ptlogin2 扫码（appid=715030901 / daid=73），成功后拿到
uin / skey（或 p_skey），再用 GTK 算法算 bkn。
"""

from __future__ import annotations

import random
import re
import time
from http.cookiejar import Cookie, CookieJar
from typing import Optional
from urllib.error import HTTPError
from urllib.parse import quote, unquote
from urllib.request import HTTPCookieProcessor, Request, build_opener

APPID = "715030901"
DAID = "73"
S_URL = "https://qun.qq.com/member.html"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def gtk(key: str) -> int:
    """QQ 通用 GTK / bkn：hash = 5381; hash += (hash << 5) + ord(c)."""
    h = 5381
    for ch in key:
        h += (h << 5) + ord(ch)
    return h & 0x7FFFFFFF


def hash33(key: str) -> int:
    """ptqrtoken：从 0 累加，和 skey 的 GTK(5381) 不同。"""
    h = 0
    for ch in key:
        h += (h << 5) + ord(ch)
    return h & 0x7FFFFFFF


def parse_cookie_header(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        out[name.strip()] = value.strip()
    return out


class QunSession:
    """带 Cookie 的 HTTP 会话，只在需要时访问腾讯域名。"""

    def __init__(self) -> None:
        self.jar = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.jar))

    def request(
        self,
        url: str,
        data: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
        method: Optional[str] = None,
    ) -> tuple[int, dict[str, str], bytes]:
        hdrs = {"User-Agent": UA, "Referer": "https://qun.qq.com/member.html"}
        if headers:
            hdrs.update(headers)
        cookie = self.cookie_header()
        if cookie and "Cookie" not in hdrs:
            hdrs["Cookie"] = cookie
        req = Request(url, data=data, headers=hdrs, method=method)
        try:
            with self.opener.open(req, timeout=30) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except HTTPError as exc:
            body = exc.read() if exc.fp else b""
            return exc.code, dict(exc.headers.items()) if exc.headers else {}, body

    def cookies_dict(self) -> dict[str, str]:
        return {c.name: c.value for c in self.jar}

    def cookie_header(self) -> str:
        return "; ".join(f"{name}={value}" for name, value in self.cookies_dict().items() if value)

    def set_cookies(self, mapping: dict[str, str], domain: str = ".qq.com") -> None:
        for name, value in mapping.items():
            cookie = Cookie(
                version=0,
                name=name,
                value=value,
                port=None,
                port_specified=False,
                domain=domain,
                domain_specified=True,
                domain_initial_dot=domain.startswith("."),
                path="/",
                path_specified=True,
                secure=False,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={},
                rfc2109=False,
            )
            self.jar.set_cookie(cookie)

    def load_cookie_header(self, raw: str) -> None:
        parsed = parse_cookie_header(raw)
        if not parsed:
            raise ValueError("Cookie 为空或格式不正确")
        for domain in (".qq.com", "qun.qq.com", ".ptlogin2.qq.com"):
            self.set_cookies(parsed, domain)

    @property
    def skey(self) -> str:
        cookies = self.cookies_dict()
        return unquote(cookies.get("skey") or cookies.get("p_skey") or "")

    @property
    def bkn(self) -> int:
        cookies = self.cookies_dict()
        key = cookies.get("skey") or cookies.get("p_skey") or ""
        return gtk(unquote(key))

    @property
    def uin(self) -> str:
        cookies = self.cookies_dict()
        raw = cookies.get("uin") or cookies.get("p_uin") or ""
        raw = unquote(raw)
        return raw.lstrip("o").lstrip("0") or raw

    def logged_in(self) -> bool:
        cookies = self.cookies_dict()
        return bool(cookies.get("skey") or cookies.get("p_skey"))


class QrLogin:
    def __init__(self, login_id: str, session: QunSession, image: bytes, xlogin: str) -> None:
        self.id = login_id
        self.session = session
        self.image = image
        self.xlogin = xlogin
        self.created = time.time()

    def poll(self) -> dict[str, str]:
        qrsig = self.session.cookies_dict().get("qrsig")
        if not qrsig:
            return {"status": "expired", "hint": "二维码丢失，请刷新"}
        if time.time() - self.created > 180:
            return {"status": "expired", "hint": "二维码已过期，请刷新"}
        login_sig = self.session.cookies_dict().get("pt_login_sig", "")
        action = f"0-0-{int(time.time() * 1000)}"
        query = (
            f"?u1={quote(S_URL, safe='')}"
            f"&ptqrtoken={hash33(qrsig)}&ptredirect=1&h=1&t=1&g=1&from_ui=1"
            f"&ptlang=2052&action={action}&js_ver=26071711&js_type=1"
            f"&login_sig={quote(login_sig, safe='')}"
            f"&pt_uistyle=40&aid={APPID}&daid={DAID}"
        )
        poll = "https://ssl.ptlogin2.qq.com/ptqrlogin" + query
        status, _, raw = self.session.request(
            poll,
            headers={"Referer": self.xlogin, "Accept": "*/*"},
        )
        if status >= 400:
            text = raw.decode("utf-8", "replace")
            return {"status": "error", "hint": f"扫码接口 {status}: {text[:160] or '无响应正文'}"}
        text = raw.decode("utf-8", "replace")
        match = re.search(r"ptuiCB\((.*)\)", text)
        if not match:
            return {"status": "error", "hint": f"无法解析扫码状态: {text[:160]}"}
        args = [x.strip().strip("'\"") for x in match.group(1).split(",")]
        code = args[0] if args else ""
        hint = args[4] if len(args) > 4 else text
        if code == "0":
            jump = args[2]
            self.session.request(jump)
            self.session.request(S_URL)
            return {"status": "ok", "hint": hint, "uin": self.session.uin}
        if code == "66":
            return {"status": "wait", "hint": "用手机 QQ 扫码"}
        if code == "67":
            return {"status": "scanned", "hint": "已扫码，请在手机上确认"}
        if code == "65":
            return {"status": "expired", "hint": "二维码已失效，请刷新"}
        return {"status": "wait", "hint": hint or "等待扫码"}


def start_qr_login() -> QrLogin:
    session = QunSession()
    xlogin = (
        "https://xui.ptlogin2.qq.com/cgi-bin/xlogin"
        f"?pt_disable_pwd=1&appid={APPID}&daid={DAID}"
        f"&hide_close_icon=1&pt_no_auth=1&s_url={quote(S_URL, safe='')}"
    )
    session.request(xlogin)
    show = (
        "https://ssl.ptlogin2.qq.com/ptqrshow"
        f"?appid={APPID}&e=2&l=M&s=3&d=72&v=4&t={random.random()}&daid={DAID}&pt_3rd_aid=0"
    )
    _, _, body = session.request(show)
    cookies = session.cookies_dict()
    if not cookies.get("qrsig"):
        raise RuntimeError("ptqrshow 未返回 qrsig，可能是网络或接口变动")
    pt_cookies = {key: cookies[key] for key in ("qrsig", "pt_login_sig") if cookies.get(key)}
    session.set_cookies(pt_cookies, domain=".ptlogin2.qq.com")
    login_id = f"{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
    return QrLogin(login_id, session, body, xlogin)
