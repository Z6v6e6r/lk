#!/usr/bin/env python3
"""Capture public Rodina pages and build an offline-rebuildable static handoff.

No authentication, backend deployment or business writes. Python standard library only.
"""
import argparse
import base64
import concurrent.futures
from datetime import datetime, timezone
import gzip
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse


SOURCE = 'https://ffc.team'
ASSET_PREFIX = '/rodina-assets'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


class Snippet(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = None
        self.buffer = []
        self.scripts = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.active = (tag, dict(attrs))
            self.buffer = []

    def handle_data(self, text):
        if self.active:
            self.buffer.append(text)

    def handle_endtag(self, tag):
        if self.active and self.active[0] == tag:
            _, attrs = self.active
            target = self.scripts if tag == 'script' else self.styles
            target.append((attrs, ''.join(self.buffer)))
            self.active = None


def decode_page(text):
    # Only application T123 bodies, never Tilda analytics, headers or page trackers.
    chunks = [c for c in re.findall(r'<!-- nominify begin -->(.*?)<!-- nominify end -->', text, re.S)
              if re.search(r'rodina-site-005jda|data-rodina-package|__rodina', c)]
    parser = Snippet()
    for chunk in chunks:
        parser.feed(chunk)
    parts = [(a, t) for a, t in parser.scripts if 'data-rodina-part' in a]
    if not parts:
        raise ValueError('No Rodina application package in the public page')
    parts.sort(key=lambda item: int(item[0]['data-rodina-part']))
    if [int(a['data-rodina-part']) for a, _ in parts] != list(range(len(parts))):
        raise ValueError('Missing or repeated compressed package parts')
    package_ids = {a['data-rodina-package'] for a, _ in parts}
    if len(package_ids) != 1:
        raise ValueError('Mixed application package identifiers')
    bundle = gzip.decompress(base64.b64decode(''.join(json.loads(t) for _, t in parts)))
    if not digest(bundle).startswith(next(iter(package_ids))):
        raise ValueError('Application package SHA256 does not match')
    patches = []
    for attrs, code in parser.scripts:
        if attrs.get('src'):
            raise ValueError('Unexpected external script in application T123')
        if attrs.get('type') == 'application/json':
            continue
        if 'DecompressionStream' in code and 'data-rodina-package' in code:
            continue
        if code.strip():
            patches.append(code.strip() + '\n')
    if not any('rodinaNineVenueRoutes' in code for code in patches):
        routes = 'older'
    else:
        routes = 'nine-venue'
    title_match = re.search(r'<title>(.*?)</title>', text, re.S | re.I)
    # Meta attribute order is not significant.
    description = ''
    class Metadata(HTMLParser):
        def handle_starttag(self, tag, attrs):
            nonlocal description
            a = dict(attrs)
            if tag == 'meta' and a.get('name') == 'description':
                description = a.get('content', '')
    Metadata().feed(text)
    return {
        'bundle': bundle,
        'patches': patches,
        'styles': '\n'.join(t for _, t in parser.styles),
        'chunks': chunks,
        'title': html.unescape(title_match.group(1)) if title_match else 'Родина — манежи',
        'description': description,
        'route_version': routes,
    }


def fetch(url, proxy=None):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname:
        raise ValueError('Only public HTTPS URLs can be captured')
    args = ['curl', '-fLsS', '--retry', '1', '--connect-timeout', '10', '--max-time', '45']
    if proxy:
        args += ['--proxy', proxy]
    # No cookie jar, headers, auth or API POSTs are captured.
    return subprocess.check_output(args + [url])


def media_urls(text):
    result = set()
    for url in re.findall(r'https://[^\s"\x27`<>\\)]+', text):
        p = urlparse(url)
        if p.hostname not in ('cg178013.tw1.ru', 'static.tildacdn.com'):
            continue
        if Path(p.path).suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp', '.svg', '.woff2', '.pdf'):
            result.add(url)
    return sorted(result)


def capture(root, baseline, proxy):
    current = root / 'source/current'
    if current.exists():
        raise ValueError('Capture destination already exists; use a new directory')
    sitemap = fetch(SOURCE + '/sitemap.xml', proxy).decode()
    urls = [html.unescape(u) for u in re.findall(r'<loc>(.*?)</loc>', sitemap)
            if re.fullmatch(r'https://ffc\.team/rodina(?:-[a-z]+)?', html.unescape(u))]
    if SOURCE + '/rodina' not in urls or len(set(urls)) != 10:
        raise ValueError('Expected the main page and exactly nine unique station pages')
    urls = [SOURCE + '/rodina'] + sorted(set(urls) - {SOURCE + '/rodina'})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        payloads = list(pool.map(lambda u: fetch(u, proxy), urls))
    decoded = [decode_page(b.decode()) for b in payloads]
    main = decoded[0]
    if not any('rodinaNineVenueRoutes' in c for c in main['patches']):
        raise ValueError('Main page must contain all nine station routes')
    if any(p['bundle'] != main['bundle'] for p in decoded):
        raise ValueError('Application base bundles differ; review before harmonizing')
    current.mkdir(parents=True)
    (current / 'base-app.js').write_bytes(main['bundle'])
    (current / 'page.css').write_text(main['styles'])
    patches_dir = current / 'patches'
    patches_dir.mkdir()
    for i, code in enumerate(main['patches'], 1):
        (patches_dir / f'{i:02d}.js').write_text(code)
    pages = []
    for url, payload, page in zip(urls, payloads, decoded):
        slug = urlparse(url).path.strip('/')
        snapshot = root / 'source/published-t123' / slug
        snapshot.mkdir(parents=True)
        for i, chunk in enumerate(page['chunks'], 1):
            (snapshot / f'{i:02d}.html').write_text(chunk.strip() + '\n')
        pages.append({
            'slug': slug, 'source_url': url,
            'target_path': '/' + slug + '/',
            'title': page['title'], 'description': page['description'],
            'published_html_sha256': digest(payload),
            'published_bundle_sha256': digest(page['bundle']),
            'published_patch_sha256': [digest(c.encode()) for c in page['patches']],
            'published_route_version': page['route_version'],
            'common_patch_difference': page['patches'] != main['patches'],
        })
    write_json(current / 'pages.json', pages)
    all_code = main['bundle'].decode() + main['styles'] + ''.join(main['patches'])
    urls = media_urls(all_code)
    media = root / 'source/media'
    media.mkdir(parents=True)
    def download(url):
        name = digest(url.encode())[:16] + '-' + re.sub(r'[^a-zA-Z0-9._-]', '-', Path(urlparse(url).path).name)
        data = fetch(url, proxy)
        if data.lstrip().lower().startswith((b'<!doctype html', b'<html')):
            raise ValueError('Media URL returned HTML: ' + url)
        (media / name).write_bytes(data)
        return {'url': url, 'file': name, 'bytes': len(data), 'sha256': digest(data)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        assets = list(pool.map(download, urls))
    write_json(current / 'assets.json', assets)
    # Human-readable editable baseline; verified against the exact current base bundle.
    candidate = baseline.parent / 'site' / ('rodina-005jda.' + digest(main['bundle'])[:16] + '.js')
    if not candidate.is_file() or candidate.read_bytes() != main['bundle']:
        raise ValueError('Editable source baseline is not the current published base bundle')
    base = root / 'source/base'
    base.mkdir(parents=True)
    for name in ('src', 'scripts', 'tests'):
        shutil.copytree(baseline / name, base / name)
    for name in ('package.json', 'package-lock.json'):
        shutil.copy2(baseline / name, base / name)
    (base / 'audit').mkdir()
    shutil.copy2(baseline / 'audit/source-manifest.json', base / 'audit/source-manifest.json')
    write_json(root / 'SOURCE-IDENTITY.json', {
        'retrieved_at_utc': datetime.now(timezone.utc).isoformat(), 'tenant': '005JDA', 'source': SOURCE + '/rodina',
        'base_sha256': digest(main['bundle']), 'editable_baseline_verified': True,
        'harmonization': 'All ten routes use the current main page additions; published T123 captures retained separately.',
        'cookies_or_credentials_captured': False,
    })


def build(root, target_origin):
    if not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?', target_origin):
        raise ValueError('Target origin must be a plain HTTPS origin')
    current = root / 'source/current'
    pages = json.loads((current / 'pages.json').read_text())
    assets = json.loads((current / 'assets.json').read_text())
    public = root / 'public'
    # Only overwrite outputs identified by this package, never remove a document root.
    public.mkdir(exist_ok=True)
    shared = public / ASSET_PREFIX.lstrip('/')
    (shared / 'media').mkdir(parents=True, exist_ok=True)
    for item in assets:
        if not re.fullmatch(r'[a-f0-9]{16}-[a-zA-Z0-9._-]+', item['file']):
            raise ValueError('Invalid media filename')
        data = (root / 'source/media' / item['file']).read_bytes()
        if digest(data) != item['sha256']:
            raise ValueError('Media SHA256 mismatch: ' + item['file'])
        (shared / 'media' / item['file']).write_bytes(data)
    replacements = {a['url']: ASSET_PREFIX + '/media/' + a['file'] for a in assets}
    def localize(text):
        for old in sorted(replacements, key=len, reverse=True):
            text = text.replace(old, replacements[old])
        if media_urls(text):
            raise ValueError('External page media remained after localization')
        return text
    (shared / 'base-app.js').write_text(localize((current / 'base-app.js').read_text()))
    (shared / 'page.css').write_text(
        'html{scroll-behavior:smooth}body{margin:0;background:#000e18}*{box-sizing:border-box}\n'
        + localize((current / 'page.css').read_text()))
    patch_names = []
    patch_code = []
    adaptations = []
    for patch in sorted((current / 'patches').glob('*.js')):
        code = localize(patch.read_text())
        # The published maps addon also selects buttons with no href. They retain
        # their original click handler and must not be passed to new URL(undefined).
        marker = 'const url = new URL(link.href);'
        if marker in code and "scope.querySelectorAll('.arena-item[data-arena] .arena-route')" in code:
            code = code.replace(marker, 'if (!link.href) return;\n      const url = new URL(link.href, location.href);')
            adaptations.append({'patch': patch.name, 'change': 'Skip map buttons without href; resolve actual anchors against current origin.'})
        if 'rodinaNineVenueRoutes' in code:
            code = code.replace('location.assign(destination);', "location.assign(destination + '/');")
            code = code.replace('location.assign(MAIN);', "location.assign(MAIN + '/');")
            adaptations.append({'patch': patch.name, 'change': 'Use canonical trailing-slash URLs for internal navigation, matching ROUTES.json and OAuth callback path expectations.'})
        # Keep the failure isolation of separate T123 script elements.
        patch_code.append('(function(){try{\n' + code + '\n}catch(error){console.error("Rodina addon ' + patch.stem + '",error);}})();\n')
        patch_names.append(patch.name)
    (shared / 'common.js').write_text('\n;\n'.join(patch_code))
    # Remove only previous generated addon outputs from this package.
    for name in patch_names:
        stale = shared / 'patches' / name
        if stale.is_file():
            stale.unlink()
    if (shared / 'patches').is_dir() and not any((shared / 'patches').iterdir()):
        (shared / 'patches').rmdir()
    write_json(root / 'ADAPTATIONS.json', adaptations)
    script_paths = [ASSET_PREFIX + '/base-app.js', ASSET_PREFIX + '/common.js']
    scripts = '\n'.join(f'<script defer src="{p}"></script>' for p in script_paths)
    for page in pages:
        slug = page['slug']
        if not re.fullmatch(r'rodina(?:-[a-z]+)?', slug):
            raise ValueError('Invalid captured route')
        directory = public / slug
        directory.mkdir(exist_ok=True)
        canonical = target_origin + page['target_path']
        title = html.escape(page['title'])
        description = html.escape(page['description'], quote=True)
        body = f'''<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000e18"><title>{title}</title>
<meta name="description" content="{description}"><link rel="canonical" href="{canonical}">
<meta property="og:title" content="{title}"><meta property="og:description" content="{description}">
<meta property="og:type" content="website"><meta property="og:url" content="{canonical}">
<link rel="icon" href="{next((v for u, v in replacements.items() if u.endswith('/rodina-mark.svg')), '')}" type="image/svg+xml">
<link rel="stylesheet" href="{ASSET_PREFIX}/page.css">
{scripts}
</head><body><div id="rodina-site-005jda" role="status" style="min-height:160px;color:#fff;background:#000e18">Загрузка сайта…</div>
<noscript>Для выбора манежа и просмотра расписания включите JavaScript.</noscript>
</body></html>
'''
        (directory / 'index.html').write_text(body)
    (public / 'index.html').write_text('<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/rodina/"><a href="/rodina/">Открыть манежи Родины</a></html>\n')
    write_json(root / 'ROUTES.json', [{
        'source': p['source_url'], 'target': target_origin + p['target_path'],
        'file': 'public/' + p['slug'] + '/index.html', 'title': p['title'],
    } for p in pages])
    files = {}
    for p in sorted(public.rglob('*')):
        if p.is_file():
            data = p.read_bytes()
            files[str(p.relative_to(root))] = {'bytes': len(data), 'sha256': digest(data)}
    write_json(root / 'FILES-SHA256.json', files)
    print(json.dumps({'pages': len(pages), 'patches': len(patch_names), 'local_assets': len(assets),
                      'public_files': len(files), 'target_origin': target_origin}, ensure_ascii=False))


def verify(root):
    files = json.loads((root / 'FILES-SHA256.json').read_text())
    for name, item in files.items():
        data = (root / name).read_bytes()
        if digest(data) != item['sha256'] or len(data) != item['bytes']:
            raise ValueError('Public output changed: ' + name)
    routes = json.loads((root / 'ROUTES.json').read_text())
    if len(routes) != 10:
        raise ValueError('Expected ten routes')
    for item in routes:
        text = (root / item['file']).read_text()
        if 'tildacdn.com' in text or 'tilda-' in text or item['target'] not in text:
            raise ValueError('Invalid standalone page: ' + item['file'])
        for ref in re.findall(r'(?:src|href)="(/rodina-assets/[^\"]+)"', text):
            if not (root / 'public' / ref.lstrip('/')).is_file():
                raise ValueError('Missing referenced file: ' + ref)
    production = '\n'.join(p.read_text() for p in (root / 'public/rodina-assets').rglob('*.js'))
    if media_urls(production):
        raise ValueError('Production JavaScript still depends on external visual media')
    if 'https://ffc.team/lk1' not in production or '005JDA' not in production:
        raise ValueError('Existing LK or tenant binding was lost')
    if 'rodinaNineVenueRoutes' not in production:
        raise ValueError('Nine-station navigation is missing')
    print('PASS: ten routes, output hashes, local assets, existing tenant and LK destination')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['capture', 'build', 'verify'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--proxy')
    parser.add_argument('--target-origin', default='https://rodina.moscow')
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.command == 'capture':
        if not args.baseline:
            parser.error('capture requires --baseline')
        capture(root, args.baseline.resolve(), args.proxy)
    elif args.command == 'build':
        build(root, args.target_origin)
    else:
        verify(root)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as exc:
        print('ERROR:', exc, file=sys.stderr)
        sys.exit(1)
