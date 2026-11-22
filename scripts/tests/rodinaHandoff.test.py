"""Offline transfer regressions: provenance, tracker exclusion and asset custody."""
import base64
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('handoff', Path(__file__).parents[1] / 'rodina_handoff.py')
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class HandoffTests(unittest.TestCase):
    def page(self, missing=False):
        bundle = b'console.log("public fixture")'
        encoded = base64.b64encode(gzip.compress(bundle)).decode()
        key = handoff.digest(bundle)[:16]
        half = len(encoded) // 2
        chunks = []
        for index, text in enumerate([encoded[:half], encoded[half:]]):
            if missing and index == 0:
                continue
            chunks.append(f'<script type="application/json" data-rodina-package="{key}" data-rodina-part="{index}">{json.dumps(text)}</script>')
        chunks.append('<script>window.__rodinaExample=true;</script>')
        tracker = '<script src="https://example.invalid/tracker.js"></script>'
        return ''.join('<!-- nominify begin -->' + s + '<!-- nominify end -->' for s in [tracker] + chunks)

    def fixture(self, root):
        current = root / 'source/current'
        (current / 'patches').mkdir(parents=True)
        (root / 'source/media').mkdir()
        media = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        name = '0123456789abcdef-rodina-mark.svg'
        (root / 'source/media' / name).write_bytes(media)
        url = 'https://cg178013.tw1.ru/assets/rodina-mark.svg'
        (current / 'base-app.js').write_text('const tenant="005JDA"; const account="https://ffc.team/lk1"; const img="' + url + '";')
        (current / 'page.css').write_text('')
        (current / 'patches/01.js').write_text('const rodinaNineVenueRoutes=true;')
        slugs = ['rodina'] + ['rodina-' + c for c in 'abcdefghi']
        handoff.write_json(current / 'pages.json', [{'slug': s, 'target_path': '/' + s + '/', 'source_url': 'https://ffc.team/' + s, 'title': s, 'description': ''} for s in slugs])
        handoff.write_json(current / 'assets.json', [{'url': url, 'file': name, 'bytes': len(media), 'sha256': handoff.digest(media)}])
        return current

    def test_decode_keeps_application_and_excludes_unrelated_tilda_trackers(self):
        result = handoff.decode_page(self.page())
        self.assertEqual(result['bundle'], b'console.log("public fixture")')
        self.assertEqual(result['patches'], ['window.__rodinaExample=true;\n'])
        self.assertTrue(all('tracker.js' not in c for c in result['chunks']))

    def test_missing_compressed_part_fails_closed(self):
        with self.assertRaises(ValueError):
            handoff.decode_page(self.page(missing=True))

    def test_build_preserves_api_bindings_and_uses_only_local_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            handoff.build(root, 'https://rodina.moscow')
            handoff.verify(root)
            text = (root / 'public/rodina-assets/base-app.js').read_text()
            self.assertNotIn('cg178013.tw1.ru', text)
            self.assertIn('https://ffc.team/lk1', text)
            self.assertIn('005JDA', text)
            self.assertIn('https://rodina.moscow/rodina/', (root / 'public/rodina/index.html').read_text())

    def test_changed_media_is_rejected_before_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            next((root / 'source/media').iterdir()).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                handoff.build(root, 'https://rodina.moscow')

    def test_rebuild_from_delivered_public_media_without_capture_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            handoff.build(root, 'https://rodina.moscow')
            expected = (root / 'FILES-SHA256.json').read_bytes()
            for media in (root / 'source/media').iterdir():
                media.unlink()
            handoff.build(root, 'https://rodina.moscow')
            self.assertEqual(expected, (root / 'FILES-SHA256.json').read_bytes())
            handoff.verify(root)

    def test_internal_navigation_matches_canonical_callback_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = self.fixture(root)
            (current / 'patches/01.js').write_text('const rodinaNineVenueRoutes=true; function go(){location.assign(destination);location.assign(MAIN);}')
            handoff.build(root, 'https://rodina.moscow')
            code = (root / 'public/rodina-assets/common.js').read_text()
            self.assertIn("location.assign(destination + '/');", code)
            self.assertIn("location.assign(MAIN + '/');", code)
            self.assertNotIn('location.assign(destination);', code)

    def test_media_map_cannot_escape_package_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = self.fixture(root)
            assets = json.loads((current / 'assets.json').read_text())
            assets[0]['file'] = '../../outside.svg'
            handoff.write_json(current / 'assets.json', assets)
            with self.assertRaisesRegex(ValueError, 'Invalid media filename'):
                handoff.build(root, 'https://rodina.moscow')

    def test_verifier_rejects_modified_public_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            handoff.build(root, 'https://rodina.moscow')
            (root / 'public/rodina/index.html').write_text('modified')
            with self.assertRaisesRegex(ValueError, 'Public output changed'):
                handoff.verify(root)


if __name__ == '__main__':
    unittest.main()
