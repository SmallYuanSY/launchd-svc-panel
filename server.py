#!/usr/bin/env python3
"""Hermes 服務控制台 — 後端 (Python 標準庫,零依賴)。

唯一會碰系統的人:讀 services.json,透過 launchctl 查詢/控制使用者層
LaunchAgent,做健康探測,並回傳 log 尾部。僅綁 127.0.0.1。

除錯入口請見同目錄 CLAUDE.md。
"""
import json
import os
import re
import shlex
import socket
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "services.json")
STATIC_DIR = os.path.join(HERE, "static")

with open(CONFIG_PATH, encoding="utf-8") as fh:
    CONFIG = json.load(fh)

PANEL = CONFIG["panel"]
SERVICES = CONFIG["services"]
BY_NAME = {s["name"]: s for s in SERVICES}
# 自動取目前使用者的 UID,不寫死(換機/換使用者皆可用)
DOMAIN = f"gui/{os.getuid()}"
VALID_ACTIONS = {"start", "stop", "restart"}


def _path(p):
    """展開 ~ 與 $ENV,讓 services.json 可用可攜路徑而非寫死絕對路徑。"""
    return os.path.expanduser(os.path.expandvars(p)) if p else p


# --------------------------------------------------------------------------- #
# launchctl 互動
# --------------------------------------------------------------------------- #
def _run(args, timeout=10):
    """跑一個外部指令,回 (returncode, stdout, stderr)。args 必為 list,不過 shell。"""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as exc:  # noqa: BLE001
        return 1, "", str(exc)


def launchctl_state(label):
    """回 (state, pid)。未載入回 ('stopped', None)。"""
    rc, out, _ = _run(["launchctl", "print", f"{DOMAIN}/{label}"])
    if rc != 0:
        return "stopped", None
    m_state = re.search(r"state\s*=\s*(\S+)", out)
    m_pid = re.search(r"\bpid\s*=\s*(\d+)", out)
    pid = int(m_pid.group(1)) if m_pid else None
    state = m_state.group(1) if m_state else ("running" if pid else "loaded")
    if pid:
        state = "running"
    elif state == "running":  # state 說 running 但沒 pid → 視為載入未跑
        state = "loaded"
    return state, pid


def process_uptime(pid):
    """用 ps 取得行程已運行時間 (etime 字串,如 01:23:45)。"""
    if not pid:
        return None
    rc, out, _ = _run(["ps", "-o", "etime=", "-p", str(pid)])
    return out.strip() if rc == 0 and out.strip() else None


def do_action(svc, action):
    """對單一服務執行 start/stop/restart。回 (ok, message)。"""
    if svc.get("readonly"):
        return False, "此服務唯讀,請改用 ./panelctl 控制"
    label, plist = svc["label"], _path(svc["plist"])
    if action == "start":
        rc, _, err = _run(["launchctl", "bootstrap", DOMAIN, plist])
        # 已載入時 bootstrap 會報錯;改用 kickstart 確保它在跑
        if rc != 0:
            rc, _, err = _run(["launchctl", "kickstart", f"{DOMAIN}/{label}"])
        return rc == 0, err or "started"
    if action == "stop":
        rc, _, err = _run(["launchctl", "bootout", f"{DOMAIN}/{label}"])
        return rc == 0, err or "stopped"
    if action == "restart":
        rc, _, err = _run(["launchctl", "kickstart", "-k", f"{DOMAIN}/{label}"])
        # 沒載入時 kickstart 失敗 → 先 bootstrap 起來
        if rc != 0:
            rc, _, err = _run(["launchctl", "bootstrap", DOMAIN, plist])
        return rc == 0, err or "restarted"
    return False, "unknown action"


# --------------------------------------------------------------------------- #
# 健康檢查
# --------------------------------------------------------------------------- #
def health_check(svc):
    """回 'ok' / 'down' / 'n/a'。探測失敗不拋例外。"""
    h = svc.get("health") or {}
    kind = h.get("kind")
    try:
        if kind == "tcp":
            with socket.create_connection((h["host"], h["port"]), timeout=2):
                return "ok"
        if kind == "http":
            req = urllib.request.Request(h["url"], method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                return "ok" if resp.status < 500 else "down"
        if kind == "cloudflared":
            # 讀 prometheus metrics,看 HA 連線數 > 0
            with urllib.request.urlopen(h["url"], timeout=3) as resp:
                body = resp.read().decode("utf-8", "replace")
            for line in body.splitlines():
                if line.startswith("cloudflared_tunnel_ha_connections"):
                    try:
                        if float(line.rsplit(None, 1)[1]) > 0:
                            return "ok"
                    except (ValueError, IndexError):
                        pass
            return "down"
    except Exception:  # noqa: BLE001
        return "down"
    return "n/a"


def tail_file(path, lines):
    """回檔案最後 N 行。"""
    if not path or not os.path.exists(path):
        return f"(log 不存在: {path})"
    rc, out, _ = _run(["tail", "-n", str(lines), path])
    return out if rc == 0 else f"(讀取失敗: {path})"


# --------------------------------------------------------------------------- #
# 組裝狀態
# --------------------------------------------------------------------------- #
def status_payload():
    rows = []
    for svc in SERVICES:
        state, pid = launchctl_state(svc["label"])
        rows.append(
            {
                "name": svc["name"],
                "desc": svc.get("desc", ""),
                "label": svc["label"],
                "state": state,
                "pid": pid,
                "uptime": process_uptime(pid),
                "health": health_check(svc),
                "readonly": bool(svc.get("readonly")),
            }
        )
    return {"services": rows}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "HermesSvcPanel/1.0"

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, rel):
        rel = rel.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/ping":
            return self._send(200, {"ok": True})
        if u.path == "/api/status":
            return self._send(200, status_payload())
        if u.path == "/api/logs":
            q = parse_qs(u.query)
            name = (q.get("name") or [""])[0]
            lines = min(int((q.get("lines") or ["200"])[0] or 200), 1000)
            svc = BY_NAME.get(name)
            if not svc:
                return self._send(404, {"error": "unknown service"})
            return self._send(200, {"name": name, "log": tail_file(_path(svc["logs"]["out"]), lines)})
        if u.path == "/" or u.path.startswith("/static/") or u.path == "/index.html":
            return self._serve_static(u.path.replace("/static/", "/", 1))
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/action":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or "{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        name, action = payload.get("name"), payload.get("action")
        svc = BY_NAME.get(name)
        if not svc:
            return self._send(404, {"error": "unknown service"})
        if action not in VALID_ACTIONS:
            return self._send(400, {"error": "invalid action"})
        ok, msg = do_action(svc, action)
        return self._send(200 if ok else 409, {"ok": ok, "message": msg})

    def log_message(self, *args):  # 安靜:預設會把每個請求印到 stderr
        return


def main():
    host, port = PANEL["host"], PANEL["port"]
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Hermes 服務控制台 → http://{host}:{port}  (管 {len(SERVICES)} 個服務)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
