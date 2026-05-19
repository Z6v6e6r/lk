#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const hasFlag = (name) => argv.includes(name);

const tournamentId = getArg('--tournament-id');
const inputFile = getArg('--input-file');
const mongoUri = getArg('--mongo-uri', process.env.MONGO_URI || process.env.MONGODB_URI);
const dbName = getArg('--db', process.env.MONGO_DB || 'games');
const collectionName = getArg('--collection', process.env.MONGO_COLLECTION || 'tournaments');
const dryRun = hasFlag('--dry-run');
const outFile = getArg('--out', `tmp/${tournamentId || 'tournament'}-fixed.json`);
const recalcFile = getArg('--recalc-file', 'scripts/nodered_games_nodes/fn_tournament_recalculate.js');
const noDb = hasFlag('--no-db');

if (!inputFile && !tournamentId) {
  console.error('Missing --tournament-id (or use --input-file)');
  process.exit(1);
}

const q = (value) => JSON.stringify(value);

const runMongoshEval = (code) => {
  const output = execFileSync('mongosh', [mongoUri, '--quiet', '--eval', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return output.trim();
};

const fetchTournament = () => {
  if (!mongoUri) {
    throw new Error('Missing --mongo-uri (or MONGO_URI / MONGODB_URI env)');
  }
  const code = [
    `const dbx = db.getSiblingDB(${q(dbName)});`,
    `const doc = dbx.getCollection(${q(collectionName)}).findOne({ tournamentId: ${q(tournamentId)} });`,
    'print(EJSON.stringify(doc));',
  ].join('\n');

  const raw = runMongoshEval(code);
  if (!raw || raw === 'null') {
    throw new Error(`Tournament not found: ${tournamentId}`);
  }
  return JSON.parse(raw);
};

const normalizeId = (value, fallback) => {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  if (value && typeof value === 'object') {
    const normalized = String(value.id ?? value.phone ?? fallback ?? '').trim();
    return normalized || fallback;
  }
  return fallback;
};

const normalizeIdArray = (list, prefix) => (
  Array.isArray(list)
    ? list
      .map((item, index) => normalizeId(item, `${prefix}-${index + 1}`))
      .filter(Boolean)
    : []
);

const playerIdsFromParticipants = (participants) => (
  Array.isArray(participants)
    ? participants
      .map((participant, index) => normalizeId(participant, `p-${index + 1}`))
      .filter(Boolean)
    : []
);

const matchContainsPlayer = (match, playerId) => {
  const pair1 = normalizeIdArray(match?.pair1, 'pair1');
  const pair2 = normalizeIdArray(match?.pair2, 'pair2');
  return pair1.includes(playerId) || pair2.includes(playerId);
};

const replacePlayerInMatch = (match, fromPlayerId, toPlayerId) => {
  const replaceOnce = (list) => {
    const ids = normalizeIdArray(list, 'pair');
    const idx = ids.indexOf(fromPlayerId);
    if (idx === -1) return { ids, replaced: false };
    ids[idx] = toPlayerId;
    return { ids, replaced: true };
  };

  const left = replaceOnce(match.pair1);
  if (left.replaced) {
    match.pair1 = left.ids;
    return true;
  }

  const right = replaceOnce(match.pair2);
  if (right.replaced) {
    match.pair2 = right.ids;
    return true;
  }

  return false;
};

const pickCandidateMatch = (round, duplicateId, missingId) => {
  const matches = Array.isArray(round?.matches) ? round.matches : [];
  const duplicateMatches = matches.filter((match) => matchContainsPlayer(match, duplicateId));
  if (duplicateMatches.length === 0) return null;
  if (duplicateMatches.length === 1) return duplicateMatches[0];

  const byExplanation = duplicateMatches.find((match) => {
    const explanation = String(match?.quality?.explanation || '');
    return explanation.includes(missingId) && !explanation.includes(duplicateId);
  });
  if (byExplanation) return byExplanation;

  const byRoundBye = duplicateMatches.find((match) => {
    const byes = normalizeIdArray(round?.byes, 'bye');
    const missingInBye = byes.includes(missingId);
    return missingInBye && !matchContainsPlayer(match, missingId);
  });
  if (byRoundBye) return byRoundBye;

  return duplicateMatches[0];
};

const fixDuplicatePlayersPerRound = (tournament) => {
  const participantIds = playerIdsFromParticipants(tournament.participants || []);
  const fixes = [];

  (Array.isArray(tournament.rounds) ? tournament.rounds : []).forEach((round) => {
    const matches = Array.isArray(round?.matches) ? round.matches : [];
    const counts = new Map();
    matches.forEach((match, matchIndex) => {
      const pair1 = normalizeIdArray(match?.pair1, `${round?.id || 'round'}-pair1-${matchIndex + 1}`);
      const pair2 = normalizeIdArray(match?.pair2, `${round?.id || 'round'}-pair2-${matchIndex + 1}`);
      match.pair1 = pair1;
      match.pair2 = pair2;
      [...pair1, ...pair2].forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    });

    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    if (duplicates.length === 0) return;

    const activeSet = new Set([...counts.keys()]);
    const missing = participantIds.filter((id) => !activeSet.has(id));

    if (duplicates.length !== 1 || missing.length !== 1) {
      throw new Error(`Round ${round?.id || '?'} has unsupported duplicate layout: duplicates=${duplicates.join(',')} missing=${missing.join(',')}`);
    }

    const duplicateId = duplicates[0];
    const missingId = missing[0];
    const candidateMatch = pickCandidateMatch(round, duplicateId, missingId);
    if (!candidateMatch) {
      throw new Error(`Round ${round?.id || '?'}: cannot find candidate match for replacement ${duplicateId} -> ${missingId}`);
    }

    const replaced = replacePlayerInMatch(candidateMatch, duplicateId, missingId);
    if (!replaced) {
      throw new Error(`Round ${round?.id || '?'}: replacement failed for match ${candidateMatch?.id || '?'}`);
    }

    if (Array.isArray(round.byes)) {
      round.byes = round.byes.filter((id) => normalizeId(id) !== missingId);
    }

    fixes.push({
      roundId: round.id,
      matchId: candidateMatch.id,
      duplicateId,
      missingId,
    });
  });

  return fixes;
};

const runRecalculate = (tournament) => {
  const resolvedRecalcFile = path.resolve(recalcFile);
  const source = fs.readFileSync(resolvedRecalcFile, 'utf8');
  const fn = new Function('msg', source);
  const msg = {
    payload: tournament,
    req: {
      body: {
        results: [],
      },
    },
  };
  const out = fn(msg);
  if (!out || !out.mongoUpdate || !out.mongoUpdate.$set) {
    throw new Error('Recalculate function returned invalid payload');
  }
  return out;
};

const updateTournament = (documentIdValue, mongoSet) => {
  const code = [
    `const dbx = db.getSiblingDB(${q(dbName)});`,
    `const filter = { _id: ObjectId(${q(documentIdValue)}) };`,
    `const update = { $set: ${JSON.stringify(mongoSet)} };`,
    `const result = dbx.getCollection(${q(collectionName)}).updateOne(filter, update);`,
    'print(EJSON.stringify(result));',
  ].join('\n');

  return runMongoshEval(code);
};

const main = () => {
  const fromFile = Boolean(inputFile);
  const tournament = fromFile
    ? JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'))
    : fetchTournament();
  const documentIdValue = tournament?._id?.$oid;

  const resolvedTournamentId = tournamentId || tournament?.tournamentId || 'tournament';
  if (!resolvedTournamentId) {
    throw new Error('Cannot resolve tournamentId');
  }

  const beforePath = path.resolve(`tmp/${resolvedTournamentId}-before-fix.json`);
  fs.mkdirSync(path.dirname(beforePath), { recursive: true });
  fs.writeFileSync(beforePath, JSON.stringify(tournament, null, 2), 'utf8');

  const fixes = fixDuplicatePlayersPerRound(tournament);
  if (fixes.length === 0) {
    console.log('No duplicate players in any round. Nothing to fix.');
    return;
  }

  const recalcResult = runRecalculate(tournament);
  const mongoSet = recalcResult.mongoUpdate.$set;

  const fixedTournament = {
    ...tournament,
    ...mongoSet,
  };

  const outPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fixedTournament, null, 2), 'utf8');

  const shouldWriteDb = !fromFile && !noDb && !dryRun;
  if (shouldWriteDb) {
    if (!documentIdValue) {
      throw new Error('Tournament _id.$oid is missing');
    }
    const updateResult = updateTournament(documentIdValue, mongoSet);
    console.log('Mongo update result:', updateResult);
  }

  console.log('Fixes applied:');
  fixes.forEach((item) => {
    console.log(`- ${item.roundId} / ${item.matchId}: ${item.duplicateId} -> ${item.missingId}`);
  });
  console.log(`Before backup: ${beforePath}`);
  console.log(`Fixed document: ${outPath}`);
  console.log(shouldWriteDb ? 'DB updated.' : 'DB not updated.');
};

try {
  main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
