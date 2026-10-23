#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""弹幕获取服务（FastAPI, 默认端口 7864）

第一阶段适配抖音直播（匿名 ttwid / 自带小号 Cookie 两种模式），
事件协议为多平台预留：{platform, type, userId, nickname, text, giftName, count, ts}。

核心抓取逻辑借鉴 saermart/DouyinLiveWebFetcher（签名 sign.js + betterproto 生成的 douyin_proto.py
均为上游仓库文件，随抖音风控变更需同步更新）。
"""

import argparse
import codecs
import gzip
import hashlib
import random
import re
import string
import threading
import time
import urllib.parse
from collections import deque

import requests
import uvicorn
import websocket
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from py_mini_racer import MiniRacer

import douyin_proto as pb

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")


def ts() -> str:
    return time.strftime("[%H:%M:%S]")


def log(msg: str):
    print(f"{ts()} {msg}", flush=True)


def generate_ms_token(length: int = 182) -> str:
    base = string.ascii_letters + string.digits + "-_"
    return "".join(random.choice(base) for _ in range(length))


class Signer:
    """MiniRacer 常驻上下文执行上游 sign.js，生成 WebSocket signature。"""

    PARAM_KEYS = ("live_id,aid,version_code,webcast_sdk_version,"
                  "room_id,sub_room_id,sub_channel_id,did_rule,"
                  "user_unique_id,device_platform,device_type,ac,"
                  "identity").split(",")

    def __init__(self, script_file: str):
        with codecs.open(script_file, "r", encoding="utf8") as f:
            script = f.read()
        self._lock = threading.Lock()
        self._ctx = MiniRacer()
        self._ctx.eval(script)

    def sign(self, wss_url: str) -> str:
        query = urllib.parse.urlparse(wss_url).query.split("&")
        wss_map = {i.split("=")[0]: i.split("=")[-1] for i in query}
        param = ",".join(f"{k}={wss_map.get(k, '')}" for k in self.PARAM_KEYS)
        md5_param = hashlib.md5(param.encode()).hexdigest()
        with self._lock:
            return self._ctx.call("get_sign", md5_param)


class EventBuffer:
    """线程安全游标环形缓冲，供控制台轮询。"""

    def __init__(self, capacity: int = 500):
        self._items = deque(maxlen=capacity)
        self._seq = 0
        self._lock = threading.Lock()

    def push(self, event: dict):
        with self._lock:
            self._seq += 1
            event["seq"] = self._seq
            self._items.append(event)

    def since(self, cursor: int, limit: int = 100):
        with self._lock:
            events = [e for e in self._items if e["seq"] > cursor][:limit]
            return self._seq, events


class DouyinFetcher:
    """抖音直播间弹幕抓取（WebSocket + protobuf + MiniRacer 签名）。"""

    def __init__(self, live_id: str, signer: Signer, buffer: EventBuffer,
                 cookie: str = "", on_state=None):
        self.live_id = live_id
        self.signer = signer
        self.buffer = buffer
        self.extra_cookie = cookie.strip()
        self.on_state = on_state or (lambda **kw: None)
        self.session = requests.Session()
        self._ttwid = None
        self._room_id = None
        self._stop = threading.Event()
        self.ws = None
        self.hb_thread = None

    # ---------- 身份 ----------
    @property
    def ttwid(self):
        if self._ttwid:
            return self._ttwid
        resp = self.session.get("https://live.douyin.com/",
                                headers={"User-Agent": UA}, timeout=15)
        resp.raise_for_status()
        self._ttwid = resp.cookies.get("ttwid")
        if not self._ttwid:
            raise RuntimeError("未能获取匿名 ttwid，可能被风控，请稍后再试")
        return self._ttwid

    @property
    def room_id(self):
        if self._room_id:
            return self._room_id
        cookie = f"ttwid={self.ttwid}&msToken={generate_ms_token()}"
        if self.extra_cookie:
            cookie += ";" + self.extra_cookie
        resp = self.session.get(
            "https://live.douyin.com/" + self.live_id,
            headers={"User-Agent": UA, "cookie": cookie}, timeout=15)
        resp.raise_for_status()
        match = re.search(r'roomId\\":\\"(\d+)\\"', resp.text)
        if not match:
            raise RuntimeError("直播间未开播或不存在（请确认房间正在直播且 ID 正确）")
        self._room_id = match.group(1)
        return self._room_id

    # ---------- 生命周期 ----------
    def run(self):
        backoff = 3
        while not self._stop.is_set():
            try:
                self._connect()
                backoff = 3
            except Exception as exc:
                if self._stop.is_set():
                    break
                log(f"[danmu] 连接异常: {exc}，{backoff}s 后重连")
                self.on_state(state="reconnecting", detail=str(exc))
                self.buffer.push({"platform": "douyin", "type": "system",
                                  "text": f"连接断开，{backoff}s 后重连: {exc}", "ts": int(time.time() * 1000)})
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 60)
        self.on_state(state="stopped", detail="")
        log("[danmu] 抓取线程退出")

    def stop(self):
        self._stop.set()
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass

    # ---------- WebSocket ----------
    def _connect(self):
        room_id = self.room_id
        now_ms = int(time.time() * 1000)
        wss = ("wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?app_name=douyin_web"
               "&version_code=180800&webcast_sdk_version=1.0.14-beta.0"
               "&update_version_code=1.0.14-beta.0&compress=gzip&device_platform=web&cookie_enabled=true"
               "&screen_width=1536&screen_height=864&browser_language=zh-CN&browser_platform=Win32"
               "&browser_name=Mozilla"
               "&browser_version=5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,"
               "%20like%20Gecko)%20Chrome/126.0.0.0%20Safari/537.36"
               "&browser_online=true&tz_name=Asia/Shanghai"
               f"&cursor=t-{now_ms}_r-1_d-1_u-1_h-1"
               f"&internal_ext=internal_src:dim|wss_push_room_id:{room_id}|wss_push_did:{room_id}"
               f"|first_req_ms:{now_ms}|fetch_time:{now_ms}|seq:1|wss_info:0-{now_ms}-0-0|"
               "&host=https://live.douyin.com&aid=6383&live_id=1&did_rule=3&endpoint=live_pc&support_wrds=1"
               f"&user_unique_id={room_id}&im_path=/webcast/im/fetch/&identity=audience"
               f"&need_persist_msg_count=15&insert_task_id=&live_reason=&room_id={room_id}&heartbeatDuration=0")
        signature = self.signer.sign(wss)
        wss += f"&signature={signature}"

        cookie = f"ttwid={self.ttwid}"
        if self.extra_cookie:
            cookie += ";" + self.extra_cookie
        self.ws = websocket.WebSocketApp(
            wss,
            header={"cookie": cookie, "user-agent": UA},
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close)
        self.ws.run_forever(ping_interval=0)
        if not self._stop.is_set():
            raise RuntimeError("WebSocket 意外断开")

    def _on_open(self, ws):
        log(f"[danmu] WebSocket 已连接 room_id={self._room_id}")
        self.on_state(state="connected", detail=f"room_id={self._room_id}")
        self.buffer.push({"platform": "douyin", "type": "system",
                          "text": f"已连接直播间（room_id={self._room_id}）", "ts": int(time.time() * 1000)})
        self.hb_thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.hb_thread.start()

    def _heartbeat(self):
        while not self._stop.is_set():
            try:
                frame = pb.PushFrame(payload_type="hb").SerializeToString()
                self.ws.send(frame, websocket.ABNF.OPCODE_PING)
            except Exception:
                break
            self._stop.wait(5)

    def _on_message(self, ws, message):
        try:
            package = pb.PushFrame().parse(message)
            response = pb.Response().parse(gzip.decompress(package.payload))
            if response.need_ack:
                ack = pb.PushFrame(log_id=package.log_id, payload_type="ack",
                                   payload=response.internal_ext.encode("utf-8")).SerializeToString()
                ws.send(ack, websocket.ABNF.OPCODE_BINARY)
            for msg in response.messages_list:
                self._dispatch(msg.method, msg.payload)
        except Exception as exc:
            log(f"[danmu] 消息解析异常: {exc}")

    def _on_error(self, ws, error):
        log(f"[danmu] WebSocket 错误: {error}")

    def _on_close(self, ws, *args):
        log("[danmu] WebSocket 已关闭")

    # ---------- 消息分发 ----------
    def _emit(self, type_, **fields):
        event = {"platform": "douyin", "type": type_, "ts": int(time.time() * 1000)}
        event.update(fields)
        self.buffer.push(event)

    def _dispatch(self, method, payload):
        try:
            if method == "WebcastChatMessage":
                m = pb.ChatMessage().parse(payload)
                self._emit("chat", userId=str(m.user.id), nickname=m.user.nick_name, text=m.content)
            elif method == "WebcastGiftMessage":
                m = pb.GiftMessage().parse(payload)
                self._emit("gift", userId=str(m.user.id), nickname=m.user.nick_name,
                           giftName=m.gift.name, count=m.combo_count,
                           text=f"送出 {m.gift.name} x{m.combo_count}")
            elif method == "WebcastLikeMessage":
                m = pb.LikeMessage().parse(payload)
                self._emit("like", userId=str(m.user.id), nickname=m.user.nick_name,
                           count=m.count, text=f"点了 {m.count} 个赞")
            elif method == "WebcastMemberMessage":
                m = pb.MemberMessage().parse(payload)
                self._emit("enter", userId=str(m.user.id), nickname=m.user.nick_name,
                           text="进入直播间")
            elif method == "WebcastSocialMessage":
                m = pb.SocialMessage().parse(payload)
                self._emit("follow", userId=str(m.user.id), nickname=m.user.nick_name,
                           text="关注了主播")
            elif method == "WebcastRoomUserSeqMessage":
                m = pb.RoomUserSeqMessage().parse(payload)
                self.on_state(viewers=m.total)
            elif method == "WebcastControlMessage":
                m = pb.ControlMessage().parse(payload)
                if m.status == 3:
                    self._emit("system", text="直播间已结束")
                    self.on_state(state="ended", detail="直播间已结束")
                    self.stop()
        except Exception:
            pass


# ================= FastAPI 服务 =================

ARGS = None
app = FastAPI(title="Danmu Service")
SIGNER = None
BUFFER = EventBuffer()
STATE = {
    "state": "idle",        # idle / connecting / connected / reconnecting / ended / stopped / error
    "liveId": None,
    "roomId": None,
    "mode": "anonymous",
    "viewers": None,
    "detail": "",
    "connectedAt": None,
    "chatCount": 0,
}
_fetcher = None
_thread = None
_state_lock = threading.Lock()


def set_state(**kw):
    with _state_lock:
        STATE.update(kw)
        if STATE.get("state") == "connected" and not STATE.get("connectedAt"):
            STATE["connectedAt"] = int(time.time())


class ConnectReq(BaseModel):
    liveId: str
    mode: str = "anonymous"   # anonymous / cookie
    cookie: str = ""


def parse_live_id(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(400, "请输入直播间 ID 或链接")
    m = re.search(r"live\.douyin\.com/(\d+)", raw)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d{5,20}", raw):
        return raw
    raise HTTPException(400, f"无法从输入解析直播间 ID: {raw}")


@app.get("/health")
def health():
    return {"ok": True, **{k: STATE[k] for k in STATE}}


@app.post("/connect")
def connect(req: ConnectReq):
    global _fetcher, _thread
    live_id = parse_live_id(req.liveId)
    if _thread and _thread.is_alive():
        if STATE.get("liveId") == live_id:
            return {"ok": True, "detail": "已在连接中", "liveId": live_id}
        raise HTTPException(409, "已有连接在进行，请先断开")

    cookie = req.cookie.strip() if req.mode == "cookie" else ""
    fetcher = DouyinFetcher(live_id, SIGNER, BUFFER, cookie=cookie, on_state=set_state)
    set_state(state="connecting", liveId=live_id, roomId=None, mode=req.mode,
              viewers=None, detail="", connectedAt=None, chatCount=0)
    BUFFER.push({"platform": "douyin", "type": "system",
                 "text": f"正在连接直播间 {live_id}（{'登录小号' if cookie else '匿名只读'}模式）…",
                 "ts": int(time.time() * 1000)})

    def runner():
        try:
            fetcher.run()
        except Exception as exc:
            set_state(state="error", detail=str(exc))

    _fetcher = fetcher
    _thread = threading.Thread(target=runner, daemon=True)
    _thread.start()
    return {"ok": True, "liveId": live_id}


@app.post("/disconnect")
def disconnect():
    global _fetcher
    if not _fetcher:
        return {"ok": True, "detail": "当前无连接"}
    _fetcher.stop()
    _fetcher = None
    set_state(state="stopped", detail="手动断开", connectedAt=None)
    return {"ok": True}


class MockReq(BaseModel):
    text: str = "主播你好，唱首歌吧"
    nickname: str = "测试观众"
    type: str = "chat"


@app.post("/mock")
def mock(req: MockReq):
    """测试模式：不连真实直播间，直接注入一条模拟弹幕事件。"""
    BUFFER.push({"platform": "douyin", "type": req.type, "userId": "mock-user",
                 "nickname": req.nickname, "text": req.text,
                 "giftName": None, "count": 1, "ts": int(time.time() * 1000)})
    return {"ok": True}


@app.get("/events")
def events(cursor: int = 0, limit: int = 100):
    seq, items = BUFFER.since(cursor, min(limit, 200))
    chats = sum(1 for e in items if e.get("type") == "chat")
    if chats:
        set_state(chatCount=(STATE.get("chatCount") or 0) + chats)
    return {"ok": True, "cursor": seq, "events": items, "state": STATE}


def main():
    global ARGS, SIGNER
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7864)
    parser.add_argument("--sign", default="sign.js")
    ARGS = parser.parse_args()
    SIGNER = Signer(ARGS.sign)
    log(f"[danmu] 签名引擎就绪，服务启动 port={ARGS.port}")
    uvicorn.run(app, host="127.0.0.1", port=ARGS.port, log_level="warning")


if __name__ == "__main__":
    main()
