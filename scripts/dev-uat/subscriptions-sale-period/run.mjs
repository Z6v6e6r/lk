#!/usr/bin/env node

import { executeMode, loadInputs, parseCli, UatError, writeEvidence } from "./lib.mjs";

async function main() {
  let mode;
  let inputs;
  try {
    ({ mode } = parseCli(process.argv.slice(2)));
    inputs = loadInputs(process.env);
    const result = await executeMode({ mode, inputs });
    process.stdout.write([
      `mode=${mode}`,
      `status=${result.report.status}`,
      "defaultModeNoWrites=PASS",
      `runId=${result.runId}`,
      `json=${result.jsonPath}`,
      `markdown=${result.markdownPath}`,
    ].join("\n") + "\n");
    if (["BLOCKED", "FAIL"].includes(result.report.status)) process.exitCode = 2;
  } catch (error) {
    const safe = error instanceof UatError
      ? { code: error.code, message: error.message }
      : { code: "UNEXPECTED_RUNNER_ERROR", message: "Runner stopped on an unexpected error" };
    if (mode && inputs) {
      try {
        const result = writeEvidence({
          inputs,
          runId: mode === "observe-after" && inputs.DEV_UAT_RUN_ID ? inputs.DEV_UAT_RUN_ID : undefined,
          basename: mode === "preflight" ? "report" : `${mode}-error`,
          report: {
            schemaVersion: 1,
            mode,
            status: mode === "observe-after" ? "FAIL" : "BLOCKED",
            noWrites: true,
            checks: [{ name: "RUNNER", status: "FAIL", code: safe.code }],
          },
        });
        process.stderr.write(`${JSON.stringify(safe)}\n`);
        process.stderr.write(`report=${result.jsonPath}\n`);
        process.exitCode = 2;
        return;
      } catch {
        // Fall through to the minimal redacted diagnostic below.
      }
    }
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.stderr.write('{"code":"UNEXPECTED_RUNNER_ERROR","message":"Runner stopped on an unexpected error"}\n');
  process.exitCode = 1;
});
