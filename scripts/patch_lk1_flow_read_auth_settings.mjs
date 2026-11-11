import crypto from 'node:crypto';
import vm from 'node:vm';

export const AUTH_SETTINGS_MARKER = '// PADLHUB_LK1_FLOW_READ_AUTH_V1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Preparation only: preserves every byte of the owning settings preimage.
// Deploy through a reviewed settings/PM2 backup + guarded restart operation.
export function buildFlowReadAuthSettings({ source, expectedSha256, modulePath }) {
  if (!Buffer.isBuffer(source) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')
    || sha(source) !== expectedSha256) throw new Error('SETTINGS_PREIMAGE_DRIFT');
  if (!/^\/opt\/padlhub-lk1-unpaid-cancel\/releases\/[a-f0-9]{40}\/lib\/lk1FlowReadTokenAuth\.cjs$/.test(modulePath || '')) {
    throw new Error('AUTH_MODULE_PATH_INVALID');
  }
  const text = source.toString('utf8');
  if (!Buffer.from(text).equals(source) || text.includes(AUTH_SETTINGS_MARKER)) throw new Error('SETTINGS_SOURCE_INVALID');
  const suffix = `\n${AUTH_SETTINGS_MARKER}\n{\n  const auth = module.exports.adminAuth;\n  if (!auth || auth.type !== "credentials" || auth.module !== undefined\n    || auth.tokens !== undefined || (auth.tokenHeader && auth.tokenHeader.toLowerCase() !== "authorization")) {\n    throw new Error("LK1_FLOW_READ_AUTH_CONFIG_CONFLICT");\n  }\n  module.exports.adminAuth = { ...auth,\n    tokens: require(${JSON.stringify(modulePath)}).createFlowReadTokenAuth()\n  };\n}\n`;
  const candidate = Buffer.concat([source, Buffer.from(suffix)]);
  new vm.Script(candidate.toString('utf8'), { filename: 'settings.js' });
  return { candidate, sourceSha256: expectedSha256, candidateSha256: sha(candidate), modulePath };
}
