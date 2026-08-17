import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_ALLOWED_HEADERS = "Content-Type, Authorization, X-API-Key";
const REQUIRED_ALLOWED_HEADERS =
  "Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Correlation-ID";
const TARGETS = [
  {
    id: "nested-games",
    route: "/lk/games/",
    start: /^\s*location\s+\^~\s+\/lk\/games\/\s*\{\s*\r?\n?$/,
  },
];

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function splitLines(source) {
  return source.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function braceDelta(line) {
  let quoted = false;
  let escaped = false;
  let delta = 0;
  for (const character of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "#") break;
    if (character === "{") delta += 1;
    if (character === "}") delta -= 1;
  }
  return delta;
}

function findLocationBlock(lines, target) {
  const starts = lines
    .map((line, index) => (target.start.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length !== 1) {
    throw new Error(`${target.route} location must exist exactly once; found ${starts.length}`);
  }

  const start = starts[0];
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += braceDelta(lines[index]);
    if (depth === 0) return { start, end: index };
    if (depth < 0) break;
  }
  throw new Error(`${target.route} location has unbalanced braces`);
}

function validateAndPatchBlock(lines, target, block) {
  const blockLines = lines.slice(block.start, block.end + 1);
  const blockText = blockLines.join("");
  const hideHeaderMatches = blockText.match(
    /^\s*proxy_hide_header\s+Access-Control-Allow-Headers\s*;\s*$/gm,
  ) || [];
  if (hideHeaderMatches.length !== 1) {
    throw new Error(`${target.route} must hide exactly one upstream Allow-Headers value`);
  }
  if (!/Access-Control-Allow-Methods\s+"[^"]*POST[^"]*OPTIONS[^"]*"\s+always;/.test(blockText)) {
    throw new Error(`${target.route} must allow POST and OPTIONS`);
  }
  if (!/if\s*\(\$request_method\s*=\s*OPTIONS\)\s*\{\s*return\s+204;\s*\}/.test(blockText)) {
    throw new Error(`${target.route} must terminate preflight with 204`);
  }

  const headerLineIndexes = [];
  for (let index = block.start; index <= block.end; index += 1) {
    if (/^\s*add_header\s+Access-Control-Allow-Headers\s+"[^"]*"\s+always;\s*\r?\n?$/.test(lines[index])) {
      headerLineIndexes.push(index);
    }
  }
  if (headerLineIndexes.length !== 1) {
    throw new Error(`${target.route} must define exactly one Allow-Headers value`);
  }

  const headerIndex = headerLineIndexes[0];
  const headerMatch = lines[headerIndex].match(
    /^(\s*add_header\s+Access-Control-Allow-Headers\s+")([^"]*)("\s+always;\s*\r?\n?)$/,
  );
  if (!headerMatch) throw new Error(`${target.route} Allow-Headers line has an unsupported format`);
  const currentValue = headerMatch[2];
  if (currentValue === REQUIRED_ALLOWED_HEADERS) {
    return { changed: false, previousValue: currentValue, nextValue: currentValue };
  }
  if (currentValue !== CURRENT_ALLOWED_HEADERS) {
    throw new Error(`${target.route} has an unmanaged Allow-Headers value`);
  }

  lines[headerIndex] = `${headerMatch[1]}${REQUIRED_ALLOWED_HEADERS}${headerMatch[3]}`;
  return {
    changed: true,
    previousValue: currentValue,
    nextValue: REQUIRED_ALLOWED_HEADERS,
  };
}

export function buildLkGamesCorsCandidate(source, expectedSourceSha256) {
  const sourceSha256 = sha256(source);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(
      `Nginx source SHA mismatch: expected ${expectedSourceSha256}, got ${sourceSha256}`,
    );
  }
  const sourceLines = splitLines(source);
  const lines = [...sourceLines];
  const blocks = TARGETS.map((target) => ({ target, block: findLocationBlock(lines, target) }));
  const results = blocks.map(({ target, block }) => ({
    id: target.id,
    route: target.route,
    ...validateAndPatchBlock(lines, target, block),
  }));
  const changedCount = results.filter((result) => result.changed).length;

  const candidate = lines.join("");
  const candidateSha256 = sha256(candidate);
  const changedLineIndexes = lines
    .map((line, index) => (line === sourceLines[index] ? -1 : index))
    .filter((index) => index >= 0);
  if (changedLineIndexes.length !== changedCount) {
    throw new Error("Candidate changed an unexpected number of nginx lines");
  }

  return {
    candidate,
    changed: changedCount === TARGETS.length,
    sourceSha256,
    candidateSha256,
    changedLineCount: changedLineIndexes.length,
    locations: results,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be provided as --key value pairs");
    }
    args[key] = value;
  }
  return args;
}

function writeCandidate(args) {
  const inputPath = path.resolve(args["--input"] || "");
  const outputPath = path.resolve(args["--output"] || "");
  const reportPath = path.resolve(args["--report"] || "");
  const expectedSourceSha256 = args["--expected-sha256"];
  if (!args["--input"] || !args["--output"] || !args["--report"] || !expectedSourceSha256) {
    throw new Error(
      "Usage: --input <source> --output <candidate> --report <report> --expected-sha256 <sha256>",
    );
  }
  if (new Set([inputPath, outputPath, reportPath]).size !== 3) {
    throw new Error("Input, candidate and report paths must be distinct");
  }
  if (fs.existsSync(outputPath) || fs.existsSync(reportPath)) {
    throw new Error("Refusing to overwrite an existing candidate or report");
  }

  const source = fs.readFileSync(inputPath, "utf8");
  const result = buildLkGamesCorsCandidate(source, expectedSourceSha256);
  const report = {
    ok: true,
    changed: result.changed,
    sourceSha256: result.sourceSha256,
    candidateSha256: result.candidateSha256,
    locations: result.locations,
    invariants: {
      targetLocationCount: result.locations.length,
      changedLocationCount: result.locations.filter((location) => location.changed).length,
      changedLineCount: result.changedLineCount,
      requiredHeaders: ["Idempotency-Key", "X-Correlation-ID"],
    },
  };

  try {
    fs.writeFileSync(outputPath, result.candidate, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    throw error;
  }
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) writeCandidate(parseArgs(process.argv.slice(2)));

export { CURRENT_ALLOWED_HEADERS, REQUIRED_ALLOWED_HEADERS };
