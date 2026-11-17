#!/usr/bin/env node
// Called only by the persistent four-lock Python holder. One command per process;
// inherited descriptors retain custody even if the holder is killed mid-command.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupportAdapterCustody, supportAdapterCustodyCodeHash } from './support_photos_adapter_custody.mjs';
import { createAdapterHostBindings, readAdapterFile, adapterSha, validateAdapterGraphPins } from './support_photos_adapter_host.mjs';
import { support_photosOperationCodeHash } from './support_photos_native_operation.mjs';

const need = (value, code) => { if (!value) throw Error(code); };
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function supportAdapterOperatorHash() {
  return adapterSha(Buffer.concat(['support_photos_adapter_operator.mjs', 'support_photos_adapter_host.mjs',
    'support_photos_adapter_holder.py', 'support_photos_adapter_custody.mjs', 'support_photos_adapter_upload_guard.mjs',
    'support_photos_native_operation.mjs', 'support_photos_body_preserver.mjs', 'runtime_contract.mjs']
    .map(name => fs.readFileSync(new URL(name, import.meta.url))).concat(Buffer.from(support_photosOperationCodeHash()))));
}
export async function runAdapterCommand({ stage, configSha256, locks, request }) {
  const configRaw = readAdapterFile(path.join(stage, 'host-config.json'), 1048576, true);
  need(adapterSha(configRaw) === configSha256, 'ADAPTER_OPERATOR_CONFIG_DRIFT');
  const config = JSON.parse(configRaw);
  need(config.stage === stage && config.prepare.operatorSha256 === supportAdapterOperatorHash()
    && config.prepare.expectedCodeSha256 === supportAdapterCustodyCodeHash(), 'ADAPTER_OPERATOR_CODE_DRIFT');
  need(request && ['prepare', 'reserve', 'publishPolicy', 'begin', 'confirm', 'cancel', 'removePolicy', 'handback', 'inspect'].includes(request.command)
    && Object.keys(request).sort().join(',') === 'command,input,native', 'ADAPTER_OPERATOR_COMMAND');
  const input = request.input;
  const expectedKeys = request.command === 'inspect' || request.command === 'prepare' ? []
    : request.command === 'confirm' || (request.command === 'cancel' && Object.hasOwn(input || {}, 'audit'))
      ? ['audit', 'expectedPlanSha256'] : ['expectedPlanSha256'];
  need(input && Object.keys(input).sort().join(',') === expectedKeys.sort().join(','), 'ADAPTER_OPERATOR_INPUT');
  const installed = () => request.command === 'confirm'
    || fs.existsSync(path.join(stage, 'terminal.json'));
  const bindings = createAdapterHostBindings({ config, locks, native: () => request.native, installed });
  bindings.assertExclusive();
  await validateAdapterGraphPins(readAdapterFile('/root/.node-red/flows.json'), config.nativePins);
  need(bindings.readTarget() === config.targetSha256, 'ADAPTER_OPERATOR_TARGET_DRIFT');
  const controller = createSupportAdapterCustody({ root: '/root/.node-red', stage, backupStage: config.backupStage, ...bindings });
  if (request.command === 'inspect') return { status: 'INSPECTED', targetSha256: bindings.readTarget(), codeSha256: supportAdapterCustodyCodeHash(), operatorSha256: supportAdapterOperatorHash() };
  if (request.command === 'prepare') return controller.prepare(config.prepare);
  if (request.command === 'confirm') {
    const audit = input.audit;
    need(audit?.forwarded === 1 && audit?.terminal === true && audit?.httpStatus === 200 && audit?.rejected === 0
      && audit?.cancelledBeforeForward === false, 'ADAPTER_OPERATOR_NATIVE_TERMINAL');
    bindings.syncPostimage();
  }
  return controller[request.command](input);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    need(process.argv.length === 8 && process.getuid() === 0, 'ADAPTER_OPERATOR_ARGUMENTS');
    const [stage, configSha256, requestFile, parentPid, parentStartTicks, fdList] = process.argv.slice(2);
    need(path.dirname(requestFile) === path.join(stage, 'requests') && /^[0-9]{8}(?:\.close)?\.json$/.test(path.basename(requestFile)), 'ADAPTER_OPERATOR_REQUEST_PATH');
    const request = JSON.parse(readAdapterFile(requestFile, 65536, true));
    const result = await runAdapterCommand({ stage, configSha256, request,
      locks: { parentPid: Number(parentPid), parentStartTicks, fds: fdList.split(',').map(Number) } });
    process.stdout.write(encode({ ok: true, result }));
  } catch (error) {
    const code = typeof error.message === 'string' && /^ADAPTER_[A-Z0-9_]+$/.test(error.message) ? error.message : 'ADAPTER_OPERATOR_REFUSED';
    process.stdout.write(encode({ ok: false, code, automaticRetry: false, releaseCustody: false })); process.exitCode = 1;
  }
}
