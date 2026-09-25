"""
A small HTTP server for the viewer, fitting units on demand.

  /                          the viewer
  /manifest.json             image size, tile, levels
  /splats/L/x_y.spx          one splat unit (levels >= split); fitted on first request
  /tiles/L/x_y               one image tile (levels < split), JPEG or lossless WebP

A unit asked for before it exists is fitted on the spot (with any coarser unit it rests on),
so only the part of the image someone actually looks at ever gets fitted. The response says
how long that took in X-Fit-Seconds.
"""

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .build import Store, read_manifest, write_manifest
from .pyramid import TILE_TYPES

VIEWER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "viewer")
UNIT = re.compile(r"^/splats/(\d+)/(\d+)_(\d+)\.spx$")
TILE = re.compile(r"^/tiles/(\d+)/(\d+)_(\d+)(?:\.(?:jpg|webp))?$")
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/viewer.js": ("viewer.js", "text/javascript; charset=utf-8")}


def serve(root, port=8080, lazy=True, log=print):
    store = Store(root)
    if read_manifest(root) is None:
        write_manifest(root, [])
    split = read_manifest(root).get("split", 0)
    pyr = store.pyr
    missing = sum(1 for L in range(split, pyr.max_level + 1)
                  for y in range(pyr.grid(L)[1]) for x in range(pyr.grid(L)[0])
                  if not store.has(L, x, y))
    if missing:
        log(f"warning: {missing} splat units are not fitted yet. They will be fitted one at a "
            f"time as the viewer asks, taking seconds each - run `build {root}` first.")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _send(self, code, body, ctype, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass        # the viewer gave up on this request (page reloaded or closed)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(VIEWER, name), "rb") as f:
                    return self._send(200, f.read(), ctype)
            if path == "/manifest.json":
                m = read_manifest(root)
                m["lazy"] = lazy
                return self._send(200, json.dumps(m).encode(), "application/json")
            split = read_manifest(root).get("split", 0)
            match = TILE.match(path)
            if match:
                level, x, y = map(int, match.groups())
                if level >= split or not store.pyr.exists(level, x, y):
                    return self._send(404, b"no such tile", "text/plain")
                store.ensure_tile(level, x, y)
                tile_path = store.tile_path(level, x, y)
                with open(tile_path, "rb") as f:
                    return self._send(200, f.read(), TILE_TYPES[tile_path.rsplit(".", 1)[1]])
            match = UNIT.match(path)
            if not match:
                return self._send(404, b"not found", "text/plain")
            level, x, y = map(int, match.groups())
            if level < split or not store.pyr.exists(level, x, y):
                return self._send(404, b"no such unit", "text/plain")
            extra = {}
            if not store.has(level, x, y):
                if not lazy:
                    return self._send(404, b"not fitted", "text/plain")
                t0 = time.time()
                try:
                    stats = store.ensure(level, x, y)
                except Exception as e:  # report instead of dropping the connection
                    log(f"fit {level}/{x}_{y} failed: {e!r}")
                    return self._send(500, str(e).encode(), "text/plain")
                extra["X-Fit-Seconds"] = f"{time.time() - t0:.2f}"
                if stats is None:       # another request fitted it while this one waited
                    log(f"waited {extra['X-Fit-Seconds']}s for {level}/{x}_{y} (fitted by another request)")
                else:
                    log(f"fitted {level}/{x}_{y} on demand in {extra['X-Fit-Seconds']}s")
            with open(store.path(level, x, y), "rb") as f:
                return self._send(200, f.read(), "application/octet-stream", extra)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log(f"serving {root} on http://127.0.0.1:{port}/ ({'fitting on demand' if lazy else 'fitted units only'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
