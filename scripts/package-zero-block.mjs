import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const destination = resolve(process.argv[2] || '/private/tmp/padlhub-zero-block-v2');
const source = await readFile(new URL('../docs/zero-block/padlhub-zero-block.js', import.meta.url), 'utf8');
const instruction = await readFile(new URL('../docs/zero-block/README.md', import.meta.url), 'utf8');
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'padlhub-zero-block.js'), source);
await writeFile(join(destination, 'ИНСТРУКЦИЯ.md'), instruction);
const css = '<style>[data-ph-hidden="true"]{display:none!important}[data-ph-state] [aria-disabled="true"],[aria-disabled="true"][data-ph-state]{opacity:.55;cursor:not-allowed}</style>';
for (const [name, keys] of [
  ['T123-обычные.html', ['friendship','academy','ra']],
  ['T123-Питер.html', ['friendship-promo','academy-promo','ra-promo']],
]) {
  await writeFile(join(destination, name), `${css}\n<script>\n${source}\n</script>\n<script>\nwindow.phSubscriptions = window.PadlHubZeroBlock.init({ offerKeys: ${JSON.stringify(keys)}, channel: 'prod', refreshMs: 30000 });\n</script>\n`);
}
console.log(`Designer kit written to ${destination}. Requires checkout-capable storefront publication.`);
