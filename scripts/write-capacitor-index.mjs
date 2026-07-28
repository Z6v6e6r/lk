import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const sourceFile = resolve(cwd, "index.html");
const targetFile = resolve(cwd, "dist", "index.html");

const source = await readFile(sourceFile, "utf8");
const faviconMarker = '<link rel="icon" type="image/svg+xml" href="/vite.svg" />';
const entryMarker = '<script type="module" src="/src/main.tsx"></script>';

if (!source.includes(faviconMarker) || !source.includes(entryMarker)) {
  throw new Error("Unexpected root index.html template for Capacitor generation");
}

const output = source
  .replace(faviconMarker, '<link rel="icon" type="image/png" href="./LPD.png" />')
  .replace(entryMarker, '<script defer src="./bundle.js"></script>');

await writeFile(targetFile, `${output}\n`, "utf8");

console.log(`Capacitor index written to ${targetFile}`);
