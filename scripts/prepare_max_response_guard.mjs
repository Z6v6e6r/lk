import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CLIENT = 'dist/core/network/api/client.js';
const MESSAGES = 'dist/core/network/api/modules/messages/api.js';
const HELPER = 'dist/core/network/api/max-response-guard.cjs';
const preimages = {
  [CLIENT]: '5287d8c7f596fe9d11c79d2ed32d074c788302860d42b9303b169d1e60ce6c77',
  [MESSAGES]: 'fa2b34c762f0c912c9e923ffe9cdf4c70f054fda19b124bd34adb6c1751b1769',
};
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const fail = code => { throw new Error(code); };

function privateSourceFile(root, relative) {
  const file = path.join(root, relative);
  if (fs.realpathSync(file) !== file) fail('MAX_SDK_SOURCE_ALIAS');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail('MAX_SDK_SOURCE_NOT_REGULAR');
  return fs.readFileSync(file, 'utf8');
}

export function buildSources(client, messages) {
  for (const [relative, source] of [[CLIENT, client], [MESSAGES, messages]]) {
    if (sha(source) !== preimages[relative]) fail('MAX_SDK_SOURCE_DRIFT');
  }
  const guard = fs.readFileSync(path.join(repository, 'scripts/max-response-guard.cjs'), 'utf8');
  const oldDebug = 'debug(`Call method ${httpMethod} /${method}`, JSON.stringify(callOptions, null, 2));';
  const patchedClient = client
    .replace('const defaultOptions = {', 'const { parseMaxJsonResponse } = require("./max-response-guard.cjs");\nconst defaultOptions = {')
    .replace(oldDebug, "debug('MAX_HTTP_REQUEST');")
    .replace("method: httpMethod };", "method: httpMethod, redirect: 'manual' };")
    .replace('data: await res.json(),', 'data: await parseMaxJsonResponse(res),');
  // Remove the recursive attachment.not.ready send path, including its timer/log.
  const start = messages.indexOf('        this.send = async');
  const end = messages.indexOf('        this.edit = async', start);
  const singleSend = `        this.send = async ({ chat_id, user_id, disable_link_preview, ...body }) => {
            return this._post('messages', {
                body,
                query: { chat_id, user_id, disable_link_preview },
            });
        };
`;
  const patchedMessages = (messages.slice(0, start) + singleSend + messages.slice(end))
    .replace('const promises_1 = require("node:timers/promises");\n', '')
    .replace('const error_1 = require("../../error");\n', '');
  return { [CLIENT]: patchedClient, [MESSAGES]: patchedMessages, [HELPER]: guard };
}

export function prepareCandidate(sdkRoot, output) {
  if (!sdkRoot || !output || !path.isAbsolute(sdkRoot) || !path.isAbsolute(output)
    || path.normalize(sdkRoot) !== sdkRoot || path.normalize(output) !== output) fail('MAX_ABSOLUTE_CANONICAL_PATH_REQUIRED');
  if (fs.realpathSync(sdkRoot) !== sdkRoot || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) fail('MAX_PATH_ALIAS');
  if (inside(output, sdkRoot) || inside(output, repository)) fail('MAX_EXTERNAL_CANDIDATE_REQUIRED');
  if (fs.existsSync(output) || fs.lstatSync(path.dirname(output)).isSymbolicLink()) fail('MAX_OUTPUT_EXISTS_OR_ALIAS');
  const metadata = JSON.parse(privateSourceFile(sdkRoot, 'package.json'));
  if (metadata.name !== '@maxhub/max-bot-api' || metadata.version !== '0.2.2') fail('MAX_SDK_VERSION_MISMATCH');
  const client = privateSourceFile(sdkRoot, CLIENT), messages = privateSourceFile(sdkRoot, MESSAGES);
  if (fs.existsSync(path.join(sdkRoot, HELPER))) fail('MAX_SDK_HELPER_ALREADY_EXISTS');
  const files = buildSources(client, messages);
  const manifest = {
    formatVersion: 1, package: '@maxhub/max-bot-api', version: '0.2.2',
    operation: 'CANDIDATE_ONLY', automaticSendRetries: false, automaticRedirects: false, installed: false,
    files: Object.entries(files).map(([file, source]) => ({ file, preimageSha256: preimages[file] || null, candidateSha256: sha(source) })),
  };
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [file, source] of Object.entries(files)) {
    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, source, { flag: 'wx', mode: 0o600 });
  }
  // Manifest last: an incomplete directory is never a reviewed candidate.
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail('MAX_SDK_ROOT_AND_NEW_OUTPUT_REQUIRED');
    const manifest = prepareCandidate(...process.argv.slice(2));
    console.log(JSON.stringify({ operation: manifest.operation, files: manifest.files.length, installed: false }));
  } catch (error) {
    // OS exceptions/paths are not part of the public diagnostic surface.
    console.error(/^MAX_[A-Z_]+$/.test(error.message) ? error.message : 'MAX_CANDIDATE_PREPARATION_FAILED');
    process.exitCode = 1;
  }
}
