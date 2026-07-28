import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/patch_live_communities_tournament_discovery_bundle.mjs <input> <output>");
  process.exit(1);
}

const needle = 'useEffect(()=>{if(!Jn||Be.kind!=="TOURNAMENT")return;';
const replacement = 'useEffect(()=>{if(!Jn||Be.kind!=="TOURNAMENT"||!0)return;';
const source = await readFile(resolve(inputPath), "utf8");
const occurrences = source.split(needle).length - 1;

if (occurrences !== 1) {
  console.error(`Expected exactly one tournament discovery guard, found ${occurrences}`);
  process.exit(1);
}

const patched = source.replace(needle, replacement);
if (patched.length !== source.length + 4) {
  console.error("Unexpected bundle size delta");
  process.exit(1);
}

await writeFile(resolve(outputPath), patched, "utf8");
console.log(JSON.stringify({
  inputPath: resolve(inputPath),
  outputPath: resolve(outputPath),
  inputBytes: source.length,
  outputBytes: patched.length,
  replacements: occurrences,
}));
