import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { ensureAssets } from './ensure-assets.mjs';
import { gzipSync } from 'node:zlib';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await ensureAssets(project);
const src = path.join(project, 'src');
const dist = path.join(project, 'dist');
fs.mkdirSync(path.join(dist, 'tilda'), { recursive: true });
const assetBase = (process.env.RODINA_ASSET_BASE || 'https://cg178013.tw1.ru').replace(/\/$/, '');
if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[a-zA-Z0-9_./-]*)?$/.test(assetBase)) throw new Error('RODINA_ASSET_BASE must be an HTTPS asset directory');
const assets = text => text.replace(/\/(assets|docs)\//g, `${assetBase}/$1/`);
const pageCSS = ['style', 'desktop', 'inquiries', 'mobile', 'locations', 'landing', 'footer'].map(name => fs.readFileSync(path.join(src, name + '.css'), 'utf8')).join('\n').replace(/\bMontserrat\b/g,'Rodina005JDAMontserrat').replace(/\bRodina\b/g,'Rodina005JDADisplay');
const panelCSS = ['style', 'desktop-panel', 'inquiries', 'locations'].map(name => fs.readFileSync(path.join(src, name + '.css'), 'utf8')).join('\n').replace(/\bMontserrat\b/g,'Rodina005JDAMontserrat').replace(/\bRodina\b/g,'Rodina005JDADisplay');
// Font faces belong to the document; all other styles remain inside Shadow DOM.
const fonts = pageCSS.match(/@font-face\s*\{[^}]+\}/g).join('\n').replace(/url\(['"]?\/assets\/([^)'"]+)['"]?\)/g, (_, name) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(src,'assets',name)).toString('base64')})`);
const scopeCSS = text => assets(text.replace(/@font-face\s*\{[^}]+\}/g, '').replace(/:root\b/g, ':host').replace(/(?<![\w-])\bhtml\b/g, ':host').replace(/(?<![\w-])\bbody\b/g, '.rodina-page'));
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
const markup = assets(html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script\b[\s\S]*?<\/script>/g, ''));
const block1 = `<!-- T123 1/3: styles, once per page -->\n<style>${assets(fonts)}\n#rodina-site-005jda { display:block; width:100%; min-width:320px; color-scheme:dark; }\n</style>\n<template id="rodina-styles-005jda"><style>${scopeCSS(pageCSS)}\n:host { display:block; }\n.rodina-page { width:100%; }\n</style></template>\n`;
const block2 = `<!-- T123 2/3: page, once per page -->\n<div id="rodina-site-005jda"></div>\n<template id="rodina-page-005jda"><div class="rodina-page">${markup}</div></template>\n`;
const entry = `import { mountSite } from './entry.js';
const boot = async () => {
 const host = document.getElementById('rodina-site-005jda');
 const page = document.getElementById('rodina-page-005jda');
 const styles = document.getElementById('rodina-styles-005jda');
 if (!host || !page || !styles) throw new Error('Добавьте все три блока T123 в указанном порядке.');
 if (host.shadowRoot) return;
 const root = host.attachShadow({ mode:'open' });
 root.append(styles.content.cloneNode(true), page.content.cloneNode(true));
 root.addEventListener('click', event => {
  const link = event.composedPath().find(node => node?.tagName === 'A');
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = link?.getAttribute('href');
  if (!href?.startsWith('#')) return;
  const target = root.getElementById(href.slice(1));
  if (!target) return;
  event.preventDefault(); target.scrollIntoView({ block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth' });
 });
 await mountSite(root, ${JSON.stringify(scopeCSS(panelCSS))});
 const target = root.getElementById(location.hash.slice(1));
 if (target) target.scrollIntoView({block:'start'});
};
const run = () => boot().catch(error => { console.error('Rodina 005JDA:',error); const host=document.getElementById('rodina-site-005jda'); if(host) { const p=document.createElement('p'); p.setAttribute('role','alert'); p.textContent='Не удалось загрузить сайт. Обновите страницу или напишите менеджеру @ffc_manager.'; (host.shadowRoot||host).append(p); } });
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded',run,{once:true}); else run();`;
const result = await build({ stdin: { contents: entry, resolveDir: src, sourcefile: 'tilda-entry.js' }, bundle: true, write: false, minify: true, format: 'iife', target: ['es2022'], legalComments: 'none', plugins: [{ name:'asset-base', setup(b) { b.onLoad({filter:/\.(?:js|json)$/}, args => ({ contents: assets(fs.readFileSync(args.path,'utf8')), loader:args.path.endsWith('.json')?'json':'js' })); } }] });
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const block3 = `<!-- T123 3/3: app, once per page; tenant 005JDA -->\n<script src="https://telegram.org/js/telegram-web-app.js"></script>\n<script>${js}</script>\n`;
const blocks = [block1, block2, block3];
// The classic external script carries the templates as well as the app. T123
// only installs this script; no cross-origin HTML fetch or eval is needed.
const externalJS = `(() => {
 const host = document.getElementById('rodina-site-005jda');
 if (!host || host.dataset.rodinaInstalled === 'true') return;
 host.dataset.rodinaInstalled = 'true';
 host.removeAttribute('role');
 if (!window.Telegram && !document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')) {
  const sdk = document.createElement('script'); sdk.src = 'https://telegram.org/js/telegram-web-app.js'; sdk.async = true;
  sdk.onload = () => { window.Telegram?.WebApp?.ready(); window.Telegram?.WebApp?.expand(); };
  document.head.appendChild(sdk);
 }
 const template = document.createElement('template');
 template.innerHTML = ${JSON.stringify(block1 + block2.replace('<div id="rodina-site-005jda"></div>', ''))};
 host.parentNode.insertBefore(template.content, host.nextSibling);
 ${js}
})();\n`;
const bundleName = 'rodina-005jda.' + crypto.createHash('sha256').update(externalJS).digest('hex').slice(0,16) + '.js';
fs.writeFileSync(path.join(dist,bundleName), externalJS);
function splitBlocks(app) {
 const encoded = gzipSync(Buffer.from(app),{level:9,mtime:0}).toString('base64');
 const sha = crypto.createHash('sha256').update(app).digest('hex');
 const id = sha.slice(0,16);
 const count = Math.ceil(encoded.length/16000);
 const parts = Array.from({length:count},(_,index) => `${index===0?'<div id="rodina-site-005jda" style="min-height:160px;color:#fff;background:#000e18" role="status">Загрузка сайта…</div>\n':''}<!-- Родина 005JDA: часть ${index+1}/${count+1} -->\n<script type="application/json" data-rodina-package="${id}" data-rodina-part="${index}">${JSON.stringify(encoded.slice(index*16000,(index+1)*16000))}</script>\n`);
 parts.push(`<!-- Родина 005JDA: запуск, последний блок -->
<script>
(async function () {
 var host = document.getElementById('rodina-site-005jda');
 if (!host) {
  var notice = document.createElement('p'); notice.setAttribute('role','alert'); notice.textContent = 'Добавьте первый блок T123 и весь комплект из ${count+1} блоков.';
  (document.currentScript.parentNode || document.body).appendChild(notice); return;
 }
 if (host.dataset.rodinaDecoding) return;
 host.dataset.rodinaDecoding = 'true';
 try {
  if (!window.DecompressionStream || !window.crypto || !window.crypto.subtle) throw new Error('Для загрузки нужен современный браузер и HTTPS.');
  var nodes = Array.from(document.querySelectorAll('script[data-rodina-package="${id}"]'));
  if (nodes.length !== ${count}) throw new Error('Добавьте комплект целиком: ${count+1} блоков.');
  nodes.sort(function(a,b) { return Number(a.dataset.rodinaPart) - Number(b.dataset.rodinaPart); });
  var text = nodes.map(function(node,index) { if(Number(node.dataset.rodinaPart)!==index) throw new Error('Проверьте порядок и отсутствие повторов блоков.'); return JSON.parse(node.textContent); }).join('');
  var bytes = Uint8Array.from(atob(text),function(char) { return char.charCodeAt(0); });
  var source = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  var hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',source)),function(byte) { return byte.toString(16).padStart(2,'0'); }).join('');
  if(hash !== '${sha}') throw new Error('Части сайта не совпадают. Замените блоки одним комплектом.');
  var script = document.createElement('script'); script.textContent = new TextDecoder().decode(source); document.head.appendChild(script);
 } catch (error) { host.removeAttribute('role'); host.setAttribute('role','alert'); host.textContent = 'Не удалось загрузить сайт. ' + error.message; }
})();
</script>\n`);
 if(parts.some(value=>Buffer.byteLength(value)>17000))throw new Error('T123 part exceeds 17KB');
 return parts;
}
const parts = splitBlocks(externalJS);
fs.rmSync(path.join(dist,'tilda'),{recursive:true,force:true});
fs.mkdirSync(path.join(dist,'tilda'),{recursive:true});
const partNames = parts.map((value,index)=>'tilda/T123-'+String(index+1).padStart(2,'0')+'-'+(index===parts.length-1?'START':'part')+'.html');
parts.forEach((value,index)=>fs.writeFileSync(path.join(dist,partNames[index]),value));
fs.writeFileSync(path.join(dist,'tilda','ORDER.txt'), 'Добавьте '+parts.length+' блоков T123 без отступов. В каждый вставьте целиком соответствующий HTML, по одному файлу на блок. START должен быть последним. Не смешивайте комплекты разных сборок.\n\n'+partNames.map((name,index)=>(index+1)+'. '+path.basename(name)+' ('+Buffer.byteLength(parts[index])+' байт)').join('\n')+'\n');
const shell = body => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#001522"><title>Родина — футбольные манежи в Москве</title><style>body{margin:0;background:#000e18}html{scroll-behavior:smooth}</style></head><body>${body}</body></html>`;
fs.writeFileSync(path.join(dist,'index.html'), shell(blocks.join('\n').replaceAll(assetBase + '/assets/', '/assets/').replaceAll(assetBase + '/docs/', '/docs/')));
fs.writeFileSync(path.join(dist,'compact-preview.html'), shell(splitBlocks(externalJS.replaceAll(assetBase+'/assets/','/assets/').replaceAll(assetBase+'/docs/','/docs/')).join('\n')));
fs.cpSync(path.join(src,'assets'),path.join(dist,'assets'),{recursive:true});
fs.cpSync(path.join(src,'docs'),path.join(dist,'docs'),{recursive:true});
const catalog = JSON.parse(fs.readFileSync(path.join(src,'arenas.json'),'utf8'));
const missing = catalog.arenas.filter(a => !a.viva.masterServiceId).map(a=>a.name);
const manifest = { bundleName, partCount:parts.length, maxPartBytes:Math.max(...parts.map(part=>Buffer.byteLength(part))), tenant:'005JDA', reference:'https://cg178013.tw1.ru/', assetBase, ready:missing.length===0, missingVenues:missing, files:Object.fromEntries(['index.html','compact-preview.html',bundleName,...partNames].map(name=>[name,{bytes:fs.statSync(path.join(dist,name)).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,name))).digest('hex')}])) };
fs.writeFileSync(path.join(dist,'release.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
