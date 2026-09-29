"""Prepare the web application for Orca's HTML/message API at build time."""
import argparse
import base64
import gzip
import hashlib
import json
import re
import subprocess
from pathlib import Path


def bundle(source: Path, destination: Path, esbuild: str | None = None):
    command = ['node', str(Path(__file__).with_suffix('.mjs')), str(source)]
    if esbuild:
        command.append(esbuild)
    result = subprocess.run(command, check=True, capture_output=True, encoding='utf-8')
    compiled = json.loads(result.stdout)
    html = (source / 'index.html').read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet" href="style.css" />',
                        '<style>' + (source / 'style.css').read_text(encoding='utf-8') + '</style>')
    html = re.sub(r'<script type="module" src="js/main\.js[^"]*"></script>', '', html)
    html = html.replace('new URLSearchParams(window.location.search)',
                        'new URLSearchParams(globalThis.__ORCA_QUERY || window.location.search)')
    assets = {}
    for item in sorted((source / 'textures').rglob('*')) + [source / 'logo.png']:
        if not item.is_file():
            continue
        mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'}.get(item.suffix)
        if mime:
            assets[item.relative_to(source).as_posix()] = {
                'mime': mime, 'data': base64.b64encode(item.read_bytes()).decode('ascii')}
    data = json.dumps({'html': html, **compiled, 'assets': assets}, ensure_ascii=False).encode('utf-8')
    payload = gzip.compress(data, mtime=0)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    print(f'{destination}: SHA256 {hashlib.sha256(payload).hexdigest()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--esbuild', help='Path to an installed esbuild module (build time only)')
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'bumpmesh_orca_assets' / 'bumpmesh-web.json.gz')
    args = parser.parse_args()
    bundle(args.source.resolve(), args.output.resolve(), args.esbuild)
