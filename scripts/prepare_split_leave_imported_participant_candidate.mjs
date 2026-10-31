#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildFunctionOnlyContract, validateFunctionOnlyContract, sha256 } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Reviewed function-only candidate for one defect: a participant that exists in
// the LK roster but holds no bookable record of their own could never leave the
// game. `verify_history` aborted with 409 "Не удалось зафиксировать поколение
// записи" and persisted nothing, so every retry failed identically.
//
// The fix is applied as a minimal in-place patch to the exact live function body
// of the router node. The live body is narrower than the tracked source on
// origin/main (main also carries the CUP staff targets), so deploying the whole
// tracked file would activate unrelated provider writes. Everything else is
// byte-identical to the verified live preimage.
export const DEPLOYMENT_ID = "split-leave-imported-participant-20260915";

export const ROUTER_NODE = Object.freeze({
  id: "9878400d518ebcbd",
  name: "Route split leave booking cancel",
  file: "fn_split_leave_router.js",
  liveSha256: "4411495cc679ddde0724f8eda9aa1dcf8c06dcca1adf276df65422438b14d7c3",
});

export const TARGETS = Object.freeze([ROUTER_NODE]);

const ANCHOR_START = "    ctx.preCancelVerification = false;\n    ctx.vivaVerifiedAt = new Date().toISOString();\n    ctx.vivaVerification = \"no_active_booking_for_exercise\";\n    ctx.successMessage = \"Вы вышли из игры\";\n    appendTrace(ctx, { step: \"viva_verified_no_active_booking\" });\n    if (!ctx.membershipVersion) {\n      return fail(ctx, 409, \"CONFLICT\", \"Не удалось зафиксировать поколение записи\");\n    }\n    ctx.vivaTargetMode = \"NONE\";\n";

export const PATCHED_BLOCK = `    ctx.preCancelVerification = false;
    ctx.vivaVerifiedAt = new Date().toISOString();
    ctx.vivaVerification = "no_active_booking_for_exercise";
    ctx.successMessage = "Вы вышли из игры";
    appendTrace(ctx, { step: "viva_verified_no_active_booking" });
    // Read-back proved this exercise holds no live booking, so there is no Viva
    // booking id to anchor the membership generation. For a participant that was
    // imported into the roster without any locally recorded booking of their own
    // there is nothing left to reconcile, and without an anchor every attempt
    // died here with 409 while leaving nothing durable - the player could never
    // leave the game at all. Anchor that shape on the frozen game snapshot: a
    // rejoin or roster move bumps updatedAt and yields a new generation, while
    // retries of the same snapshot reuse one idempotent operation. A payment row
    // of this very player that does carry a booking identifier still fails
    // closed, because that identifier can be reconciled elsewhere.
    const sameValue = (left, right) => Boolean(
      left && right && String(left).trim().toLowerCase() === String(right).trim().toLowerCase(),
    );
    const paymentBelongsToTarget = (item) => {
      const clientId = item.clientId || item.playerId || item.userId;
      const phone = item.phoneNorm || item.phone || item.clientPhoneNorm || item.clientPhone;
      if (!toStr(clientId) && !toStr(phone)) return true;
      return sameValue(clientId, ctx.targetClientId) || sameValue(phone, ctx.targetPhoneNorm);
    };
    const hasTargetLocalBookingAnchor = asArray(ctx.game?.metadata?.splitPayment?.payments)
      .filter(isObj)
      .filter(paymentBelongsToTarget)
      .some((item) => Boolean(
        toStr(item.bookingId)
        || asArray(item.bookingIds).some((bookingId) => Boolean(toStr(bookingId))),
      ));
    if (!ctx.membershipVersion) {
      if (hasTargetLocalBookingAnchor) {
        return fail(ctx, 202, "RETRY_REQUIRED", "Не удалось подтвердить отмену записи Viva. Обновите игру и повторите выход.");
      }
      if (!assignMembershipVersion(ctx, [
        "no-active-booking",
        ctx.gameId,
        ctx.targetClientId || ctx.targetPhoneNorm,
        ctx.game?.updatedAt,
      ])) {
        return fail(ctx, 409, "CONFLICT", "Не удалось зафиксировать поколение записи");
      }
    }
    ctx.vivaTargetMode = "NONE";
`;

// Pure text patch. Fails closed unless the verified live body carries exactly one
// occurrence of the reviewed anchor.
export function patchRouterBody(body) {
  const occurrences = body.split(ANCHOR_START).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Reviewed router anchor matched ${occurrences} times, expected 1`);
  }
  const patched = body.replace(ANCHOR_START, PATCHED_BLOCK);
  // The patch must not touch anything outside the reviewed anchor.
  if (patched.slice(0, body.indexOf(ANCHOR_START)) !== body.slice(0, body.indexOf(ANCHOR_START))) {
    throw new Error("Reviewed router patch changed the preimage prefix");
  }
  new vm.Script(`(function(msg,node,context,flow,global,env){\n${patched}\n})`);
  return patched;
}

export function buildCandidate(liveBytes) {
  const candidate = JSON.parse(liveBytes);
  const nodes = candidate.filter((node) => node.id === ROUTER_NODE.id);
  if (nodes.length !== 1 || nodes[0].type !== "function") {
    throw new Error(`Leave function preimage drift: ${ROUTER_NODE.id}`);
  }
  if (sha256(nodes[0].func) !== ROUTER_NODE.liveSha256) {
    throw new Error("Live split leave router body drift");
  }
  nodes[0].func = patchRouterBody(nodes[0].func);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
  const args = {
    liveBytes,
    candidateBytes,
    deploymentId: DEPLOYMENT_ID,
    allowedNodeIds: TARGETS.map((target) => target.id),
  };
  const contract = buildFunctionOnlyContract(args);
  validateFunctionOnlyContract({ ...args, contract });
  const reverse = buildFunctionOnlyContract({ ...args, liveBytes: candidateBytes, candidateBytes: liveBytes });
  validateFunctionOnlyContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  return { candidateBytes, contract, reverse };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--workspace") {
    throw new Error("Usage: --workspace <fresh-private-live-workspace>");
  }
  const verified = verifyWorkspace(process.argv[3], { quiet: true });
  const result = buildCandidate(fs.readFileSync(verified.sourcePath));
  const output = path.join(verified.workspace, "build-split-leave-imported-participant");
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of Object.entries({
    "candidate.flow.json": result.candidateBytes,
    "contract.json": JSON.stringify(result.contract, null, 2) + "\n",
    "structural-reverse.contract.json": JSON.stringify(result.reverse, null, 2) + "\n",
  })) fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(result.candidateBytes),
    changedFunctions: TARGETS.length,
    deploymentId: DEPLOYMENT_ID,
    deploymentPerformed: false,
  }));
}
