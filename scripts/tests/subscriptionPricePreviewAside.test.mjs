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


const optionBundle=await build({entryPoints:['src/components/games/SubscriptionOptionPrice.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],logLevel:'silent'});
const optionModule={exports:{}};new Function('require','module','exports',optionBundle.outputFiles[0].text)(require,optionModule,optionModule.exports);
const renderOption=(value,shareLabel='1/4')=>renderToStaticMarkup(React.createElement(optionModule.exports.SubscriptionOptionPrice,{preview:value,shareLabel}));
test('subscription option renders exact participation price and overage without a minimum label',()=>{
  const html=renderOption(preview);assert.match(html,/Участие в 1\/4 игры · 700 ₽/);
  assert.match(html,/Доплата за 30 мин/);assert.doesNotMatch(html,/от 700/);
  assert.match(renderOption({...preview,amountMinor:0,detail:null}),/0 ₽/);
  assert.match(renderOption({...preview,amountMinor:105050},'1/2'),/Участие в 1\/2 игры · 1\u00a0050,5 ₽/);
});
test('unconfirmed option never displays a free participation price',()=>{
  const html=renderOption({...preview,state:'unavailable',amountMinor:null,label:'Условия подписки не подтверждены'});
  assert.doesNotMatch(html,/0 ₽|700 ₽|Доплата/);assert.match(html,/не подтверждены/);
  assert.match(html,/aria-live="polite"/);
});

const joinBundle=await build({entryPoints:['src/components/games/JoinSubscriptionOptions.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],logLevel:'silent'});
const joinModule={exports:{}};new Function('require','module','exports',joinBundle.outputFiles[0].text)(require,joinModule,joinModule.exports);
test('join options display individual participation prices and block unconfirmed or exhausted choices',()=>{
 const bySubscriptionId={a:preview,b:{...preview,state:'limit-used',amountMinor:null,label:'Лимит по подписке исчерпан'},c:{...preview,amountMinor:0,detail:null}};
 const html=renderToStaticMarkup(React.createElement(joinModule.exports.JoinSubscriptionOptions,{options:['a','b','c','d'].map(subscriptionId=>({subscriptionId,name:subscriptionId,balanceLabel:'до 07.09.2027'})),preview:{...preview,bySubscriptionId,refresh(){}},disabled:false,shareLabel:'1/4',onJoin(){}}));
 assert.match(html,/700 ₽/);assert.match(html,/0 ₽/);assert.match(html,/Лимит по подписке исчерпан/);
 assert.equal((html.match(/disabled=""/g)||[]).length,2);
 assert.match(html,/Обновить стоимость по подпискам/);assert.doesNotMatch(html,/Списать с/);
});
