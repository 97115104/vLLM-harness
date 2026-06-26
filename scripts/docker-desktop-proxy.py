#!/usr/bin/env python3
"""Forward TCP (127.0.0.1) to Docker Desktop's backend Unix socket."""
from __future__ import annotations

import os
import socket
import sys
import threading

SOCKET_PATH = os.environ.get("DOCKER_DESKTOP_SOCKET", "")
HOST = os.environ.get("DOCKER_DESKTOP_PROXY_HOST", "0.0.0.0")
PORT = int(os.environ.get("DOCKER_DESKTOP_PROXY_PORT", "23760"))
BUF = 65536


def relay(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(BUF)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client: socket.socket) -> None:
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(SOCKET_PATH)
    except OSError:
        client.close()
        return

    t1 = threading.Thread(target=relay, args=(client, upstream), daemon=True)
    t2 = threading.Thread(target=relay, args=(upstream, client), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    client.close()
    upstream.close()


def main() -> int:
    if not SOCKET_PATH or not os.path.exists(SOCKET_PATH):
        print(f"Docker Desktop socket not found: {SOCKET_PATH}", file=sys.stderr)
        return 1

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, PORT))
    listener.listen(32)
    print(f"docker-desktop-proxy listening on {HOST}:{PORT} -> {SOCKET_PATH}", flush=True)

    while True:
        client, _ = listener.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    raise SystemExit(main())
