"""Local dev server for Voice Coach.

Like `python -m http.server`, but sends `Cache-Control: no-cache` so the
browser re-validates every file on each load and never runs a stale mix of
old and new modules. Serves the project root regardless of the working directory.

Usage:  python tools/serve.py [port]      (default 5317)
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5317
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
