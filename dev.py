#!/usr/bin/env python3
"""Local dev server for Ward Wise Reports.

Serves the static files and proxies /api/* to the live Penlight API, which is
what Netlify's _redirects rule does in production. The Penlight API sends no
cross-origin header, so the browser cannot call it directly from another
origin; both environments therefore keep every request same-origin.

Standard library only. No venv, no pip install.

    python3 dev.py          # http://localhost:1838
    PORT=9000 python3 dev.py
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

API_BASE = os.environ.get("PENLIGHT_API_BASE", "https://penlight.wardwise.org").rstrip("/")
PORT = int(os.environ.get("PORT", "1838"))  # 1837 is Penlight's; this sits next to it
ROOT = Path(__file__).parent.resolve()

# Headers that describe the hop rather than the payload. Forwarding them would
# corrupt the response we re-send.
HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self.path.startswith("/api/"):
            self.proxy()
        else:
            super().do_GET()

    def do_POST(self):  # noqa: N802
        # Penlight's map view POSTs analytics on every metric toggle. This app
        # does not write, so acknowledge without forwarding anything upstream.
        self.send_response(204)
        self.end_headers()

    def proxy(self):
        url = API_BASE + self.path
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as upstream:
                body = upstream.read()
                self.send_response(upstream.status)
                for key, value in upstream.headers.items():
                    if key.lower() not in HOP_BY_HOP:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", err.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:  # network down, DNS, timeout
            message = f'{{"error": "proxy to {API_BASE} failed: {err}"}}'.encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def end_headers(self):
        # Nothing here is worth caching during development.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    print(f"Ward Wise Reports  ->  http://localhost:{PORT}")
    print(f"proxying /api/*    ->  {API_BASE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        server.server_close()


if __name__ == "__main__":
    main()
