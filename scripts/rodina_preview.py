#!/usr/bin/env python3
"""Local static preview; no API proxy and no production deployment."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, required=True, help='Handoff root containing public/')
parser.add_argument('--port', type=int, default=4377)
args = parser.parse_args()
public = args.root.resolve() / 'public'
if not public.is_dir():
    parser.error('public/ was not found')

class Preview(ThreadingHTTPServer):
    request_queue_size = 128

handler = partial(SimpleHTTPRequestHandler, directory=str(public))
with Preview(('127.0.0.1', args.port), handler) as server:
    print(f'Open http://127.0.0.1:{args.port}/rodina/', flush=True)
    server.serve_forever()
