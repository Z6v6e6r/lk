import fs from 'node:fs';
import { RESULT_AUTH_IDS as ids, RESULT_AUTH_ROUTES } from '../../lib/resultAuthTransport.mjs';

// Minimal synthetic topology with reviewed auth metadata; no live flow/data.
export function authFlow() {
  const flow = [
  {
    "id": "da59c50f0f6e6908",
    "type": "http response",
    "z": "4b91e2a2413688db",
    "name": "",
    "x": 2210,
    "y": 3840,
    "wires": []
  },
  {
    "id": "result_actor_auth_prepare_001",
    "type": "function",
    "z": "4b91e2a2413688db",
    "name": "Prepare result actor authentication",
    "outputs": 2,
    "timeout": "",
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [],
    "x": 420,
    "y": 3560,
    "wires": [
      [
        "result_actor_auth_profile_request_001"
      ],
      [
        "da59c50f0f6e6908"
      ]
    ]
  },
  {
    "id": "result_actor_auth_profile_request_001",
    "type": "http request",
    "z": "4b91e2a2413688db",
    "name": "Verify result actor via CUP JWT or Viva profile",
    "method": "use",
    "ret": "obj",
    "paytoqs": "ignore",
    "url": "",
    "tls": "",
    "persist": false,
    "proxy": "",
    "insecureHTTPParser": false,
    "authType": "",
    "senderr": true,
    "headers": [
      {
        "keyType": "other",
        "keyValue": "User-Agent",
        "valueType": "other",
        "valueValue": "PadlHub-LK/1.0"
      }
    ],
    "x": 760,
    "y": 3560,
    "wires": [
      [
        "result_actor_auth_profile_001"
      ]
    ]
  },
  {
    "id": "result_actor_auth_profile_001",
    "type": "function",
    "z": "4b91e2a2413688db",
    "name": "Resolve verified result actor",
    "outputs": 6,
    "timeout": "",
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [],
    "x": 1070,
    "y": 3560,
    "wires": [
      [
        "ce62c66d970926bd"
      ],
      [
        "d9d59722b0a76189"
      ],
      [
        "7f849685670dfbc1"
      ],
      [
        "fc3a2936243ef36d"
      ],
      [
        "acdc429f5f2e071a"
      ],
      [
        "da59c50f0f6e6908"
      ]
    ]
  }
];
  for (const [id, file] of [[ids.prepare, 'fn_result_auth_prepare.js'], [ids.resolve, 'fn_result_auth_profile.js']]) {
    const node = flow.find((n) => n.id === id);
    // Preserve property order from the reviewed Node-RED export for its digest.
    const { name, ...rest } = node;
    flow[flow.indexOf(node)] = { id: rest.id, type: rest.type, z: rest.z, name,
      func: fs.readFileSync(new URL(`../../nodered_result_nodes/${file}`, import.meta.url), 'utf8'),
      ...Object.fromEntries(Object.entries(rest).filter(([key]) => !['id', 'type', 'z'].includes(key))) };
  }
  flow.push({ id: ids.tab, type: 'tab', label: 'LK Games', disabled: false });
  RESULT_AUTH_ROUTES.forEach(([method, url], index) => flow.push({
    id: `fixture-route-${index}`, type: 'http in', z: ids.tab, method, url, wires: [[ids.prepare]],
  }));
  const targets = new Set(flow.flatMap((n) => (n.wires || []).flat()));
  for (const target of targets) {
    if (!flow.some((n) => n.id === target)) flow.push({ id: target, type: 'fixture-write', z: ids.tab, wires: [] });
  }
  return flow;
}
