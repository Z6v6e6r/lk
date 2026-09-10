import fs from 'node:fs';
export function visitLifecycleRuntimeSource() {
  const source = fs.readFileSync(new URL('./subscriptionVisitLifecycle.mjs', import.meta.url), 'utf8');
  const exports = [...source.matchAll(/^export function (\w+)\(/gm)].map(match => match[1]);
  return `const __subscriptionVisitLifecycle = (() => {\n${source.replace(/^export /gm, '')}\nreturn {${exports.join(',')}};\n})();\n`;
}
export function visitConfirmationSource() {
  return fs.readFileSync(new URL('../nodered_lk1_hub_nodes/visit_confirm.js', import.meta.url), 'utf8');
}
