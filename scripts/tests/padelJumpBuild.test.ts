import test from 'node:test';
import assert from 'node:assert/strict';
import { build, resolveConfig } from 'vite';
import { EXHIBITION_GAME_SOURCE, exhibitionWidgetUrl, exhibitionModuleGuard } from '../padel_jump_build.ts';

test('exhibition uses its published immutable pin when the optional env is absent', () => {
  assert.equal(EXHIBITION_GAME_SOURCE, '8b45b15ef10268cc56e70a03836d7806dbb19e85');
  assert.equal(exhibitionWidgetUrl(undefined), 'https://padlhub.su/lk/padel-jump-exhibition-8b45b15e/assets/cabinet.js');
  assert.equal(exhibitionWidgetUrl('a'.repeat(40)), 'https://padlhub.su/lk/padel-jump-exhibition-aaaaaaaa/assets/cabinet.js');
});

test('explicit empty, malformed and URL overrides fail closed', () => {
  for (const value of ['', ' ', '8b45b15e', 'A'.repeat(40), 'https://example.invalid/module.js']) {
    assert.throws(() => exhibitionWidgetUrl(value), /Invalid PADLHUB_EXHIBITION_GAME_SOURCE/);
  }
});

for (const mode of ['production', 'dev']) {
  const fileName = mode === 'dev' ? 'bundle-dev.js' : 'bundle.js';
  test(`${mode} cabinet config retains the pin and enables the output guard without env`, async () => {
    const previous = process.env.PADLHUB_EXHIBITION_GAME_SOURCE;
    delete process.env.PADLHUB_EXHIBITION_GAME_SOURCE;
    try {
      const config = await resolveConfig({ mode }, 'build');
      assert.equal(config.define?.__PADLHUB_EXHIBITION_WIDGET_URL__, JSON.stringify(exhibitionWidgetUrl()));
      assert.ok(config.plugins.some(plugin => plugin.name === 'lk-exhibition-module-guard'));
    } finally {
      if (previous === undefined) delete process.env.PADLHUB_EXHIBITION_GAME_SOURCE;
      else process.env.PADLHUB_EXHIBITION_GAME_SOURCE = previous;
    }
  });

  test(`${mode} output guard rejects the original empty binding and a wrong module`, async () => {
    const url = exhibitionWidgetUrl();
    for (const value of ['', exhibitionWidgetUrl('a'.repeat(40)), url]) {
      const result = build({
        configFile: false, logLevel: 'silent', plugins: [exhibitionModuleGuard(url, fileName),
          { name: 'fixture', resolveId: id => id.endsWith('virtual:jump-pin') ? '\0jump-pin' : null,
            load: id => id === '\0jump-pin' ? `export const moduleUrl = ${JSON.stringify(value)};` : null }],
        build: { write: false, lib: { entry: 'virtual:jump-pin', formats: ['es'], fileName: () => fileName },
        },
      });
      if (value === url) await result;
      else await assert.rejects(result, /missing the pinned exhibition game module/);
    }
  });
}
