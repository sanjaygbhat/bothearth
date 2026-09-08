#!/usr/bin/env python3
"""Fixture HTTP server for WP12 mcp-smoke (forced attachment download)."""
from __future__ import annotations

import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE = Path("/site")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/artifact.txt", "/download/artifact.txt"):
            data = (SITE / "artifact.txt").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header(
                "Content-Disposition",
                'attachment; filename="artifact.txt"',
            )
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def main() -> None:
    os.chdir(SITE)
    ThreadingHTTPServer(("0.0.0.0", 80), Handler).serve_forever()


if __name__ == "__main__":
    main()
