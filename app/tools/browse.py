#!/usr/bin/env python3
"""
Drive a headless Chrome over the DevTools protocol: load a page, let it run in real time,
run some JavaScript in it, and save a screenshot.

Needed because Chrome's --virtual-time-budget screenshots never let a WebSocket finish
connecting, so the viewer looks dead in a plain --screenshot run.

  python3 tools/browse.py "http://localhost:8080/viewer?image=portrait.jpg" \
      --wait 4 --shot /tmp/viewer.png --eval "panelSnapshot()"

Only the standard library: the DevTools protocol is itself a WebSocket, spoken here directly.
"""

import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import time
import urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class Socket:
    """The few WebSocket bits needed to talk to Chrome."""

    def __init__(self, url):
        _, _, rest = url.partition("://")
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
        self.buffer = b""
        while b"\r\n\r\n" not in self.buffer:
            self.buffer += self.sock.recv(4096)
        self.buffer = self.buffer.split(b"\r\n\r\n", 1)[1]

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            header = bytes([0x81, 0x80 | n])
        elif n < 1 << 16:
            header = bytes([0x81, 0xFE]) + struct.pack(">H", n)
        else:
            header = bytes([0x81, 0xFF]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + masked)

    def receive(self):
        while True:
            frame = self._frame()
            if frame is not None:
                return frame

    def _frame(self):
        while len(self.buffer) < 2:
            self._fill()
        length = self.buffer[1] & 0x7F
        at = 2
        if length == 126:
            while len(self.buffer) < 4:
                self._fill()
            length = struct.unpack(">H", self.buffer[2:4])[0]
            at = 4
        elif length == 127:
            while len(self.buffer) < 10:
                self._fill()
            length = struct.unpack(">Q", self.buffer[2:10])[0]
            at = 10
        while len(self.buffer) < at + length:
            self._fill()
        payload = self.buffer[at:at + length]
        opcode = self.buffer[0] & 0x0F
        self.buffer = self.buffer[at + length:]
        return payload.decode() if opcode in (1, 2) else None

    def _fill(self):
        chunk = self.sock.recv(1 << 16)
        if not chunk:
            raise ConnectionError("chrome closed the devtools connection")
        self.buffer += chunk


class Chrome:
    def __init__(self, port=9333, window="1500,950", dpr=None, software_gl=True):
        # SwiftShader gives headless Chrome a working WebGL2, which the splat renderer needs -
        # but it holds hundreds of megabytes of its own, so any measurement of what the page
        # costs has to be taken with the real driver instead.
        gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] \
            if software_gl else []
        self.process = subprocess.Popen(
            [CHROME, "--headless=new", "--hide-scrollbars", *gl,
             f"--remote-debugging-port={port}", f"--window-size={window}",
             *( [f"--force-device-scale-factor={dpr}"] if dpr else [] ),
             "--no-first-run", "--user-data-dir=/tmp/p2-chrome", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                target = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.1)
        if target is None:
            raise RuntimeError("chrome did not start")
        self.ws = Socket(target["webSocketDebuggerUrl"])
        self.id = 0

    def call(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params}))
        while True:
            message = json.loads(self.ws.receive())
            if message.get("id") == self.id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})

    def close(self):
        self.process.terminate()


def report_rss(chrome):
    """What the browser's processes are holding right now, as the task manager would show."""
    out = subprocess.run(["ps", "-Ao", "rss,command"], capture_output=True, text=True).stdout
    rows, total = [], 0
    for line in out.splitlines():
        if "/tmp/p2-chrome" not in line:
            continue
        rss = int(line.split()[0]) * 1024
        total += rss
        kind = ("renderer" if "--type=renderer" in line else
                "gpu" if "--type=gpu-process" in line else
                "utility" if "--type=utility" in line else "browser")
        rows.append((kind, rss))
    rows.sort(key=lambda r: -r[1])
    print("   " + "  ".join(f"{k} {v / 1e6:.0f}" for k, v in rows if k in ("renderer", "gpu"))
          + f"  ·  all {total / 1e6:.0f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--wait", type=float, default=4, help="seconds of real time to let it run")
    ap.add_argument("--shot", default=None)
    ap.add_argument("--eval", action="append", default=[], help="JavaScript to run at the end")
    ap.add_argument("--window", default="1500,950")
    ap.add_argument("--dpr", default=None, help="pretend to be a screen of this pixel ratio")
    ap.add_argument("--resize", default=None, help="W,H to resize the viewport to, after --wait")
    ap.add_argument("--rss", action="store_true", help="report what the browser's processes hold")
    ap.add_argument("--real-gl", action="store_true", help="use the machine's own driver")
    ap.add_argument("--script", default=None, help="file of JavaScript to run before --eval")
    args = ap.parse_args()

    chrome = Chrome(window=args.window, dpr=args.dpr, software_gl=not args.real_gl)
    try:
        chrome.call("Page.enable")
        chrome.call("Runtime.enable")
        chrome.call("Page.navigate", url=args.url)
        time.sleep(args.wait)
        if args.resize:
            w, h = (int(v) for v in args.resize.split(","))
            chrome.call("Emulation.setDeviceMetricsOverride", width=w, height=h,
                        deviceScaleFactor=float(args.dpr or 0), mobile=False)
            time.sleep(1.5)
        if args.script:
            with open(args.script) as f:
                chrome.call("Runtime.evaluate", expression=f.read(), awaitPromise=True,
                            returnByValue=True)
        for expression in args.eval:
            result = chrome.call("Runtime.evaluate", expression=expression, awaitPromise=True,
                                 returnByValue=True)
            value = result.get("result", {}).get("value")
            print(json.dumps(value, indent=1) if isinstance(value, (dict, list)) else value)
            if args.rss:
                report_rss(chrome)
        if args.rss and False:
            metrics = {m["name"]: m["value"] for m in
                       chrome.call("Performance.getMetrics").get("metrics", [])}
            print(f"js heap    {metrics.get('JSHeapUsedSize', 0) / 1e6:8.1f} MB used, "
                  f"{metrics.get('JSHeapTotalSize', 0) / 1e6:.1f} MB reserved")
            print(f"documents  {metrics.get('Documents', 0):.0f}, "
                  f"nodes {metrics.get('Nodes', 0):.0f}, listeners {metrics.get('JSEventListeners', 0):.0f}")
            out = subprocess.run(["ps", "-Ao", "rss,command"], capture_output=True, text=True).stdout
            total = 0
            for line in out.splitlines():
                if "/tmp/p2-chrome" not in line:
                    continue
                rss = int(line.split()[0]) * 1024
                total += rss
                kind = "renderer" if "--type=renderer" in line else (
                    "gpu" if "--type=gpu-process" in line else (
                        "utility" if "--type=utility" in line else "browser"))
                if rss > 40_000_000 or kind in ("renderer", "gpu"):
                    print(f"{kind:10} {rss / 1e6:8.1f} MB")
            print(f"{'all chrome':10} {total / 1e6:8.1f} MB")
        if args.shot:
            shot = chrome.call("Page.captureScreenshot", format="png")
            with open(args.shot, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print(f"wrote {args.shot}")
    finally:
        chrome.close()


if __name__ == "__main__":
    main()
