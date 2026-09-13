import { isDeepStrictEqual } from 'node:util';
import { prepareMaintenancePacket } from '../build_games_maintenance_bootstrap.mjs';

// Transport is supplied by the private operator runner; credentials never enter flow JSON.
// No PM2 restart, file replacement, automatic rollback or ambiguous-request retry.
export async function installMaintenanceHold({ sourceBytes, admin }) {
  const settings = await admin('GET', '/settings');
  if (settings?.version !== '4.0.9') throw new Error('Unreviewed Node-RED version');
  const current = await admin('GET', '/flows', undefined, { 'Node-RED-API-Version': 'v2' });
  if (!Array.isArray(current?.flows) || !isDeepStrictEqual(current.flows, JSON.parse(sourceBytes))) {
    throw new Error('Live Admin graph differs from reviewed source');
  }
  const packet = prepareMaintenancePacket(sourceBytes, current.rev);
  let accepted;
  try {
    accepted = await admin('POST', '/flows', packet.request, {
      'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes',
    });
  } catch (cause) {
    throw new Error('Hot install outcome unknown: read back graph and revision; do not retry or restart', { cause });
  }
  const observed = await admin('GET', '/flows', undefined, { 'Node-RED-API-Version': 'v2' });
  if (!accepted?.rev || accepted.rev === current.rev || observed?.rev !== accepted.rev
    || !isDeepStrictEqual(observed.flows, packet.request.flows)) {
    throw new Error('Hot install readback unconfirmed: keep maintenance held; do not restart');
  }
  return { state: 'HOLD_INSTALLED_RECONCILIATION_REQUIRED', previousRevision: current.rev,
    revision: observed.rev, changedWireOnly: packet.contract.changedWireOnly,
    added: packet.contract.added, readyToRestart: false, readyToActivateOrganizer: false };
}
