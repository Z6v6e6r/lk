import fs from "node:fs";

const probe = JSON.parse(process.env.LEGACY_RESULT_OUTBOX_REPLAY_PROBE || "null");
if (!probe?.sourcePath || !probe?.outbox) throw new Error("Result outbox replay probe configuration is required");
const source = fs.readFileSync(probe.sourcePath, "utf8");
const outputs = new Function("msg", source)({ _resultConfirmReplayOutbox: probe.outbox });
process.stdout.write(`${JSON.stringify({
  ratings: Array.isArray(outputs?.[0]?.payload),
  response: Number(outputs?.[1]?.statusCode) === 200,
  debug: Number(outputs?.[2]?.statusCode) === 200,
  event: Boolean(outputs?.[3]?.payload),
  sync: Boolean(outputs?.[0]?._resultVivaSyncBatch || outputs?.[4]?._resultVivaSyncBatch),
})}\n`);
