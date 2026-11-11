import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build, transformSync } from 'esbuild';
import { parseEventRegistrationPolicy } from '../../src/services/community-policy.ts';
import { EXHIBITION_COMMUNITY_ID, buildPushOptInUrl, readExhibitionBrandOverride } from '../../src/components/padel-jump/exhibition.ts';

const require=createRequire(import.meta.url), React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const policy={version:'event-registration-v1',responsibleName:'Synthetic Organizer',contactEmail:['organizer','example.invalid'].join('@'),startsAt:'2026-11-11T21:00:00.000Z',endsAt:'2026-11-13T21:00:00.000Z',retentionYears:1};
const notice={policy,revision:2,retentionMode:'submitted-year-v1'};

// Exercise the actual pure mapper without importing HTTP/session initialization.
const source=readFileSync('src/utils/communityApi.ts','utf8');
function declaration(marker) {
  const start=source.indexOf(marker);assert.ok(start>=0);
  const end=source.indexOf('\n}',start);assert.ok(end>start);
  return source.slice(start,end+2).replace(/^export /,'');
}
const mapper=transformSync(declaration('function isRecord(')+'\n'+declaration('export function parseEventNotice('),{loader:'ts'}).code;
const parseNotice=new Function('value','parseEventRegistrationPolicy',mapper+'\nreturn parseEventNotice(value);');

test('rolling questionnaire notice survives the actual client mapper and unknown modes fail closed',()=>{
  assert.deepEqual(parseNotice(notice,parseEventRegistrationPolicy),notice);
  assert.equal(parseNotice({...notice,retentionMode:'unknown-mode'},parseEventRegistrationPolicy),undefined);
  assert.deepEqual(parseNotice({policy,revision:2},parseEventRegistrationPolicy),{policy,revision:2});
});

async function formRenderer() {
  const compiled=await build({entryPoints:['src/components/cabinet/EventRegistrationForm.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],loader:{'.css':'empty'},logLevel:'silent'});
  const module={exports:{}};
  new Function('require','module','exports',compiled.outputFiles[0].text)(require,module,module.exports);
  return value=>renderToStaticMarkup(React.createElement(module.exports.EventRegistrationForm,{notice:value,onSubmit:async()=>null,onCancel(){}}));
}

test('perpetual exhibition questionnaire is the short form with phone, notification opt-in and collapsed legal notice',async t=>{
  const render=await formRenderer();
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2028-11-14T09:00:00.000Z')});
  const html=render(notice);
  assert.match(html,/<form/);
  assert.match(html,/Заполните, пожалуйста, Ваши данные/);
  assert.match(html,/персональную презентацию/);
  assert.match(html,/3 месячных подписки/);
  assert.match(html,/Оповестить меня о результатах/);
  assert.match(html,/<details[^>]*class="community-event-registration__legal"/);
  for(const name of ['fullName','company','phone','email']) assert.match(html,new RegExp('<input(?=[^>]*name="'+name+'")(?=[^>]*required="")'));
  assert.match(html,/<input(?=[^>]*name="phone")(?=[^>]*type="tel")/);
  assert.match(html,/<input(?=[^>]*name="pushOptIn")(?=[^>]*type="checkbox")/);
  assert.match(html,/>Вступить<\/button>/);
  assert.doesNotMatch(render({policy,revision:2}),/<form/,'ordinary EVENT end dates remain enforced');
});

test('ordinary event questionnaires keep the full policy notice and do not collect phone or push consent',async ()=>{
  const render=await formRenderer();
  const html=render({policy,revision:2});
  assert.match(html,/<form/);
  assert.match(html,/Анкета используется/);
  assert.match(html,/Хранение — один календарный год после окончания мероприятия/);
  assert.doesNotMatch(html,/Заполните, пожалуйста, Ваши данные|Оповестить меня о результатах/);
  for(const name of ['fullName','company','email']) assert.match(html,new RegExp('<input(?=[^>]*name="'+name+'")(?=[^>]*required="")'));
  assert.doesNotMatch(html,/name="phone"/);
  assert.doesNotMatch(html,/name="pushOptIn"/);
});

const section=readFileSync('src/components/cabinet/CommunitiesSection.tsx','utf8');
function sectionCallback(name,next,bindings) {
  const start=section.indexOf('const '+name+' ='),end=section.indexOf('const '+next+' =',start);
  assert.ok(start>=0 && end>start);
  const code=transformSync(section.slice(start,end),{loader:'tsx'}).code;
  return new Function(...Object.keys(bindings),code+'\nreturn '+name+';')(...Object.values(bindings));
}

test('direct exhibition join obtains the canonical notice before opening the questionnaire',async()=>{
  let shown,requests=0;
  const member={id:'synthetic-player',name:'Verified Player'};
  const handle=sectionCallback('handleJoinOpenCommunity','handleEventRegistration',{
    EXHIBITION_COMMUNITY_ID,useCallback:fn=>fn,currentMember:member,
    eventProfileRef:{current:'synthetic-profile'},eventRecoveryRef:{current:null},eventJoinGenerationRef:{current:0},updateEventRecovery(){},
    setEventJoin:value=>{shown=value;},setJoiningCommunityId(){},setDetailError(){},setAccessMessage(){},
    redirectToInviteCabinet:()=>false,
    apiAddCommunityMember:async(id,payload)=>{assert.equal(id,EXHIBITION_COMMUNITY_ID);assert.deepEqual(payload,{member});requests++;return{status:422,error:{message:'EVENT_REGISTRATION_REQUIRED'},data:{eventNotice:notice}};},
    applyActionResponse(){},setFocusedCommunityId(){},setSelectedCommunityId(){},communityErrorMessage:()=>'',
  });
  await handle({id:EXHIBITION_COMMUNITY_ID,communityType:'EVENT',typeSettings:{registrationPolicy:policy},typeSettingsRevision:2});
  assert.equal(requests,1,'do not synthesize outdated terms from community settings');
  assert.deepEqual(shown.notice,notice);
});

test('a changed canonical notice updates the open form without an automatic second submission',async()=>{
  let state={community:{id:EXHIBITION_COMMUNITY_ID},notice:{policy,revision:1},profileKey:'synthetic-profile'},requests=0;
  const eventJoinRef={current:state};
  const handle=sectionCallback('handleEventRegistration','handleInviteSubmit',{
    eventJoin:state,currentMember:{id:'synthetic-player'},
    eventJoinRef,eventProfileRef:{current:'synthetic-profile'},eventRecoveryRef:{current:null},eventRegistrationPendingRef:{current:null},
    setEventJoin:value=>{state=typeof value==='function'?value(state):value;eventJoinRef.current=state;},setEventRecovery(){},
    apiAddCommunityMember:async()=>{requests++;return{status:422,error:{message:'EVENT_REGISTRATION_REQUIRED'},data:{eventNotice:notice}};},
    apiJoinCommunityByInvite:async()=>{throw new Error('unexpected invite path');},communityErrorMessage:()=>'',
    applyActionResponse(){},setFocusedCommunityId(){},setSelectedCommunityId(){},setIsInviteOpen(){},setInviteValue(){},setAccessMessage(){},
  });
  const message=await handle({fullName:'Synthetic Participant',company:'Synthetic Company',email:['participant','example.invalid'].join('@'),policyRevision:1});
  assert.deepEqual(state.notice,notice);
  assert.equal(requests,1);assert.match(message,/Условия анкеты обновились/);
});

test('collected phone numbers normalize to the canonical RU form and reject unusable input', async () => {
  const compiled = await build({ entryPoints: ['src/components/cabinet/EventRegistrationForm.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  const normalize = module.exports.normalizeEventPhone;
  for (const [value, expected] of [['+7 (999) 000-00-01', '79990000001'], ['8 999 000 00 01', '79990000001'], ['9990000001', '79990000001'], ['7-999-000-00-01', '79990000001']]) assert.equal(normalize(value), expected);
  for (const value of ['', '12345', '+1 202 555 0147', '999000000', '799900000011']) assert.equal(normalize(value), null);
});

test('public guest hero accepts only a safe https or site-relative logo and a bounded title', () => {
  assert.deepEqual(readExhibitionBrandOverride('?invite=x&brandLogo=https%3A%2F%2Fstatic.tildacdn.com%2Flogo.png&brandTitle=%D0%9A%D0%BE%D1%80%D0%BF%D0%A1%D0%BF%D0%BE%D1%80%D1%82'), { logoUrl: 'https://static.tildacdn.com/logo.png', heading: 'КорпСпорт' });
  assert.deepEqual(readExhibitionBrandOverride('?logo=%2Fassets%2Flogo.svg'), { logoUrl: '/assets/logo.svg' });
  assert.deepEqual(readExhibitionBrandOverride('?brandLogo=javascript%3Aalert(1)&brandTitle='), {});
  assert.deepEqual(readExhibitionBrandOverride('?brandLogo=%2F%2Fevil.example%2Fx.png'), {});
  assert.deepEqual(readExhibitionBrandOverride('?brandTitle=' + 'x'.repeat(121)), {});
});

test('the LK2 push hand-off carries the community return URL without leaking the current query', () => {
  const url = new URL(buildPushOptInUrl('https://padlhub.ru/lk_new?authMode=viva&openCommunity=community_1'));
  assert.equal(url.origin + url.pathname, 'https://lk2.padlhub.su/push');
  assert.equal(url.searchParams.get('returnTo'), 'https://padlhub.ru/lk_new?authMode=viva&openCommunity=community_1');
  assert.equal(new URL(buildPushOptInUrl('')).searchParams.get('returnTo'), null);
});
