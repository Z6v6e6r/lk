import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

function extractFunctionBody(source: string, marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);

  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }

  assert.fail(`Cannot extract body: ${marker}`);
}

const extractExerciseIdFunctionSource = ts.transpileModule(
  `function extractExerciseIdFromPaymentPayload(payload: unknown): string | null ${extractFunctionBody(
    apiClientSource,
    "function extractExerciseIdFromPaymentPayload",
  )}`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const extractExerciseIdFromPaymentPayload = new Function(
  "isRecord",
  `${extractExerciseIdFunctionSource}; return extractExerciseIdFromPaymentPayload;`,
)(
  (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
) as (payload: unknown) => string | null;

test("self-pay payment normalization keeps Viva exercise identity", () => {
  assert.equal(
    extractExerciseIdFromPaymentPayload({ vivaExerciseId: " exercise-direct " }),
    "exercise-direct",
  );
  assert.equal(
    extractExerciseIdFromPaymentPayload({ data: { booking: { exercise: { id: "exercise-nested" } } } }),
    "exercise-nested",
  );
  assert.equal(
    extractExerciseIdFromPaymentPayload({ result: { exercise_id: "exercise-snake" } }),
    "exercise-snake",
  );
  assert.equal(
    extractExerciseIdFromPaymentPayload({
      paymentUrl: "https://bank.example/pay?bookingId=booking-1&exerciseId=exercise-from-url",
    }),
    "exercise-from-url",
  );
  assert.equal(
    extractExerciseIdFromPaymentPayload({ bookingId: "booking-only" }),
    null,
  );
});

test("ordinary self-pay drafts and direct records copy exercise ID into booking and metadata", () => {
  const start = gamesPageSource.indexOf("const handleMasterServicePay = useCallback");
  const end = gamesPageSource.indexOf("const handleCreateGameFromBooking = useCallback", start);
  assert.ok(start >= 0 && end > start, "Cannot isolate ordinary self-pay handler");
  const handler = gamesPageSource.slice(start, end);

  assert.match(
    handler,
    /normalizeBookingId\(paymentResult\.data\?\.vivaExerciseId\)[\s\S]*?\?\? normalizeBookingId\(paymentResult\.data\?\.exerciseId\)/,
  );
  assert.equal((handler.match(/exerciseId: resolvedExerciseId/g) || []).length, 4);
  assert.equal((handler.match(/vivaExerciseId: resolvedExerciseId/g) || []).length, 4);
});
