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
    def __init__(self, port=9333, window="1500,950"):
        self.process = subprocess.Popen(
            # SwiftShader gives headless Chrome a working WebGL2, which the splat renderer needs.
            [CHROME, "--headless=new", "--hide-scrollbars",
             "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
             f"--remote-debugging-port={port}", f"--window-size={window}",
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--wait", type=float, default=4, help="seconds of real time to let it run")
    ap.add_argument("--shot", default=None)
    ap.add_argument("--eval", action="append", default=[], help="JavaScript to run at the end")
    ap.add_argument("--window", default="1500,950")
    ap.add_argument("--script", default=None, help="file of JavaScript to run before --eval")
    args = ap.parse_args()

    chrome = Chrome(window=args.window)
    try:
        chrome.call("Page.enable")
        chrome.call("Runtime.enable")
        chrome.call("Page.navigate", url=args.url)
        time.sleep(args.wait)
        if args.script:
            with open(args.script) as f:
                chrome.call("Runtime.evaluate", expression=f.read(), awaitPromise=True,
                            returnByValue=True)
        for expression in args.eval:
            result = chrome.call("Runtime.evaluate", expression=expression, awaitPromise=True,
                                 returnByValue=True)
            value = result.get("result", {}).get("value")
            print(json.dumps(value, indent=1) if isinstance(value, (dict, list)) else value)
        if args.shot:
            shot = chrome.call("Page.captureScreenshot", format="png")
            with open(args.shot, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print(f"wrote {args.shot}")
    finally:
        chrome.close()


if __name__ == "__main__":
    main()
