import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const read = path => fs.readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
function load(path, deps = {}) {
  const source = read(path).replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function('exports', 'require', 'Image', compiled)(exports, id => {
    if (id in deps) return deps[id];
    if (id === 'react/jsx-runtime') return require(id);
    throw Error(`Unmocked dependency: ${id}`);
  }, class FixtureImage { set src(_value) { this.onload?.(); } });
  return exports;
}
const helpers = load('utils/levelAdmission.ts');
const { hasLevelRestriction, parseDeclaredLevel } = helpers;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unrated = { id: 'fixture-player', level: { status: 'UNRATED', source: 'CUP_CANONICAL', ratingNumeric: null, rating: null } };
const rated = { ...unrated, level: { status: 'RATED', source: 'CUP_CANONICAL', ratingNumeric: 3.25, rating: 'C' } };
const restricted = { settings: { minRating: 'C', maxRating: 'B+' } };

// Exercise real callbacks across rerenders, with effects flushed deterministically.
function hooks() {
  const slots = []; let index = 0; let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) effects.push(() => {
      slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
    }); },
  };
  return { react, render(fn) { index = 0; const value = fn(); const pending = effects; effects = []; pending.forEach(fn => fn()); return value; } };
}
function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
}
function text(value) {
  if (value == null || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join(' ');
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}
function button(tree, label) { const found = nodes(tree).find(n => n.type === 'button' && text(n).trim() === label); assert.ok(found, label); return found.props; }
function gate(fetchProfile) {
  const h = hooks(); let token = 'fixture-session'; let target = 'fixture-event';
  const { useLevelOnboardingGate } = load('components/onboarding/useLevelOnboardingGate.tsx', {
    react: h.react, '../../utils/apiClient': { apiFetchProfile: fetchProfile },
    '../../utils/levelAdmission': helpers, '../../utils/authTokenStorage': { readAuthToken: () => token },
    '../UI/Modal': { Modal: 'modal' }, '../cabinet/OnboardingModal': { OnboardingModal: 'onboarding' },
  });
  const render = () => h.render(() => useLevelOnboardingGate(target));
  render();
  return { render, setToken(value) { token = value; }, setTarget(value) { target = value; render(); } };
}

test('only explicit admission limits require onboarding, including skins, subdivisions and training titles', () => {
  for (const event of [restricted, { accessLevels: ['3.25'] }, { levelLabel: 'C1–B+4' },
    { raw: { skin: { accessLevels: ['C+'] } } }, { name: 'Тренировка, уровень D–D+' },
    { direction: { name: 'Групповая уровня C' } }, { settings: { maxRating: 4.2 } },
    { metadata: { ratingRangePrecise: { minGrade: 'C', minLevel: 2 } } }]) assert.equal(hasLevelRestriction(event), true, JSON.stringify(event));
  for (const event of [null, {}, { levelLabel: 'Любой уровень' }, { name: 'Без уровня' },
    { settings: { ratingGame: true } }, { params: { minRating: 1, maxRating: 7 } },
    { description: 'История: уровень C' }, { levelLabel: 'Уровень уточняется' }]) assert.equal(hasLevelRestriction(event), false, JSON.stringify(event));
  const cycle = {}; cycle.raw = cycle; assert.equal(hasLevelRestriction(cycle), false);
});
test('known level accepts the existing 1–7 precision and rejects partial or invented values', () => {
  for (const [value, expected] of [['1', 1], ['7', 7], [' 3,25 ', 3.25], ['4.12345', 4.12345]]) assert.equal(parseDeclaredLevel(value), expected);
  for (const value of ['', 'C', '3x', '3,', '0', '7.1', 'Infinity', '1e0', '3.123456']) assert.equal(parseDeclaredLevel(value), null);
});
test('unrestricted events do not request a level; restricted rated clients use fresh CUP data', async () => {
  let calls = 0;
  const g = gate(async () => { calls++; return { data: rated }; });
  assert.equal(await g.render().checkLevel({}), true); assert.equal(calls, 0);
  assert.equal(await g.render().checkLevel(restricted, rated.id), true); assert.equal(calls, 1);
  assert.equal(g.render().levelProfileRef.current, rated);
});
test('missing level prompts existing onboarding, with return to the selected event and no automatic booking', async () => {
  const g = gate(async () => ({ data: unrated }));
  assert.equal(await g.render().checkLevel(restricted, unrated.id), false);
  let dialog = g.render().levelOnboardingDialog;
  assert.match(text(dialog), /ограничение по уровню/);
  button(dialog, 'Пройти онбординг').onClick();
  dialog = g.render().levelOnboardingDialog;
  assert.equal(dialog.type, 'onboarding'); assert.equal(dialog.props.profile, unrated); assert.equal(dialog.props.returnToEvent, true);
  dialog.props.onClose(); assert.equal(g.render().levelOnboardingDialog, null);
});
test('failure, missing canonical metadata, invalid ratings or another actor never offer a first assignment', async () => {
  for (const result of [{ error: { status: 503 } }, { data: { id: unrated.id } },
    { data: { ...rated, id: 'different-player' } }, { data: { ...rated, level: { ...rated.level, ratingNumeric: null } } },
    { data: { ...unrated, level: { ...unrated.level, status: 'UNAVAILABLE' } } }]) {
    const g = gate(async () => result);
    assert.equal(await g.render().checkLevel(restricted, unrated.id), false);
    const dialog = g.render().levelOnboardingDialog;
    assert.match(dialog.props.title, /Не удалось/);
    assert.equal(nodes(dialog).some(n => text(n) === 'Пройти онбординг'), false);
  }
});
test('slow checks cannot continue a changed event/session; repeated clicks share no write', async () => {
  for (const change of ['target', 'session']) {
    const d = deferred(); let calls = 0;
    const g = gate(() => { calls++; return d.promise; });
    const pending = g.render().checkLevel(restricted, rated.id);
    assert.equal(await g.render().checkLevel(restricted, rated.id), false); assert.equal(calls, 1);
    if (change === 'target') g.setTarget('other-event'); else g.setToken('other-session');
    d.resolve({ data: rated }); assert.equal(await pending, false); assert.equal(g.render().levelOnboardingDialog, null);
  }
});
function onboarding(save) {
  const h = hooks(); const calls = []; const events = [];
  const { OnboardingModal } = load('components/cabinet/OnboardingModal.tsx', {
    react: h.react, '../../utils/playerLevel': load('utils/playerLevel.ts'), '../../utils/levelAdmission': helpers,
    '../UI/Modal': { Modal: 'modal' }, '../../utils/apiClient': { apiSaveOnboardingLevel: async payload => { calls.push(payload); return save(payload); } },
    '../../utils/customFields': load('utils/customFields.ts'), '../../utils/lkAssetBaseUrls': { resolvePreferredLkAssetUrl: x => x },
    '../../utils/analytics': { identifyAnalyticsUser() {}, trackAnalyticsEvent() {}, trackClientError() {} },
    '../../utils/hashActions': { resolveHashActionTarget: () => null, retriggerHashAction() {} },
  });
  const render = () => h.render(() => OnboardingModal({ isOpen: true, profile: unrated, onClose() {}, gamesLink: '#', trainingLink: '#', tournamentsLink: '#', returnToEvent: true, onProfileUpdated: value => events.push(value) }));
  return { render, calls, events };
}
test('known-level path saves through existing onboarding contract and shows success only after canonical acknowledgement', async () => {
  const d = deferred(); const form = onboarding(() => d.promise);
  button(form.render(), 'Знаю свой уровень').onClick();
  const input = nodes(form.render()).find(n => n.type === 'input'); input.props.onChange({ target: { value: '3,25' } });
  const saving = button(form.render(), 'Сохранить уровень').onClick();
  assert.equal(form.calls.length, 1); assert.equal(form.calls[0].levelNumeric, '3,25000');
  assert.doesNotMatch(text(form.render()), /Готово!/); assert.equal(form.events.length, 0);
  d.resolve({ status: 200, data: { items: [{ clientId: unrated.id, ...rated.level }] } }); await saving;
  assert.match(text(form.render()), /Готово!/); assert.equal(form.events.length, 1);
  assert.equal(button(form.render(), 'Вернуться к записи').disabled, undefined);
});
test('failed first assignment stays editable without a false completion', async () => {
  const form = onboarding(() => ({ status: 503, error: { message: 'unavailable' } }));
  button(form.render(), 'Знаю свой уровень').onClick();
  nodes(form.render()).find(n => n.type === 'input').props.onChange({ target: { value: '3.5' } });
  await button(form.render(), 'Сохранить уровень').onClick();
  assert.doesNotMatch(text(form.render()), /Готово!/); assert.match(text(form.render()), /Не удалось сохранить/); assert.equal(form.events.length, 0);
  assert.equal(button(form.render(), 'Сохранить уровень').disabled, false);
});

test('existing questionnaire still calculates and saves the same first branch', async () => {
  const form = onboarding(() => ({ status: 200, data: { items: [{ clientId: unrated.id, ...rated.level }] } }));
  button(form.render(), 'Определить по анкете').onClick();
  for (const [index, answer] of ['Меньше месяца', 'Нет', 'Попробовать новое', 'Обычно сложно дается', 'Сидеть и отдыхать'].entries()) {
    form.render();
    button(form.render(), answer).onClick();
    if (index < 4) button(form.render(), 'Далее').onClick();
    else await button(form.render(), 'Получить рейтинг').onClick();
  }
  assert.equal(form.calls.length, 1); assert.equal(form.calls[0].levelNumeric, '1,00000');
  assert.equal(form.calls[0].levelLetter, 'D'); assert.match(text(form.render()), /Готово!/);
});

function callback(path, name, dependencies) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) arrow = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(arrow);
  const compiled = ts.transpileModule(`const callback = ${arrow.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), compiled + '\nreturn callback;')(...Object.values(dependencies));
}
test('checkout replacement during level verification stops both event writers before the first write', async () => {
  for (const kind of ['training', 'tournament']) {
    const d = deferred(), requestRef = { current: 1 }; let writes = 0;
    const checkout = { profile: { ...unrated, phone: '70000000000' }, exercise: { id: 'fixture-event' } };
    const dependencies = {
      subscriptionUsageShadowEnabled: false, selectedId: 'fixture-event', selectedExerciseId: 'fixture-event',
      actionLoading: false, isAuthenticated: true, isRestoringSession: false, checkout,
      discountPending: false, discountError: null, TRIAL_GROUP_CHECKOUT_ENABLED: false,
      detail: restricted, selectedTournament: restricted,
      registrationRequestIdRef: requestRef, checkoutRequestIdRef: requestRef,
      checkLevel: () => d.promise, readAuthToken: () => 'fixture-session',
      apiCreateTournamentVivaTransaction: () => { writes++; throw Error('stale checkout write'); },
    };
    const fn = kind === 'training'
      ? callback('components/group-schedule/GroupSchedulePage.tsx', 'completeRegistration', dependencies)
      : callback('components/tournament-signup/TournamentSignupPage.tsx', 'completeVivaRegistration', dependencies);
    const pending = kind === 'training' ? fn({ id: 'fixture-event' }, checkout, {}) : fn(checkout, { source: 'one-time' });
    requestRef.current += 1; d.resolve(true); await pending; assert.equal(writes, 0);
  }
});
