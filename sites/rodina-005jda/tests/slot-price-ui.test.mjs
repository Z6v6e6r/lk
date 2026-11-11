import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual component's two local functions with small DOM/API ports.
// This exercises handler wiring and response races without a second browser dependency.
const source=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function renderSlots() {'),source.indexOf('let quoteReturnFocus = null;'));
function harness(quoteFor) {
 const next={textContent:'',disabled:false,setAttribute(){}};
 const message={hidden:true,textContent:''};
 const holder={innerHTML:'',querySelectorAll:()=>[]};
 const first={timeFrom:'2026-11-11T22:00:00+03:00',timeTo:'2026-11-11T23:00:00+03:00'};
 const second={timeFrom:'2026-11-11T22:30:00+03:00',timeTo:'2026-11-11T23:30:00+03:00'};
 const state={arena:{id:'novatorov'},viva:{},date:'2026-11-11',page:'booking',step:2,selectedInterval:first,quote:null,rawSlots:{},durationMinutes:60};
 const opened=[];
 const context={state,quoteController:null,quoteRequest:0,AbortController,Intl,
  content:{querySelector:s=>s==='#nextButton'?next:s==='#quoteError'?message:holder},
  Viva:{quoteFor,intervalsFor:()=>[first,second],timeLabel:()=>'',moscowDay:()=>state.date},
  openQuote:(...args)=>opened.push(args),flash:()=>{},renderDateStep:()=>{},minutesLabel:()=>''};
 const app=vm.runInNewContext(code+'\n({renderSlots,showQuote})',context);
 app.renderSlots();return {app,state,next,message,opened,first,second};
}
const quote=(interval,amount)=>({...interval,amount,minutes:60,currency:'RUB'});
test('selection price is calculated without payment, then explicit proceed opens once',async()=>{
 const h=harness(async(b,i)=>quote(i,12000));
 assert.equal(h.next.disabled,true);
 await h.app.showQuote(false);
 assert.match(h.next.textContent,/Перейти к оплате.*12\s?000/);
 assert.equal(h.next.disabled,false);assert.equal(h.opened.length,0);
 await h.next.onclick();assert.equal(h.opened.length,1);
});
test('a failed quote retry only updates the displayed amount',async()=>{
 let fail=true;const h=harness(async(b,i)=>{if(fail)throw Error('Provider unavailable');return quote(i,18000);});
 await h.app.showQuote(false);assert.equal(h.next.textContent,'Повторить расчёт стоимости');assert.equal(h.message.hidden,false);
 fail=false;await h.next.onclick();
 assert.match(h.next.textContent,/Перейти к оплате.*18\s?000/);assert.equal(h.opened.length,0);
});
test('changed price requires another explicit proceed after displaying new amount',async()=>{
 let amount=12000;const h=harness(async(b,i)=>quote(i,amount));
 await h.app.showQuote(false);amount=18000;await h.next.onclick();
 assert.equal(h.opened.length,0);assert.match(h.next.textContent,/18\s?000/);assert.match(h.message.textContent,/Стоимость изменилась/);
 await h.next.onclick();assert.equal(h.opened.length,1);assert.equal(h.opened[0][1].amount,18000);
});
test('a late old-slot response cannot replace a newer interval price',async()=>{
 const pending=[];const h=harness((b,i)=>new Promise(resolve=>pending.push({interval:i,resolve})));
 const old=h.app.showQuote(false);h.state.selectedInterval=h.second;h.state.quote=null;
 const current=h.app.showQuote(false);pending[1].resolve(quote(h.second,18000));await current;
 pending[0].resolve(quote(h.first,12000));await old;
 assert.equal(h.state.quote.amount,18000);assert.match(h.next.textContent,/18\s?000/);assert.equal(h.opened.length,0);
});
