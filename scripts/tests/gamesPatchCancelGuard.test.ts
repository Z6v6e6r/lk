import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

type PatchSet = Record<string, unknown> & {
  metadata?: Record<string, unknown>;
  "metadata.lastIgnoredClientCancelPatchReason"?: string;
  "audit.lastEvent"?: {
    payload?: Record<string, unknown>;
  };
};

type PatchDbMessage = {
  payload: {
    $set: PatchSet;
  };
};

test("games patch ignores client-side CANCELLED status and cancellation metadata flags", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_patch.js", {
    req: {
      params: { gameId: "game-1" },
      path: "/lk/games/game-1",
    },
    payload: {
      status: "CANCELLED",
      metadata: {
        vivaExerciseId: "exercise-1",
        cancelledInViva: true,
        canceledInViva: true,
        exerciseMissing: true,
      },
    },
  }) as unknown[];

  const dbMsg = out[0] as PatchDbMessage | undefined;
  assert.ok(dbMsg);
  assert.equal(dbMsg.payload.$set.status, undefined);
  assert.equal(dbMsg.payload.$set.metadata?.cancelledInViva, false);
  assert.equal(dbMsg.payload.$set.metadata?.canceledInViva, false);
  assert.equal(dbMsg.payload.$set.metadata?.exerciseMissing, false);
  assert.equal(dbMsg.payload.$set.metadata?.lastIgnoredClientCancelPatchReason, "GENERIC_PATCH_CANCEL_GUARD");
  assert.equal(dbMsg.payload.$set["audit.lastEvent"]?.payload?.ignoredClientCancelPatch, true);
  assert.equal(dbMsg.payload.$set["audit.lastEvent"]?.payload?.sanitizedCancellationMetadata, true);
});

test("games patch records ignored client cancel even without metadata payload", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_patch.js", {
    req: {
      params: { gameId: "game-1" },
      path: "/lk/games/game-1",
    },
    payload: {
      status: "CANCELLED",
    },
  }) as unknown[];

  const dbMsg = out[0] as PatchDbMessage | undefined;
  assert.ok(dbMsg);
  assert.equal(dbMsg.payload.$set.status, undefined);
  assert.equal(dbMsg.payload.$set["metadata.lastIgnoredClientCancelPatchReason"], "GENERIC_PATCH_CANCEL_GUARD");
  assert.equal(dbMsg.payload.$set["audit.lastEvent"]?.payload?.ignoredClientCancelPatch, true);
});

test("games patch cannot bypass canonical roster commands with a membership generation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_patch.js", {
    req: {
      params: { gameId: "game-1" },
      path: "/lk/games/game-1",
    },
    payload: {
      participants: [{
        id: "client-2",
        name: "Player",
        phone: "+7 999 000-00-02",
        membershipId: "local:membership-generation-1",
      }],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const responseMsg = out[1] as { statusCode?: number; payload?: { code?: string } } | undefined;
  assert.equal(responseMsg?.statusCode, 403);
  assert.equal(responseMsg?.payload?.code, "GAME_ROSTER_COMMAND_REQUIRED");
});
