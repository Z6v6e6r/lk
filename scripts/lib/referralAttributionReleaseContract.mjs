import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REFERRAL_ATTRIBUTION_AUDIT_SCHEMA = 'lk-referral-attribution-preimage-audit-v1';
export const REFERRAL_ATTRIBUTION_APPROVAL_GATE = 'REFERRAL_ATTRIBUTION_PREIMAGES_REVIEWED';

export const REFERRAL_ATTRIBUTION_TARGETS = Object.freeze([
  {
    id: '91dded2dc8cfebe4',
    tabId: 'f9575c8726e29196',
    tabLabel: 'LK Tournaments',
    name: 'Prepare tournament subscription purchase',
    sourceFile: 'fn_tournament_subscription_purchase_prepare.js',
    candidateSha256: 'cdaa2b512d6e0f1bc1fd79eb264d1d05816e63d391e6bbf9390eaf29694e0851',
    purposes: ['attribution']
  },
  {
    id: 'f8679e53edadc39b',
    tabId: 'f9575c8726e29196',
    tabLabel: 'LK Tournaments',
    name: 'Check tournament subscription limit',
    sourceFile: 'fn_tournament_subscription_purchase_limit.js',
    candidateSha256: 'd7adcfb697bf06428f7e0c3de2dafb111e88d59c480640574d6d2760e4b9b549',
    purposes: ['credential']
  },
  {
    id: '566ae4b886c37ae5',
    tabId: 'f9575c8726e29196',
    tabLabel: 'LK Tournaments',
    name: 'Route tournament subscription payment',
    sourceFile: 'fn_tournament_subscription_purchase_router.js',
    candidateSha256: '9c4f062ab1105480f97a0ca5cc869c68cf8bd1310a846e7eab63600c37b61d9c',
    purposes: ['attribution']
  },
  {
    id: 'ca022fd14027a5b0',
    tabId: 'f9575c8726e29196',
    tabLabel: 'LK Tournaments',
    name: 'Resolve tournament subscription confirm',
    sourceFile: 'fn_tournament_subscription_confirm_resolve.js',
    candidateSha256: '72d8a32ad585ea236e2d8da12e7e0b51d8b3edec5eabb1c49749cc492f212182',
    purposes: ['credential']
  },
  {
    id: 'ec1d2952b7f64f30',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'Prepare referral subscription status',
    sourceFile: 'fn_referral_subscription_status_prepare.js',
    candidateSha256: '980ed2c7f925bb11b75b9dae89df263cb88d64519b53c917bee044842de7c6aa',
    purposes: ['credential']
  },
  {
    id: '7a6981a1f4f2625f',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'Resolve referral subscription owner status',
    sourceFile: 'fn_referral_subscription_owner_resolve.js',
    candidateSha256: '858e88193807b97cf4615a9f7202ff02dad48fe65ca4a636b8569d9172245fed',
    purposes: ['credential']
  },
  {
    id: '8fe574816fd8bfd7',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'Prepare referral subscription purchase',
    sourceFile: 'fn_referral_subscription_purchase_prepare.js',
    candidateSha256: '9c30221e828275817b85806466346aea8a77fd229788d839c7ea708191409628',
    purposes: ['credential']
  },
  {
    id: 'f96b90a57be61a5c',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'Resolve referral subscription owner purchase',
    sourceFile: 'fn_referral_subscription_owner_resolve.js',
    candidateSha256: '858e88193807b97cf4615a9f7202ff02dad48fe65ca4a636b8569d9172245fed',
    purposes: ['credential']
  },
  {
    id: '538027a6dd0c8cd8',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'Resolve referral subscription confirm',
    sourceFile: 'fn_referral_subscription_confirm_resolve.js',
    candidateSha256: 'ab32cdae74c3c8c6a058f4db105f5fdbba042a8acf5c19466f48f137a02a9982',
    purposes: ['credential']
  }
]);

export const REFERRAL_ATTRIBUTION_DEBUG_GUARDS = Object.freeze([
  {
    id: '03cc3ac17f7e154a',
    tabId: 'f9575c8726e29196',
    tabLabel: 'LK Tournaments',
    name: 'tournament subscription payment debug'
  },
  {
    id: '91c892a6b8058a4d',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'referral subscription purchase debug'
  },
  {
    id: 'a8f2c9ebf73dee4f',
    tabId: 'ac5d37d8ebd616ca',
    tabLabel: 'LK Referral Subscriptions',
    name: 'referral subscription confirm debug'
  }
]);

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const passwordGrantMarker = /grant[_-]?type(?:["'`\s]*[:=,)]\s*["'`\s]*|%3d)password/i;
const urlCredentialLiteral = /[&?](?:username|password)\s*=\s*(?!\$\{)[^&"'`\s]{3,}/i;
const objectPasswordLiteral = /(?:^|[,{]\s*)["'`]?password["'`]?\s*:\s*["'`][^"'`\r\n]{3,}["'`]/im;

export function sourceObservations(source) {
  const body = String(source ?? '');
  return {
    bytes: Buffer.byteLength(body),
    hasPasswordGrant: passwordGrantMarker.test(body),
    hasInlineCredentialLiteral: urlCredentialLiteral.test(body) || objectPasswordLiteral.test(body),
    hasProtectedEnvReference: body.includes('VIVACRM_TOKEN_REQUEST_BODY'),
    hasProtectedGlobalReference: body.includes('vivacrm_token_request_body'),
    hasReferralToken: body.includes('referralToken'),
    hasReferralVisitId: body.includes('referralVisitId')
  };
}

function activeExecutionContainers(flow, tabs) {
  const active = new Set(
    [...tabs.values()]
      .filter((node) => node.disabled !== true)
      .map((node) => node.id)
  );
  const subflows = new Set(flow.filter((node) => node?.type === 'subflow').map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of flow) {
      if (!active.has(node?.z) || node?.d === true || typeof node?.type !== 'string') continue;
      if (!node.type.startsWith('subflow:')) continue;
      const subflowId = node.type.slice('subflow:'.length);
      if (!subflows.has(subflowId) || active.has(subflowId)) continue;
      active.add(subflowId);
      changed = true;
    }
  }
  return active;
}

export function inspectReferralAttributionSource(flow, functionDirectory) {
  const tabs = new Map(flow.filter((node) => node?.type === 'tab').map((node) => [node.id, node]));
  const subflows = new Map(flow.filter((node) => node?.type === 'subflow').map((node) => [node.id, node]));
  const activeContainerIds = activeExecutionContainers(flow, tabs);
  const targetIds = new Set(REFERRAL_ATTRIBUTION_TARGETS.map((target) => target.id));
  const targetNames = new Set(REFERRAL_ATTRIBUTION_TARGETS.map((target) => target.name));
  const unexpected = flow.filter((node) => (
    node?.type === 'function'
    && activeContainerIds.has(node.z)
    && node.d !== true
    && targetNames.has(node.name)
    && !targetIds.has(node.id)
  ));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected enabled referral attribution target ids: ${unexpected.map((node) => node.id).join(',')}`);
  }

  const targets = REFERRAL_ATTRIBUTION_TARGETS.map((target) => {
    const matches = flow.filter((node) => node?.id === target.id);
    const tab = tabs.get(target.tabId);
    if (matches.length !== 1
      || matches[0].type !== 'function'
      || matches[0].z !== target.tabId
      || matches[0].name !== target.name
      || matches[0].d === true
      || tab?.label !== target.tabLabel
      || tab?.disabled === true) {
      throw new Error(`Referral attribution target identity mismatch: ${target.id}`);
    }
    const candidateSource = fs.readFileSync(path.join(functionDirectory, target.sourceFile), 'utf8');
    if (sha256(candidateSource) !== target.candidateSha256) {
      throw new Error(`Tracked referral attribution source mismatch: ${target.sourceFile}`);
    }
    const candidateObservations = sourceObservations(candidateSource);
    if (target.purposes.includes('credential')
      && (!candidateObservations.hasProtectedEnvReference
        || !candidateObservations.hasProtectedGlobalReference
        || !candidateObservations.hasPasswordGrant
        || candidateObservations.hasInlineCredentialLiteral)) {
      throw new Error(`Credential candidate contract mismatch: ${target.sourceFile}`);
    }
    if (target.purposes.includes('attribution')
      && (!candidateObservations.hasReferralToken || !candidateObservations.hasReferralVisitId)) {
      throw new Error(`Attribution candidate contract mismatch: ${target.sourceFile}`);
    }
    const currentSource = String(matches[0].func ?? '');
    return {
      ...target,
      node: matches[0],
      candidateSource,
      preimageSha256: sha256(currentSource),
      preimageObservations: sourceObservations(currentSource),
      candidateObservations
    };
  });

  const debugGuards = REFERRAL_ATTRIBUTION_DEBUG_GUARDS.map((guard) => {
    const matches = flow.filter((node) => node?.id === guard.id);
    const tab = tabs.get(guard.tabId);
    if (matches.length !== 1
      || matches[0].type !== 'debug'
      || matches[0].z !== guard.tabId
      || matches[0].name !== guard.name
      || tab?.label !== guard.tabLabel
      || tab?.disabled === true
      || matches[0].active !== false) {
      throw new Error(`Referral attribution debug guard mismatch: ${guard.id}`);
    }
    return { ...guard, active: false };
  });

  const activePasswordGrantConsumers = flow.flatMap((node) => {
    if (node?.type !== 'function' || !activeContainerIds.has(node.z) || node.d === true) return [];
    const observations = sourceObservations(node.func);
    if (!observations.hasPasswordGrant) return [];
    return [{
      id: node.id,
      name: String(node.name ?? ''),
      tabId: node.z,
      tabLabel: String(tabs.get(node.z)?.label ?? subflows.get(node.z)?.name ?? ''),
      managedByCandidate: targetIds.has(node.id),
      hasInlineCredentialLiteral: observations.hasInlineCredentialLiteral,
      hasProtectedCredentialReference: observations.hasProtectedEnvReference
        || observations.hasProtectedGlobalReference
    }];
  });
  return {
    targets,
    debugGuards,
    activePasswordGrantConsumers,
    unmanagedActivePasswordGrantConsumers: activePasswordGrantConsumers.filter((item) => !item.managedByCandidate)
  };
}
