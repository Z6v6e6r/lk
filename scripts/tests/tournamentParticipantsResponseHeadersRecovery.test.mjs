import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  PARTICIPANTS_HEADERS_CONTRACT,
  TERMINAL_SOURCE_PATH,
  synchronizeParticipantsHeaders,
} from '../patch_live_tournament_participants_response_headers.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));

function source() {
  return fs.readFileSync(TERMINAL_SOURCE_PATH, 'utf8');
}

function graphSignature(flow, startId) {
  const nodes = new Map(flow.map((node) => [node.id, node]));
  const seen = new Set();
  const pending = [startId];
  while (pending.length > 0) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    for (const output of node.wires ?? []) {
      for (const target of output ?? []) pending.push(target);
    }
  }
  return [...seen].sort().map((id) => {
    const node = nodes.get(id);
    return {
      id: node.id,
      type: node.type,
      z: node.z || '',
      name: node.name || '',
      url: node.url || '',
      method: node.method || '',
      outputs: node.outputs ?? null,
      wires: node.wires ?? null,
    };
  });
}

function fixture() {
  const candidateSource = source();
  const preimageSource = 'msg.payload = [];\nreturn msg;\n';
  const tab = {
    id: 'tab-1',
    type: 'tab',
    label: 'LK Tournaments',
    disabled: false,
  };
  const route = {
    id: 'route-1',
    type: 'http in',
    z: tab.id,
    name: 'LK tournaments participants',
    method: 'get',
    url: '/lk/tournaments/participants',
    wires: [['terminal-1']],
  };
  const terminal = {
    id: 'terminal-1',
    type: 'function',
    z: tab.id,
    name: 'Participants cache terminal v2',
    func: preimageSource,
    outputs: 1,
    wires: [['response-1']],
  };
  const response = {
    id: 'response-1',
    type: 'http response',
    z: tab.id,
    wires: [],
  };
  const flow = [tab, route, terminal, response];
  const contract = {
    wholeFlowSha256: sha256Json(flow),
    nodeCount: flow.length,
    httpRouteCount: 1,
    tab: {
      id: tab.id,
      label: tab.label,
      nodeSha256: sha256Json(tab),
    },
    route: {
      id: route.id,
      name: route.name,
      method: route.method,
      url: route.url,
      nodeSha256: sha256Json(route),
    },
    target: {
      id: terminal.id,
      name: terminal.name,
      outputs: terminal.outputs,
      wires: terminal.wires,
      preimageSha256: sha256(preimageSource),
      sourceSha256: sha256(candidateSource),
      nodeSha256: sha256Json(terminal),
    },
    response: {
      id: response.id,
      nodeSha256: sha256Json(response),
    },
    reachableNodeCount: 3,
    reachableGraphSha256: sha256Json(graphSignature(flow, route.id)),
  };
  return { flow, contract, candidateSource };
}

test('tracked terminal source is pinned after the exact verified live preimage', () => {
  assert.equal(
    sha256(source()),
    PARTICIPANTS_HEADERS_CONTRACT.target.sourceSha256,
  );
  assert.equal(
    PARTICIPANTS_HEADERS_CONTRACT.target.preimageSha256,
    '2772af0a50c4ff0475179020417222d27e7aa296bf48ec2d0cc4e52139019429',
  );
  assert.equal(
    PARTICIPANTS_HEADERS_CONTRACT.wholeFlowSha256,
    'cb109f305bf48ff5f6026b5ff0ef944a3cfd49e81da247c757a90f1a880f43a2',
  );
});

test('guarded synchronizer changes only the terminal function body', () => {
  const { flow, contract, candidateSource } = fixture();
  const before = structuredClone(flow);
  const result = synchronizeParticipantsHeaders(
    structuredClone(flow),
    candidateSource,
    contract.wholeFlowSha256,
    contract,
  );

  assert.deepEqual(result.changedNodes, [{
    id: contract.target.id,
    changedFields: ['func'],
  }]);
  assert.equal(result.reachableNodeCount, 3);
  assert.equal(result.candidate[2].func, candidateSource);
  assert.deepEqual(result.candidate[0], before[0]);
  assert.deepEqual(result.candidate[1], before[1]);
  assert.deepEqual(result.candidate[3], before[3]);
  assert.deepEqual(
    result.candidate.map((node) => ({ id: node.id, wires: node.wires ?? null })),
    before.map((node) => ({ id: node.id, wires: node.wires ?? null })),
  );
});

test('guarded synchronizer fails closed on source and route drift', () => {
  const { flow, contract, candidateSource } = fixture();
  assert.throws(
    () => synchronizeParticipantsHeaders(
      structuredClone(flow),
      candidateSource,
      'unexpected-flow-sha',
      contract,
    ),
    /Flow preimage SHA mismatch/,
  );
  assert.throws(
    () => synchronizeParticipantsHeaders(
      structuredClone(flow),
      `${candidateSource}\n`,
      contract.wholeFlowSha256,
      contract,
    ),
    /Tracked participants terminal source mismatch/,
  );

  const routeDrift = structuredClone(flow);
  routeDrift[1].wires = [['response-1']];
  assert.throws(
    () => synchronizeParticipantsHeaders(
      routeDrift,
      candidateSource,
      contract.wholeFlowSha256,
      contract,
    ),
    /Participants route contract mismatch/,
  );
});

test('guarded synchronizer fails closed on terminal and response drift', () => {
  const { flow, contract, candidateSource } = fixture();
  const terminalDrift = structuredClone(flow);
  terminalDrift[2].func = 'return null;';
  assert.throws(
    () => synchronizeParticipantsHeaders(
      terminalDrift,
      candidateSource,
      contract.wholeFlowSha256,
      contract,
    ),
    /Participants terminal preimage mismatch/,
  );

  const responseDrift = structuredClone(flow);
  responseDrift[3].name = 'changed';
  assert.throws(
    () => synchronizeParticipantsHeaders(
      responseDrift,
      candidateSource,
      contract.wholeFlowSha256,
      contract,
    ),
    /Participants HTTP response contract mismatch/,
  );
});
