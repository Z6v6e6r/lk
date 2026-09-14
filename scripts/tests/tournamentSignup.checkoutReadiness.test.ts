import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const pageSource = fs.readFileSync(
  "src/components/tournament-signup/TournamentSignupPage.tsx",
  "utf8",
);

test("automatic tournament checkout waits for the current registration lookup", () => {
  assert.match(
    pageSource,
    /const \[registrationResolvedFor, setRegistrationResolvedFor\] = useState<string \| null>\(null\)/,
  );

  const loadDetailStart = pageSource.indexOf("const loadDetail = useCallback");
  const loadDetailEnd = pageSource.indexOf("const ensurePricingPreviewLoaded", loadDetailStart);
  const loadDetailSource = pageSource.slice(loadDetailStart, loadDetailEnd);
  const lookupStart = loadDetailSource.indexOf("setRegistrationResolvedFor(null)");
  const lookupAwait = loadDetailSource.indexOf("await Promise.all");
  const registrationCommit = loadDetailSource.indexOf("setRegistration(resolvedRegistration)");
  const resolutionCommit = loadDetailSource.indexOf(
    "setRegistrationResolvedFor(`${tournamentId}:${exerciseId}`)",
  );

  assert.ok(lookupStart >= 0, "detail load must clear a stale registration resolution");
  assert.ok(lookupAwait > lookupStart, "registration lookup must start after clearing the resolution");
  assert.ok(registrationCommit > lookupAwait, "registration state must be committed after the lookup");
  assert.ok(
    resolutionCommit > registrationCommit,
    "the current tournament/exercise key must be resolved only after registration state",
  );

  const checkoutGateStart = pageSource.indexOf("const registrationResolutionKey");
  const checkoutGateEnd = pageSource.indexOf("useEffect(() =>", checkoutGateStart);
  const checkoutGateSource = pageSource.slice(checkoutGateStart, checkoutGateEnd);
  const resolutionGuard = checkoutGateSource.indexOf(
    "registrationResolvedFor !== registrationResolutionKey",
  );
  const checkoutStart = checkoutGateSource.indexOf("void loadCheckout(mode)");

  assert.ok(resolutionGuard >= 0, "automatic checkout must verify the current resolution key");
  assert.ok(checkoutStart > resolutionGuard, "checkout must start only after the resolution guard");
});

test("failed or empty checkout settles once; only manual retry or a changed actor/event starts another request", async () => {
  const source = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effectBody: ts.Node | undefined;
  let loadBody: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
      && node.arguments[0]?.getText(source).includes("const registrationResolutionKey")) effectBody = node.arguments[0];
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "loadCheckout"
      && node.initializer && ts.isCallExpression(node.initializer)) loadBody = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(effectBody);
  assert.ok(loadBody);
  const compile = (node: ts.Node, dependencies: Record<string, unknown>) => {
    const code = ts.transpileModule(`const callback = ${node.getText(source)}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(dependencies), `${code}; return callback;`)(...Object.values(dependencies));
  };

  const emptyCheckout = { oneTimes: [], subscriptions: [], clientSubscriptions: [], purchasedProducts: [], customPricing: null };
  for (const result of [{ data: null, error: { message: "Fixture service unavailable" } }, { data: emptyCheckout, error: null }]) {
    const state = { checkoutPreparedFor: null as string | null, checkout: null, actionLoading: false,
      checkoutContextKey: "event:exercise:auth:actor-a", selectedId: "event", selectedExerciseId: "exercise",
      registrationResolvedFor: "event:exercise", error: null as string | null };
    let requests = 0;
    const pending: Promise<void>[] = [];
    const common = {
      subscriptionUsageShadowEnabled: false, canRegister: true, isAuthenticated: true, isRestoringSession: false,
      setCheckoutPreparedFor: (key: string | null) => { state.checkoutPreparedFor = key; },
      setCheckout: (value: null) => { state.checkout = value; },
      setActionLoading: (value: boolean) => { state.actionLoading = value; },
      setError: (value: string | null) => { state.error = value; },
      setCheckoutResolvedFor: () => {}, checkoutRequestIdRef: { current: 0 }, detail: null, selectedTournament: null,
      findTournamentSkinPriceLabel: () => null,
      apiFetchTournamentVivaCheckout: async () => { requests++; return result; },
      apiFetchTournamentVivaPublicCheckout: async () => { throw new Error("Unexpected guest checkout"); },
    };
    const loadCheckout = (mode: string) => {
      const promise = compile(loadBody!, { ...common, ...state })(mode);
      pending.push(promise);
      return promise;
    };
    const renderEffect = () => compile(effectBody!, { ...common, ...state, loadCheckout })();
    renderEffect();
    await pending.at(-1);
    assert.equal(requests, 1);
    assert.equal(state.actionLoading, false);
    assert.equal(state.checkout, null);
    assert.ok(state.error);
    for (let render = 0; render < 5; render++) renderEffect();
    assert.equal(requests, 1, "settled errors and empty results must not cause render-driven network retries");

    await loadCheckout("auth");
    renderEffect();
    assert.equal(requests, 2, "explicit retry performs one new request and settles again");

    state.checkoutContextKey = "event:exercise:auth:actor-b";
    renderEffect();
    await pending.at(-1);
    renderEffect();
    assert.equal(requests, 3, "a new actor gets one fresh checkout");

    state.selectedId = "another-event";
    state.selectedExerciseId = "another-exercise";
    state.registrationResolvedFor = "another-event:another-exercise";
    state.checkoutContextKey = "another-event:another-exercise:auth:actor-b";
    renderEffect();
    await pending.at(-1);
    renderEffect();
    assert.equal(requests, 4, "a new event gets one fresh checkout");
  }
  assert.match(pageSource, /onClick=\{\(\) => void loadCheckout\(isAuthenticated \? "auth" : "public"\)\}/);
});
