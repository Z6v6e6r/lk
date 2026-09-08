import assert from 'node:assert/strict';import {createRequire} from 'node:module';import test from 'node:test';import {build} from 'esbuild';
const require=createRequire(import.meta.url);const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const bundled=await build({entryPoints:['src/components/games/SubscriptionPricePreviewAside.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],logLevel:'silent'});
const module={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(require,module,module.exports);
const Aside=module.exports.SubscriptionPricePreviewAside;
const preview={state:'available',label:'По подписке от 700 ₽',detail:'Доплата за 30 мин',amountMinor:70000,basePriceMinor:300000,discounted:true};
const render=(ordinaryPriceMinor,change={})=>renderToStaticMarkup(React.createElement(Aside,{ordinaryPrice:`${ordinaryPriceMinor/100} ₽`,ordinaryPriceMinor,preview:{...preview,...change},showPreview:true,showInfoBadge:false}));
test('ordinary promo price remains the benchmark even when Viva tariff is different',()=>{
 const html=render(200000);assert.match(html,/2000 ₽/);assert.doesNotMatch(html,/3000 ₽/);assert.match(html,/price--discounted/);assert.match(html,/По подписке от 700 ₽/);
 assert.doesNotMatch(render(50000),/price--discounted/);assert.doesNotMatch(render(70000),/price--discounted/);
});
test('unknown state never crosses out price and exposes a live status',()=>{
 const html=render(200000,{state:'unavailable',label:'Условия подписки не подтверждены',detail:null,amountMinor:null});
 assert.doesNotMatch(html,/price--discounted/);assert.match(html,/role="status"/);assert.match(html,/aria-live="polite"/);
});
