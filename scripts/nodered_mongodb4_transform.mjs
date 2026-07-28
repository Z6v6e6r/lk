import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAMES_MONGO4_CLIENT_ID = '4e820638cc39c730';
const gamesMongoUri = String(process.env.NODERED_GAMES_MONGODB_URI || '').trim();

export const GAMES_MONGO4_CLIENT_NODE = {
  id: GAMES_MONGO4_CLIENT_ID,
  type: 'mongodb4-client',
  name: '',
  protocol: 'mongodb',
  hostname: '147.45.254.160',
  port: '27017',
  dbName: 'games',
  appName: '',
  authSource: 'admin',
  authMechanism: 'DEFAULT',
  tls: false,
  tlsCAFile: '',
  tlsCertificateKeyFile: '',
  tlsInsecure: false,
  connectTimeoutMS: '10000',
  socketTimeoutMS: '15000',
  minPoolSize: '0',
  maxPoolSize: '100',
  maxIdleTimeMS: '0',
  uri: gamesMongoUri,
  advanced: '{}',
  uriTabActive: 'tab-uri-advanced',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceWireTargets(wires, replacements) {
  if (!Array.isArray(wires)) return wires;
  return wires.map((output) => {
    if (!Array.isArray(output)) return output;
    return output.map((targetId) => replacements.get(targetId) ?? targetId);
  });
}

function buildMongo4AdapterNode(node) {
  const adapterId = `mongo4_adapt_${node.id}`;
  const upsert = node.upsert === true;

  return {
    id: adapterId,
    type: 'function',
    z: node.z,
    name: `${node.name || node.collection || 'Mongo update'} -> mongodb4 args`,
    func: [
      'const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};',
      'const rawUpdate = Array.isArray(msg.payload) ? (msg.payload[1] || {}) : (msg.payload || {});',
      'const update = Array.isArray(rawUpdate)',
      '  ? rawUpdate',
      '  : ((rawUpdate && typeof rawUpdate === "object") ? rawUpdate : {});',
      'const hasAtomicOperators = Array.isArray(update)',
      '  ? true',
      '  : Object.keys(update).some((key) => String(key).startsWith("$"));',
      'if (!hasAtomicOperators) {',
      '  return null;',
      '}',
      'if (!Array.isArray(update)) {',
      '  const setDoc = update.$set && typeof update.$set === "object" ? update.$set : null;',
      '  const setOnInsertDoc = update.$setOnInsert && typeof update.$setOnInsert === "object" ? update.$setOnInsert : null;',
      '  if (setDoc && setOnInsertDoc) {',
      '    for (const key of Object.keys(setOnInsertDoc)) {',
      '      if (Object.prototype.hasOwnProperty.call(setDoc, key)) {',
      '        delete setDoc[key];',
      '      }',
      '    }',
      '  }',
      '}',
      `msg.payload = [filter, update, { upsert: ${upsert ? 'true' : 'false'} }];`,
      'delete msg.query;',
      'delete msg.mongoQuery;',
      'delete msg.mongoUpdate;',
      'return msg;',
    ].join('\n'),
    outputs: 1,
    timeout: '',
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: typeof node.x === 'number' ? node.x - 220 : 0,
    y: typeof node.y === 'number' ? node.y : 0,
    wires: [[node.id]],
  };
}

function convertMongoNode(node) {
  const converted = {
    ...node,
    type: 'mongodb4',
    clientNode: GAMES_MONGO4_CLIENT_ID,
    mode: 'collection',
    output: 'toArray',
    maxTimeMS: '0',
    handleDocId: false,
  };

  delete converted.mongodb;
  delete converted.payonly;
  delete converted.upsert;
  delete converted.multi;

  if (node.type === 'mongodb in') {
    converted.operation = 'find';
  } else if (node.type === 'mongodb out' && node.operation === 'insert') {
    converted.operation = 'insertOne';
  } else if (node.type === 'mongodb out' && node.operation === 'update') {
    converted.operation = 'updateOne';
  }

  return converted;
}

export function transformFlowToMongo4(flow) {
  const sourceNodes = Array.isArray(flow) ? clone(flow) : [];
  const replacements = new Map();
  const transformed = [];
  let usesGamesMongoClient = false;

  sourceNodes.forEach((node) => {
    if (!node || typeof node !== 'object') {
      transformed.push(node);
      return;
    }

    if (node.type === 'mongodb4-client') {
      usesGamesMongoClient = true;
      return;
    }

    if (node.type === 'mongodb4') {
      usesGamesMongoClient = true;
      transformed.push({
        ...node,
        clientNode: GAMES_MONGO4_CLIENT_ID,
      });
      return;
    }

    if (node.type !== 'mongodb in' && node.type !== 'mongodb out') {
      transformed.push(node);
      return;
    }

    usesGamesMongoClient = true;
    if (node.type === 'mongodb out' && node.operation === 'update') {
      const adapter = buildMongo4AdapterNode(node);
      replacements.set(node.id, adapter.id);
      transformed.push(adapter);
      transformed.push(convertMongoNode(node));
      return;
    }

    transformed.push(convertMongoNode(node));
  });

  const adapterIds = new Set(replacements.values());
  const nodeIds = new Set(
    transformed
      .filter((node) => node && typeof node === 'object' && typeof node.id === 'string')
      .map((node) => node.id),
  );

  const rewired = transformed.map((node) => {
    if (!node || typeof node !== 'object') return node;
    if (adapterIds.has(node.id)) {
      return node;
    }

    if (typeof node.id === 'string' && node.id.startsWith('mongo4_adapt_')) {
      const targetId = node.id.slice('mongo4_adapt_'.length);
      if (!targetId || !nodeIds.has(targetId)) {
        return node;
      }

      return {
        ...node,
        wires: replaceWireTargets(node.wires, new Map([[node.id, targetId]])),
      };
    }

    return {
      ...node,
      wires: replaceWireTargets(node.wires, replacements),
    };
  });

  if (!usesGamesMongoClient) {
    return rewired;
  }
  if (!gamesMongoUri) {
    throw new Error(
      'NODERED_GAMES_MONGODB_URI is required when converting flows that use the games MongoDB client',
    );
  }

  return [...rewired, clone(GAMES_MONGO4_CLIENT_NODE)];
}

function transformFileInPlace(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  const transformed = transformFlowToMongo4(parsed);
  fs.writeFileSync(absolutePath, `${JSON.stringify(transformed, null, 2)}\n`);
  return absolutePath;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const inputFiles = process.argv.slice(2);
  if (inputFiles.length === 0) {
    console.error('Usage: node scripts/nodered_mongodb4_transform.mjs <json-file> [json-file...]');
    process.exit(1);
  }

  inputFiles.forEach((filePath) => {
    const updatedFile = transformFileInPlace(filePath);
    console.log(`Updated ${path.basename(updatedFile)}`);
  });
}
