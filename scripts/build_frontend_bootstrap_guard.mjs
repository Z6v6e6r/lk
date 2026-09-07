import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FRONTEND_BOOTSTRAP_GUARD_IMAGE = "node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
export const FRONTEND_BOOTSTRAP_GUARD_FLAGS = Object.freeze([
  "-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
  "-ffile-prefix-map=/src=.", "-Wl,--build-id=none", "-s",
]);
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_SOURCE = "scripts/frontend_bootstrap_guard.c";
const LAUNCHER_SOURCE = "scripts/frontend_bootstrap_exec_launcher.c";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: REPOSITORY, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) fail(String(result.stderr || result.stdout || result.error?.message).trim());
  return String(result.stdout || "").trim();
};
const assertElf = (bytes) => {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46"
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) fail("Guard is not Linux amd64 ELF64");
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  for (let index = 0; index < count; index += 1) {
    const type = bytes.readUInt32LE(offset + index * size);
    if (type === 2 || type === 3) fail("Guard must be statically linked");
  }
};

const build = ({ sourceBytes, sourcePath, label }) => {
  const source = sourceBytes || fs.readFileSync(path.join(REPOSITORY, sourcePath));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-bootstrap-guard-"));
  try {
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(path.join(root, `${label}.c`), source, { flag: "wx", mode: 0o400 });
    const caller = `${process.getuid()}:${process.getgid()}`;
    const command = [
      "gcc", ...FRONTEND_BOOTSTRAP_GUARD_FLAGS, "-o", `/out/${label}-a`, `/out/${label}.c`,
      "&&", "gcc", ...FRONTEND_BOOTSTRAP_GUARD_FLAGS, "-o", `/out/${label}-b`, `/out/${label}.c`,
    ].join(" ");
    run("docker", ["run", "--rm", "--network", "none", "--platform", "linux/amd64",
      "--user", caller, "--mount", `type=bind,src=${root},dst=/out`, FRONTEND_BOOTSTRAP_GUARD_IMAGE,
      "sh", "-lc", command]);
    const first = fs.readFileSync(path.join(root, `${label}-a`));
    const second = fs.readFileSync(path.join(root, `${label}-b`));
    if (!first.equals(second)) fail(`Frontend bootstrap ${label} build is not reproducible`);
    assertElf(first);
    return { bytes: first, sha256: sha256(first), sourceSha256: sha256(source),
      image: FRONTEND_BOOTSTRAP_GUARD_IMAGE, flags: [...FRONTEND_BOOTSTRAP_GUARD_FLAGS] };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export const buildFrontendBootstrapGuard = ({ sourceBytes } = {}) => build({
  sourceBytes, sourcePath: GUARD_SOURCE, label: "guard",
});

export const buildFrontendBootstrapLauncher = ({ sourceBytes } = {}) => build({
  sourceBytes, sourcePath: LAUNCHER_SOURCE, label: "launcher",
});
