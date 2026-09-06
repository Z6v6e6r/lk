// Runs only in the explicitly created disposable audit container.
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire("/runtime/package.json");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const save = (name, bytes) => fs.writeFileSync(`/out/${name}`, bytes, { mode: 0o600, flag: "wx" });
const initial = ["package.json", "package-lock.json", "partner-package/package.json", "partner-package/package-lock.json"];
const hashes = () => Object.fromEntries(initial.map(name => [name, sha(fs.readFileSync(`/runtime/${name}`))]));
const before = hashes();
const commands = [];
const config = ["--registry=https://registry.npmjs.org/", "--userconfig=/dev/null", "--globalconfig=/input/empty-global.npmrc", "--cache=/tmp/npm-cache", "--fetch-retries=0", "--fetch-timeout=30000"];
function npm(name, args, allowedExitCodes) {
  const startedAt = new Date().toISOString();
  const result = spawnSync("npm", [...args, ...config], { cwd: "/runtime", encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH } });
  save(`${name}.stdout`, result.stdout || ""); save(`${name}.stderr`, result.stderr || "");
  if (result.error || result.signal || !allowedExitCodes.includes(result.status)) throw new Error(`AUDIT_${name.toUpperCase()}_FAILED`);
  commands.push({ name, args: [...args, ...config], startedAt, completedAt: new Date().toISOString(), exitCode: result.status,
    stdoutSha256: sha(Buffer.from(result.stdout)), stderrSha256: sha(Buffer.from(result.stderr)) });
  return result.stdout;
}
const npmVersion = npm("version", ["--version"], [0]).trim();
if (process.platform !== "linux" || process.arch !== "x64" || process.version !== "v22.23.2" || npmVersion !== "10.9.8") throw new Error("AUDIT_RUNTIME_IDENTITY_MISMATCH");
npm("install", ["ci", "--ignore-scripts", "--no-fund", "--no-audit"], [0]);
const tree = JSON.parse(npm("tree", ["ls", "--all", "--json", "--omit=dev"], [0]));
if (tree.problems?.length) throw new Error("AUDIT_DEPENDENCY_TREE_INVALID");
const audit = JSON.parse(npm("audit", ["audit", "--omit=dev", "--json", "--ignore-scripts"], [0, 1]));
if (audit.error || audit.auditReportVersion !== 2 || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) throw new Error("AUDIT_RESPONSE_INVALID");
if (require("node-red/package.json").version !== "5.0.6" || JSON.stringify(before) !== JSON.stringify(hashes())) throw new Error("AUDIT_INPUT_DRIFT");
const record = { scope: "LOCAL_INSTALLED_LINUX_RUNTIME_AUDIT", platform: process.platform, architecture: process.arch,
  nodeVersion: process.version.slice(1), npmVersion, nodeRedVersion: require("node-red/package.json").version,
  inputs: before, commands, capturedAt: commands.at(-1).completedAt, audit,
  dependenciesInstalled: true, lifecycleScriptsExecuted: false, auditFixExecuted: false, productionTouched: false };
save("audit-observation.json", JSON.stringify(record, null, 2) + "\n");
