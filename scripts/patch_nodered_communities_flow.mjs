import fs from 'node:fs';
import path from 'node:path';
import { transformFlowToMongo4 } from './nodered_mongodb4_transform.mjs';

const workspaceRoot = process.cwd();
const nodeRedRoot = path.resolve(workspaceRoot, 'node-red');
const srcPath = path.resolve(nodeRedRoot, 'ЛК03_03_26.with_games_chat_results.json');
const outPath = path.resolve(nodeRedRoot, 'ЛК03_03_26.with_games_chat_results_communities.json');
const importPath = path.resolve(nodeRedRoot, 'lk_communities_nodes_import.json');
const tabId = '1e95dcebc274ac6c';

const commonHelpers = String.raw`
const isObj = (value) => value && typeof value === 'object' && !Array.isArray(value);
const toArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const toNum = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const toTs = (value) => {
  const parsed = toNum(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};
const parseIsoTs = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};
const resolveCreatedTs = (row) => {
  const direct = toTs(row?.createdTs)
    ?? toTs(row?.timestamp)
    ?? parseIsoTs(row?.publishedAt)
    ?? parseIsoTs(row?.createdAt);
  return Number.isFinite(direct) ? direct : 0;
};
const normPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '7' + digits;
  if (digits.length === 11 && digits.startsWith('8')) return '7' + digits.slice(1);
  return digits;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const withJson = (source, statusCode, payload) => Object.assign({}, source, { statusCode, headers: jsonHeaders, payload });
const toRole = (value, fallback = 'MEMBER') => {
  const normalized = toStr(value)?.toUpperCase();
  return normalized === 'OWNER' || normalized === 'ADMIN' || normalized === 'MODERATOR' || normalized === 'MEMBER'
    ? normalized
    : fallback;
};
const toVisibility = (value) => toStr(value)?.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
const toJoinRule = (value, visibility = 'OPEN') => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized === 'INSTANT' || normalized === 'MODERATED' || normalized === 'INVITE_ONLY') {
    return normalized;
  }
  return visibility === 'CLOSED' ? 'INVITE_ONLY' : 'INSTANT';
};
const toMembershipStatus = (value) => toStr(value)?.toUpperCase() === 'PENDING' ? 'PENDING' : 'ACTIVE';
const toBool = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  const normalized = toStr(value)?.toLowerCase();
  if (!normalized) return null;
  if (['true', '1', 'yes', 'verified', 'official', 'approved'].includes(normalized)) return true;
  if (['false', '0', 'no', 'unverified', 'rejected'].includes(normalized)) return false;
  return null;
};
const resolveCommunityVerified = (community) => {
  const direct = toBool(community?.isVerified ?? community?.verified ?? community?.isOfficial ?? community?.official);
  if (direct !== null) return direct;
  const verification = isObj(community?.verification)
    ? community.verification
    : (isObj(community?.verificationInfo) ? community.verificationInfo : null);
  const nested = verification
    ? toBool(verification.isVerified ?? verification.verified ?? verification.isOfficial ?? verification.official)
    : null;
  if (nested !== null) return nested;
  const status = toStr(community?.verificationStatus || community?.statusVerification || verification?.status)?.toUpperCase();
  if (status === 'VERIFIED' || status === 'OFFICIAL' || status === 'APPROVED') return true;
  if (status === 'UNVERIFIED' || status === 'REJECTED') return false;
  return Boolean(toStr(community?.verifiedAt || verification?.verifiedAt));
};
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const buildSlug = (value) => (toStr(value) || 'community')
  .toLowerCase()
  .replace(/[^a-z0-9а-я]+/gi, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64) || 'community';
const buildInviteCode = (value) => buildSlug(value) + '-' + Math.random().toString(36).slice(2, 8);
const buildInviteLink = (inviteCode) => 'https://padlhub.ru/community_join?invite=' + encodeURIComponent(inviteCode);
const isDataUrl = (value) => /^data:/i.test(String(value || '').trim());
const buildPublicBaseUrl = (req) => {
  const forwardedProto = toStr(req?.headers?.['x-forwarded-proto'])?.split(',')[0]?.trim();
  const forwardedHost = toStr(req?.headers?.['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || toStr(req?.headers?.host);
  const protocol = forwardedProto || toStr(req?.protocol) || 'https';
  if (!host) return '';
  return protocol + '://' + host.replace(/\/+$/, '');
};
const toPublicUrl = (value, publicBaseUrl) => {
  const normalized = toStr(value);
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized) || isDataUrl(normalized)) return normalized;
  if (!publicBaseUrl) return normalized;
  return publicBaseUrl + (normalized.startsWith('/') ? normalized : '/' + normalized);
};
const buildCommunityLogoAssetUrl = (publicBaseUrl, assetId, variant = 'original') => {
  const safeAssetId = toStr(assetId);
  if (!safeAssetId) return null;
  if (variant === 'thumb') {
    return '/lk/media/community-logo/' + encodeURIComponent(safeAssetId) + '/thumb';
  }
  return '/lk/media/community-logo/' + encodeURIComponent(safeAssetId);
};
const buildCommunityLegacyLogoUrl = (publicBaseUrl, communityId, variant = 'original') => {
  const safeCommunityId = toStr(communityId);
  if (!safeCommunityId) return null;
  if (variant === 'thumb') {
    return '/lk/media/community-logo-legacy/' + encodeURIComponent(safeCommunityId) + '/thumb';
  }
  return '/lk/media/community-logo-legacy/' + encodeURIComponent(safeCommunityId);
};
const buildBinaryHeaders = (mimeType, contentLength) => {
  const headers = {
    'Content-Type': toStr(mimeType) || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  const safeContentLength = toNum(contentLength);
  if (Number.isFinite(safeContentLength) && safeContentLength > 0) {
    headers['Content-Length'] = String(Math.trunc(safeContentLength));
  }
  return headers;
};
const resolveRequestedLogoVariant = (req) => {
  const explicitVariant = toStr(req?.params?.variant)?.toLowerCase();
  if (explicitVariant === 'thumb') return 'thumb';
  const rawUrl = String(req?.originalUrl || req?.url || '');
  return /\/thumb(?:\?|$)/i.test(rawUrl) ? 'thumb' : 'original';
};
const parseDataUrl = (value) => {
  const normalized = toStr(value);
  if (!normalized || !isDataUrl(normalized)) return null;
  const match = normalized.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const mimeType = toStr(match[1]) || 'application/octet-stream';
  const encodedBody = match[3] || '';
  if (!/;base64/i.test(match[2] || '')) {
    try {
      const plainBody = decodeURIComponent(encodedBody);
      return {
        mimeType,
        encoding: 'utf8',
        body: plainBody,
      };
    } catch {
      return null;
    }
  }
  return {
    mimeType,
    encoding: 'base64',
    body: encodedBody.trim(),
  };
};
const getDataUrlByteSize = (value) => {
  const parsed = parseDataUrl(value);
  if (!parsed) return 0;
  if (parsed.encoding !== 'base64') {
    return Buffer.byteLength(parsed.body, 'utf8');
  }
  const base64Body = parsed.body;
  const padding = base64Body.endsWith('==') ? 2 : base64Body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64Body.length * 3) / 4) - padding);
};
const resolveIncomingCommunityLogoFields = (body, fallback = {}) => {
  const hasLogo = Object.prototype.hasOwnProperty.call(body || {}, 'logo');
  const hasLogoUrl = Object.prototype.hasOwnProperty.call(body || {}, 'logoUrl');
  const hasLogoThumbUrl = Object.prototype.hasOwnProperty.call(body || {}, 'logoThumbUrl');
  const incomingLogo = hasLogo ? toStr(body.logo) : null;
  const incomingLogoUrl = hasLogoUrl ? toStr(body.logoUrl) : null;
  const incomingLogoThumbUrl = hasLogoThumbUrl ? toStr(body.logoThumbUrl) : null;
  const directLogoUrl = incomingLogo && !isDataUrl(incomingLogo) ? incomingLogo : null;
  const fallbackLegacyLogoDataUrl = toStr(fallback.logoLegacyDataUrl || (isDataUrl(fallback.logo) ? fallback.logo : null));
  const explicitUrlProvided = hasLogo || hasLogoUrl || hasLogoThumbUrl;
  const nextLogoUrl = explicitUrlProvided
    ? (incomingLogoUrl || directLogoUrl)
    : toStr(fallback.logoUrl || fallback.imageUrl || (isDataUrl(fallback.logo) ? null : fallback.logo));
  const nextLogoThumbUrl = explicitUrlProvided
    ? (incomingLogoThumbUrl || incomingLogoUrl || directLogoUrl)
    : toStr(
      fallback.logoThumbUrl
      || fallback.logoThumb
      || fallback.thumbnailUrl
      || fallback.logoUrl
      || fallback.imageUrl
      || (isDataUrl(fallback.logo) ? null : fallback.logo),
    );

  return {
    logo: nextLogoThumbUrl || nextLogoUrl || null,
    logoUrl: nextLogoUrl || null,
    logoThumbUrl: nextLogoThumbUrl || nextLogoUrl || null,
    logoLegacyDataUrl: incomingLogo && isDataUrl(incomingLogo)
      ? incomingLogo
      : ((hasLogo || hasLogoUrl || hasLogoThumbUrl) ? null : fallbackLegacyLogoDataUrl),
  };
};
const extractTags = (value) => {
  if (Array.isArray(value)) {
    return uniq(value.map((item) => toStr(item))).slice(0, 8);
  }
  if (typeof value === 'string') {
    return uniq(value.split(',').map((item) => item.trim()).filter(Boolean)).slice(0, 8);
  }
  return [];
};
const buildLevelLabel = (score) => {
  const normalized = Number.isFinite(score) ? score : 3.2;
  if (normalized >= 5.75) return 'A';
  if (normalized >= 5.25) return 'B+';
  if (normalized >= 4.75) return 'B';
  if (normalized >= 4.25) return 'C+';
  if (normalized >= 3.75) return 'C';
  if (normalized >= 3.25) return 'D+';
  return 'D';
};
const buildMember = (value, fallbackRole = 'MEMBER') => {
  const member = isObj(value) ? value : {};
  const levelScore = toNum(member.levelScore ?? member.ratingNumeric ?? member.levelNumeric) ?? 3.2;
  return {
    id: toStr(member.id || member.clientId || member.userId || member.uuid),
    phone: normPhone(member.phone || member.phoneNorm || member.phoneNumber || member.mobile),
    name: toStr(member.name || member.displayName || [member.firstName, member.lastName].filter(Boolean).join(' ')) || 'Игрок',
    avatar: toStr(member.avatar || member.photo || member.imageUrl),
    role: toRole(member.role, fallbackRole),
    status: toMembershipStatus(member.status),
    levelScore,
    levelLabel: toStr(member.levelLabel || member.rating || member.level) || buildLevelLabel(levelScore),
    joinedAt: toStr(member.joinedAt || member.createdAt) || nowIso,
  };
};
const sameMemberIdentity = (left, right) => {
  const a = buildMember(left);
  const b = buildMember(right);
  return Boolean(
    (a.id && b.id && a.id === b.id)
    || (a.phone && b.phone && a.phone === b.phone)
    || (!a.id && !b.id && !a.phone && !b.phone && a.name.toLowerCase() === b.name.toLowerCase())
  );
};
const memberKey = (member) => {
  const normalized = buildMember(member);
  if (normalized.id) return 'id:' + normalized.id;
  if (normalized.phone) return 'phone:' + normalized.phone;
  return 'name:' + normalized.name.toLowerCase();
};
const matchesIdentity = (member, clientId, phone) => {
  const normalized = buildMember(member);
  const safeClientId = toStr(clientId);
  const safePhone = normPhone(phone);
  return Boolean(
    (safeClientId && normalized.id && normalized.id === safeClientId)
    || (safePhone && normalized.phone && normalized.phone === safePhone)
  );
};
const findMemberByIdentity = (members, probe) => {
  const normalizedProbe = buildMember(probe);
  return toArray(members)
    .map((item) => buildMember(item, item?.role || 'MEMBER'))
    .find((item) => sameMemberIdentity(item, normalizedProbe)) || null;
};
const canManageRole = (managerRole, targetRole) => {
  if (managerRole === 'OWNER') return targetRole !== 'OWNER';
  if (managerRole === 'ADMIN') return targetRole === 'MEMBER';
  return false;
};
const canCreateTournamentFeedPost = (role) => role === 'OWNER' || role === 'ADMIN' || role === 'MODERATOR';
const collectGamePhones = (game) => uniq([
  normPhone(game?.organizer?.phoneNorm || game?.organizer?.phone),
  ...toArray(game?.allRelatedPhones).map((value) => normPhone(value)),
  ...toArray(game?.participantPhones).map((value) => normPhone(value)),
  ...toArray(game?.waitlistPhones).map((value) => normPhone(value)),
  ...toArray(game?.participants).map((value) => normPhone(value?.phone || value?.phoneNorm || value?.phoneNumber)),
  ...toArray(game?.waitlist).map((value) => normPhone(value?.phone || value?.phoneNorm || value?.phoneNumber)),
]);
const collectGameIds = (game) => uniq([
  toStr(game?.organizer?.id),
  ...toArray(game?.participants).map((value) => toStr(value?.id || value?.clientId || value?.userId)),
  ...toArray(game?.waitlist).map((value) => toStr(value?.id || value?.clientId || value?.userId)),
]);
const sumMatchScore = (sets, side) => toArray(sets).reduce((total, set) => {
  const rawValue = side === 'A'
    ? (set?.left ?? set?.scoreA ?? set?.teamA)
    : (set?.right ?? set?.scoreB ?? set?.teamB);
  const parsed = toNum(rawValue);
  return total + (Number.isFinite(parsed) ? parsed : 0);
}, 0);
const buildMemberGameStats = (games, member) => {
  const normalizedMember = buildMember(member, 'MEMBER');
  let matchesPlayed = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;

  toArray(games).forEach((game) => {
    if (!isObj(game)) return;
    const status = toStr(game.status)?.toUpperCase() || '';
    if (status.includes('CANCEL')) return;

    const hasMember = Boolean(
      (normalizedMember.id && collectGameIds(game).includes(normalizedMember.id))
      || (normalizedMember.phone && collectGamePhones(game).includes(normalizedMember.phone))
    );
    if (!hasMember) return;

    const matchResult = isObj(game?.metadata?.matchResult) ? game.metadata.matchResult : {};
    const matchStatus = toStr(matchResult.status)?.toUpperCase();
    if (matchStatus !== 'CONFIRMED') return;

    const impactRow = toArray(matchResult.ratingImpact).find((row) => {
      const impactId = toStr(row?.id || row?.clientId || row?.playerId);
      const impactPhone = normPhone(row?.phoneNorm || row?.phone || row?.phoneNumber);
      return Boolean(
        (normalizedMember.id && impactId && impactId === normalizedMember.id)
        || (normalizedMember.phone && impactPhone && impactPhone === normalizedMember.phone)
      );
    });
    if (!impactRow) return;

    const team = toStr(impactRow.team)?.toUpperCase();
    if (team !== 'A' && team !== 'B') return;

    const scoreA = sumMatchScore(matchResult.sets, 'A');
    const scoreB = sumMatchScore(matchResult.sets, 'B');
    matchesPlayed += 1;

    if (scoreA === scoreB) {
      draws += 1;
      return;
    }

    if ((team === 'A' && scoreA > scoreB) || (team === 'B' && scoreB > scoreA)) {
      wins += 1;
      return;
    }

    losses += 1;
  });

  return {
    matchesPlayed,
    wins,
    losses,
    draws,
  };
};
const resolveCommunityLogoFields = (community, options = {}) => {
  const publicBaseUrl = toStr(options.publicBaseUrl);
  const communityId = toStr(community?.id || community?.communityId);
  const logoUrlRaw = toStr(community?.logoUrl || community?.imageUrl);
  const logoThumbUrlRaw = toStr(community?.logoThumbUrl || community?.logoThumb || community?.thumbnailUrl);
  const legacyDataUrl = toStr(community?.logoLegacyDataUrl || community?.logo);
  const assetLogoUrl = toPublicUrl(logoUrlRaw, publicBaseUrl);
  const assetLogoThumbUrl = toPublicUrl(logoThumbUrlRaw, publicBaseUrl) || assetLogoUrl;

  if (assetLogoUrl || assetLogoThumbUrl) {
    return {
      logoUrl: assetLogoUrl || assetLogoThumbUrl || null,
      logoThumbUrl: assetLogoThumbUrl || assetLogoUrl || null,
      logo: assetLogoThumbUrl || assetLogoUrl || null,
    };
  }

  if (legacyDataUrl && isDataUrl(legacyDataUrl) && communityId) {
    const legacyLogoUrl = buildCommunityLegacyLogoUrl(publicBaseUrl, communityId, 'original');
    const legacyLogoThumbUrl = buildCommunityLegacyLogoUrl(publicBaseUrl, communityId, 'thumb');
    return {
      logoUrl: legacyLogoUrl,
      logoThumbUrl: legacyLogoThumbUrl || legacyLogoUrl,
      logo: legacyLogoThumbUrl || legacyLogoUrl,
    };
  }

  const directLogo = toPublicUrl(legacyDataUrl, publicBaseUrl);
  return {
    logoUrl: directLogo,
    logoThumbUrl: directLogo,
    logo: directLogo,
  };
};
const normalizeCommunityForResponse = (value, options = {}) => {
  const community = isObj(value) ? value : {};
  const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
  const pendingMembers = toArray(community.pendingMembers).map((item) => buildMember(item, 'MEMBER'));
  const bannedMembers = toArray(community.bannedMembers);
  const visibility = toVisibility(community.visibility);
  const lastVisibleFeedActivityAt = toStr(community.lastVisibleFeedActivityAt);
  const resolvedLastVisibleFeedActivityTs = toTs(community.lastVisibleFeedActivityTs)
    ?? parseIsoTs(lastVisibleFeedActivityAt);
  const logoFields = resolveCommunityLogoFields(community, options);
  return {
    id: toStr(community.id || community.communityId) || 'community',
    name: toStr(community.name || community.title) || 'Сообщество',
    slug: toStr(community.slug) || buildSlug(community.name || community.title || 'community'),
    logo: logoFields.logo,
    logoUrl: logoFields.logoUrl,
    logoThumbUrl: logoFields.logoThumbUrl,
    isVerified: resolveCommunityVerified(community),
    visibility,
    description: toStr(community.description || community.body) || '',
    city: toStr(community.city) || 'Москва',
    focusTags: extractTags(community.focusTags || community.tags),
    minimumLevel: toStr(community.minimumLevel || community.levelFrom) || 'C',
    joinRule: toJoinRule(community.joinRule, visibility),
    rules: toStr(community.rules || community.policy) || '',
    inviteCode: toStr(community.inviteCode) || '',
    inviteLink: toStr(community.inviteLink || community.link) || '',
    createdAt: toStr(community.createdAt) || nowIso,
    updatedAt: toStr(community.updatedAt),
    lastVisibleFeedActivityAt,
    lastVisibleFeedActivityTs: Number.isFinite(resolvedLastVisibleFeedActivityTs) ? resolvedLastVisibleFeedActivityTs : null,
    members,
    memberCount: Number.isFinite(Number(community.memberCount)) ? Number(community.memberCount) : members.length,
    pendingCount: pendingMembers.length,
    bannedCount: bannedMembers.length,
    membersLoaded: true,
  };
};
const resolveCommunityViewerMembership = (community, clientId, phone) => {
  const members = toArray(community?.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
  const pendingMembers = toArray(community?.pendingMembers).map((item) => buildMember(item, 'MEMBER'));
  const activeMember = members.find((item) => matchesIdentity(item, clientId, phone)) || null;
  if (activeMember) {
    return {
      status: 'ACTIVE',
      member: activeMember,
    };
  }

  const pendingMember = pendingMembers.find((item) => matchesIdentity(item, clientId, phone)) || null;
  if (pendingMember) {
    return {
      status: 'PENDING',
      member: pendingMember,
    };
  }

  return {
    status: null,
    member: null,
  };
};
const canListCommunityForViewer = (community, clientId, phone) => {
  const visibility = toVisibility(community?.visibility);
  const viewerMembership = resolveCommunityViewerMembership(community, clientId, phone);
  return visibility === 'OPEN'
    || viewerMembership.status === 'ACTIVE'
    || viewerMembership.status === 'PENDING';
};
const normalizeCommunitySummaryForResponse = (value, clientId, phone, options = {}) => {
  const normalized = normalizeCommunityForResponse(value, options);
  const viewerMembership = resolveCommunityViewerMembership(value, clientId, phone);
  return Object.assign({}, normalized, {
    members: viewerMembership.status === 'ACTIVE' && viewerMembership.member ? [viewerMembership.member] : [],
    membersLoaded: false,
  });
};
const buildRankingRows = (members) => {
  const sorted = toArray(members)
    .map((item) => buildMember(item, item?.role || 'MEMBER'))
    .sort((left, right) => {
      if (right.levelScore !== left.levelScore) return right.levelScore - left.levelScore;
      return left.name.localeCompare(right.name, 'ru');
    });

  const levelPlaceMap = new Map();
  return sorted.map((member, index) => {
    const nextLevelPlace = (levelPlaceMap.get(member.levelLabel) || 0) + 1;
    levelPlaceMap.set(member.levelLabel, nextLevelPlace);
    return {
      id: member.id,
      phone: member.phone,
      name: member.name,
      avatar: member.avatar,
      role: member.role,
      levelScore: member.levelScore,
      levelLabel: member.levelLabel,
      overallPlace: index + 1,
      levelPlace: nextLevelPlace,
    };
  });
};
const roundNumber = (value, digits = 3) => {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  const factor = 10 ** digits;
  return Math.round(safe * factor) / factor;
};
const toLowerValue = (value) => toStr(value)?.toLowerCase() || '';
const isTruthyValue = (value) => (
  value === true
  || value === 1
  || value === '1'
  || toLowerValue(value) === 'true'
);
const COMMUNITY_RATING_CALCULATION_VERSION = 'community-rating-v1.3.0';
const normalizeRatingTab = (value) => {
  const normalized = toStr(value)?.toLowerCase();
  if (normalized === 'games' || normalized === 'tournaments' || normalized === 'overall') return normalized;
  if (normalized === 'dynamics' || normalized === 'dynamic' || normalized === 'level') return 'dynamics';
  return 'overall';
};
const normalizeRatingPeriod = (value) => {
  const normalized = toStr(value)?.toLowerCase();
  if (normalized === 'all' || normalized === 'alltime' || normalized === 'year') return 'all';
  if (
    normalized === 'month'
    || normalized === '30days'
    || normalized === '30d'
    || normalized === '7d'
    || normalized === '7days'
    || normalized === 'week'
    || normalized === '90d'
    || normalized === '90days'
    || normalized === 'quarter'
  ) return '30d';
  return '30d';
};
const getRatingPeriodStartTs = (period) => {
  if (period === 'all') return null;
  return nowTs - 30 * 24 * 60 * 60 * 1000;
};
const memberIdentityKeys = (value) => {
  const member = buildMember(value, value?.role || 'MEMBER');
  const keys = [];
  if (member.id) keys.push('id:' + member.id);
  if (member.phone) keys.push('phone:' + member.phone);
  if (member.name) keys.push('name:' + member.name.trim().toLowerCase());
  return uniq(keys);
};
const resolveGameMatchResult = (game) => (
  isObj(game?.metadata?.matchResult)
    ? game.metadata.matchResult
    : null
);
const isConfirmedGameResult = (game) => {
  const matchResult = resolveGameMatchResult(game);
  if (!matchResult) return false;
  const status = toStr(matchResult.status)?.toUpperCase() || '';
  const gameStatus = toStr(game?.status || game?.resultStatus)?.toUpperCase() || '';
  const excludedStatuses = ['DISPUTED', 'CORRECTION_PENDING', 'NO_RESULT_EXPIRED', 'PENDING_REVIEW'];
  if (excludedStatuses.includes(status) || excludedStatuses.includes(gameStatus)) return false;
  return status === 'CONFIRMED' || (!status && Boolean(matchResult.confirmedAt || matchResult.confirmedBy));
};
const resolveGameTimestamp = (game, fallbackTs = 0) => {
  const bookingTimeToIso = parseIsoTs(game?.booking?.timeToIso);
  if (Number.isFinite(bookingTimeToIso)) return bookingTimeToIso;
  const bookingTimeFromIso = parseIsoTs(game?.booking?.timeFromIso);
  if (Number.isFinite(bookingTimeFromIso)) return bookingTimeFromIso;
  const bookingDate = toStr(game?.booking?.date);
  const timeTo = toStr(game?.booking?.timeTo);
  const timeFrom = toStr(game?.booking?.timeFrom);

  if (bookingDate && timeTo) {
    const parsed = Date.parse(bookingDate + 'T' + timeTo + ':00');
    if (Number.isFinite(parsed)) return parsed;
  }
  if (bookingDate && timeFrom) {
    const parsed = Date.parse(bookingDate + 'T' + timeFrom + ':00');
    if (Number.isFinite(parsed)) return parsed;
  }

  const updatedAtTs = parseIsoTs(game?.updatedAt);
  if (Number.isFinite(updatedAtTs)) return updatedAtTs;
  const createdAtTs = parseIsoTs(game?.createdAt);
  if (Number.isFinite(createdAtTs)) return createdAtTs;
  return Number.isFinite(fallbackTs) ? fallbackTs : 0;
};
const resolveGameSets = (game) => {
  const matchResult = resolveGameMatchResult(game);
  return toArray(matchResult?.sets)
    .map((item) => {
      if (!isObj(item)) return null;
      const left = toNum(item.left ?? item.scoreA ?? item.teamA);
      const right = toNum(item.right ?? item.scoreB ?? item.teamB);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
      return {
        left: Math.max(0, Math.floor(left)),
        right: Math.max(0, Math.floor(right)),
      };
    })
    .filter(Boolean);
};
const resolveGamePlayerPool = (game) => {
  const matchResult = resolveGameMatchResult(game);
  const participants = [
    ...toArray(game?.participants),
    ...toArray(game?.playerPool),
    ...toArray(game?.metadata?.playerPool),
    ...toArray(game?.waitlist),
    ...toArray(game?.metadata?.waitlist),
    ...toArray(matchResult?.playerPool),
    ...toArray(matchResult?.waitlist),
  ]
    .map((item) => buildMember(item, item?.role || 'MEMBER'));
  if (participants.length > 0) return participants;
  if (isObj(game?.organizer)) return [buildMember(game.organizer, 'MEMBER')];
  return [];
};
const buildFallbackSlotMember = (raw) => ({
  id: toStr(raw),
  phone: normPhone(raw),
  name: toStr(raw) || 'Игрок',
  avatar: null,
  role: 'MEMBER',
  status: 'ACTIVE',
  levelScore: 3.2,
  levelLabel: buildLevelLabel(3.2),
  joinedAt: nowIso,
});
const resolveGameSlotMembers = (game, rawSlots) => {
  const participants = resolveGamePlayerPool(game);
  const participantByKey = new Map();
  participants.forEach((player) => {
    memberIdentityKeys(player).forEach((key) => {
      participantByKey.set(key, player);
    });
  });

  const resolveSlot = (slot) => {
    if (typeof slot === 'string') {
      const raw = toStr(slot);
      if (!raw) return null;
      return (
        participantByKey.get('id:' + raw)
        || participantByKey.get('phone:' + normPhone(raw))
        || participantByKey.get('name:' + raw.toLowerCase())
        || buildFallbackSlotMember(raw)
      );
    }
    if (!isObj(slot)) return null;
    const keys = memberIdentityKeys(slot);
    for (const key of keys) {
      const matched = participantByKey.get(key);
      if (matched) return matched;
    }
    return buildMember(slot, slot?.role || 'MEMBER');
  };

  return toArray(rawSlots)
    .map((slot) => resolveSlot(slot))
    .filter(Boolean);
};
const resolveGameTeamsFromSlots = (game, rawSlots) => {
  const participants = resolveGamePlayerPool(game);
  const slotPlayers = resolveGameSlotMembers(game, rawSlots);

  if (slotPlayers.length === 2) {
    return { left: [slotPlayers[0]], right: [slotPlayers[1]] };
  }
  if (slotPlayers.length >= 3) {
    return { left: uniq(slotPlayers.slice(0, 2)), right: uniq(slotPlayers.slice(2, 4)) };
  }
  if (participants.length === 2) {
    return { left: [participants[0]], right: [participants[1]] };
  }
  const middle = Math.ceil(participants.length / 2);
  return {
    left: uniq(participants.slice(0, middle)),
    right: uniq(participants.slice(middle, 4)),
  };
};
const resolveGameTeams = (game) => resolveGameTeamsFromSlots(game, toArray(game?.metadata?.teamSlots).slice(0, 4));
const resolvePairingRawSlots = (pairing) => {
  if (Array.isArray(pairing)) {
    if (Array.isArray(pairing[0]) || Array.isArray(pairing[1])) {
      return { left: toArray(pairing[0]), right: toArray(pairing[1]) };
    }
    return { left: pairing.slice(0, 2), right: pairing.slice(2, 4) };
  }
  if (!isObj(pairing)) return null;
  const left = toArray(pairing.left ?? pairing.teamA ?? pairing.a ?? pairing.team1 ?? pairing.first);
  const right = toArray(pairing.right ?? pairing.teamB ?? pairing.b ?? pairing.team2 ?? pairing.second);
  if (left.length > 0 || right.length > 0) return { left, right };
  const slots = toArray(pairing.teamSlots ?? pairing.slots ?? pairing.players ?? pairing.pairing);
  if (slots.length > 0) return { left: slots.slice(0, 2), right: slots.slice(2, 4) };
  return null;
};
const resolveGamePairingTeams = (game, pairing) => {
  const raw = resolvePairingRawSlots(pairing);
  if (!raw) return null;
  const teams = resolveGameTeamsFromSlots(game, [...raw.left, ...raw.right]);
  const left = resolveGameSlotMembers(game, raw.left);
  const right = resolveGameSlotMembers(game, raw.right);
  const resolved = {
    left: left.length > 0 ? left : teams.left,
    right: right.length > 0 ? right : teams.right,
  };
  return resolved.left.length > 0 || resolved.right.length > 0 ? resolved : null;
};
const resolveGameSetTeams = (game, sets) => {
  const matchResult = resolveGameMatchResult(game);
  const setPairings = toArray(matchResult?.setPairings);
  const fallbackTeams = resolveGameTeams(game);
  let lastKnownTeams = null;
  return toArray(sets).map((score, index) => {
    const pairingTeams = resolveGamePairingTeams(game, setPairings[index]);
    if (pairingTeams) lastKnownTeams = pairingTeams;
    return {
      score,
      teams: pairingTeams || lastKnownTeams || fallbackTeams,
    };
  });
};
const getGamesReliabilityFactor = (gamesPlayed) => {
  const value = Math.max(0, Math.floor(toNum(gamesPlayed) || 0));
  if (value === 0) return 0;
  if (value <= 2) return 0.6;
  if (value <= 5) return 0.8;
  return 1;
};
const calculateGamesRawScore = (row) => roundNumber(
  (toNum(row.gamesWon) || 0) * 10
  + (toNum(row.setsWon) || 0) * 3
  + (toNum(row.gamesWonCount) || 0) * 0.5
  + (toNum(row.gamesDiff) || 0)
  + (toNum(row.levelDelta) || 0) * 100,
);
const calculatePlaceScore = (place, participantsCount) => {
  const total = Math.max(0, Math.floor(toNum(participantsCount) || 0));
  const rawPlace = Math.max(1, Math.floor(toNum(place) || 1));
  if (total <= 0) return 0;
  const safePlace = Math.min(rawPlace, total);
  return roundNumber(((total - safePlace + 1) / total) * 100);
};
const getPlaceBonus = (place) => {
  const safePlace = Math.max(1, Math.floor(toNum(place) || 1));
  if (safePlace === 1) return 30;
  if (safePlace === 2) return 20;
  if (safePlace === 3) return 10;
  return 0;
};
const getTournamentReliabilityFactor = (tournamentsPlayed) => {
  const value = Math.max(0, Math.floor(toNum(tournamentsPlayed) || 0));
  if (value === 0) return 0;
  if (value === 1) return 0.8;
  return 1;
};
const normalizeScore = (score, maxScore) => {
  const safeScore = Math.max(0, toNum(score) || 0);
  const safeMax = Math.max(0, toNum(maxScore) || 0);
  if (safeMax <= 0) return 0;
  return roundNumber((safeScore / safeMax) * 100);
};
const calculateActivityScore = (gamesPlayed, tournamentsPlayed, visitsAttended = 0) => (
  Math.min(
    100,
    Math.max(0, Math.floor(toNum(gamesPlayed) || 0)) * 4
    + Math.max(0, Math.floor(toNum(tournamentsPlayed) || 0)) * 12
    + Math.max(0, Math.floor(toNum(visitsAttended) || 0)) * 2,
  )
);
const calculateOverallScore = (gamesNormalized, tournamentNormalized, activityScore) => roundNumber(
  (toNum(gamesNormalized) || 0) * 0.2
  + (toNum(tournamentNormalized) || 0) * 0.6
  + (toNum(activityScore) || 0) * 0.2,
);
const resolveTournamentRows = (tournament) => {
  const standings = toArray(tournament?.standings);
  if (standings.length > 0) {
    return standings
      .map((item, index) => {
        if (!isObj(item)) return null;
        const name = toStr(item.name || item.player || item.title);
        const place = toNum(item.rank ?? item.place ?? item.position ?? (index + 1));
        return {
          id: toStr(item.id || item.playerId || item.clientId || item.userId),
          phone: normPhone(item.phone || item.phoneNorm || item.phoneNumber),
          name: name || ('Участник ' + (index + 1)),
          place: Number.isFinite(place) ? Math.max(1, Math.floor(place)) : index + 1,
          wins: toNum(item.wins ?? item.matchesWon) || 0,
          pointsFor: toNum(item.pointsFor ?? item.points ?? item.totalPoints ?? item.tournamentPoints) || 0,
          pointsAgainst: toNum(item.pointsAgainst) || 0,
          pointDiff: toNum(item.pointDiff ?? item.pointsDiff ?? item.delta ?? item.deltaTotal) ?? ((toNum(item.pointsFor) || 0) - (toNum(item.pointsAgainst) || 0)),
        };
      })
      .filter(Boolean);
  }

  if (isObj(tournament?.totals)) {
    const totalsRows = Object.entries(tournament.totals)
      .map(([key, value], index) => {
        if (!isObj(value)) return null;
        const place = toNum(value.rank ?? value.place ?? value.position ?? (index + 1));
        const pointsFor = toNum(value.pointsFor ?? value.points ?? value.totalPoints ?? value.tournamentPoints) || 0;
        const pointsAgainst = toNum(value.pointsAgainst) || 0;
        return {
          id: toStr(value.id || value.playerId || value.clientId || value.userId || key),
          phone: normPhone(value.phone || value.phoneNorm || value.phoneNumber),
          name: toStr(value.name || value.playerName || key) || ('Участник ' + (index + 1)),
          place: Number.isFinite(place) ? Math.max(1, Math.floor(place)) : (index + 1),
          wins: toNum(value.wins ?? value.matchesWon) || 0,
          pointsFor,
          pointsAgainst,
          pointDiff: toNum(value.pointDiff ?? value.pointsDiff ?? value.delta ?? value.deltaTotal) ?? (pointsFor - pointsAgainst),
        };
      })
      .filter(Boolean);

    return totalsRows.sort((left, right) => {
      if ((left.place || 0) !== (right.place || 0)) return (left.place || 0) - (right.place || 0);
      return left.name.localeCompare(right.name, 'ru');
    });
  }

  return [];
};
const resolveTournamentParticipantsCount = (tournament, rows) => {
  const candidates = [
    toArray(tournament?.participants).length,
    toNum(tournament?.summary?.participantsCount ?? tournament?.summary?.joinedCount),
    toNum(tournament?.params?.participantsCount ?? tournament?.params?.joinedCount),
    rows.length,
  ].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates.map((value) => Math.floor(value))) : 0;
};
const isTournamentFinalized = (tournament) => {
  const statuses = [
    tournament?.status,
    tournament?.state,
    tournament?.tournamentStatus,
    tournament?.params?.status,
    tournament?.params?.state,
    tournament?.params?.tournamentStatus,
    tournament?.summary?.status,
    tournament?.summary?.state,
    tournament?.summary?.tournamentStatus,
  ]
    .map((value) => toLowerValue(value))
    .filter(Boolean);
  if (statuses.some((status) => (
    status === 'completed'
    || status === 'finished'
    || status === 'closed'
    || status === 'done'
    || status === 'завершен'
    || status === 'завершён'
  ))) {
    return true;
  }

  const finishMarkers = [
    tournament?.params?.finishedAt,
    tournament?.params?.completedAt,
    tournament?.params?.manualFinishedAt,
    tournament?.summary?.finishedAt,
    tournament?.summary?.completedAt,
  ];
  if (finishMarkers.some((value) => toStr(value))) return true;

  return [
    tournament?.params?.finished,
    tournament?.params?.isFinished,
    tournament?.params?.tournamentFinished,
    tournament?.params?.manualFinish,
    tournament?.summary?.finished,
    tournament?.summary?.isFinished,
    tournament?.summary?.tournamentFinished,
    tournament?.summary?.manualFinish,
  ].some((value) => isTruthyValue(value));
};
const resolveTournamentTimestamp = (tournament, fallbackTs = 0) => (
  parseIsoTs(tournament?.params?.finishedAt)
  ?? parseIsoTs(tournament?.params?.completedAt)
  ?? parseIsoTs(tournament?.params?.manualFinishedAt)
  ?? parseIsoTs(tournament?.summary?.finishedAt)
  ?? parseIsoTs(tournament?.summary?.completedAt)
  ?? parseIsoTs(tournament?.updatedAt)
  ?? parseIsoTs(tournament?.createdAt)
  ?? fallbackTs
);
const buildRatingBadges = (row) => {
  const badges = [];
  const totalEventsPlayed = Math.max(0, Math.floor(toNum(row.totalEventsPlayed) || 0));
  if (totalEventsPlayed === 0) badges.push('no_activity');
  if (row.gamesPlayed > 0 && row.gamesPlayed < 3) badges.push('low_games_data');
  if (row.tournamentsPlayed === 1) badges.push('low_tournament_data');
  if (totalEventsPlayed >= 6) badges.push('reliable');
  if (row.lastActivityTs > 0 && row.lastActivityTs >= nowTs - 14 * 24 * 60 * 60 * 1000) badges.push('active');
  if ((toNum(row.levelDelta) || 0) > 0) badges.push('growing');
  if (row.bestPlace === 1) badges.push('tournament_winner');
  return badges;
};
const sortCommunityRatingItems = (items, tab) => {
  const safeTab = normalizeRatingTab(tab);
  return [...items].sort((left, right) => {
    if (safeTab === 'games') {
      if (right.gamesScore !== left.gamesScore) return right.gamesScore - left.gamesScore;
      if (right.winRate !== left.winRate) return right.winRate - left.winRate;
      if (right.gamesDiff !== left.gamesDiff) return right.gamesDiff - left.gamesDiff;
      if (right.levelDelta !== left.levelDelta) return right.levelDelta - left.levelDelta;
      if (right.gamesPlayed !== left.gamesPlayed) return right.gamesPlayed - left.gamesPlayed;
      if (right.lastActivityTs !== left.lastActivityTs) return right.lastActivityTs - left.lastActivityTs;
      return left.playerName.localeCompare(right.playerName, 'ru');
    }

    if (safeTab === 'tournaments') {
      if (right.tournamentScore !== left.tournamentScore) return right.tournamentScore - left.tournamentScore;
      const leftBest = Number.isFinite(left.bestPlace) ? left.bestPlace : Number.POSITIVE_INFINITY;
      const rightBest = Number.isFinite(right.bestPlace) ? right.bestPlace : Number.POSITIVE_INFINITY;
      if (leftBest !== rightBest) return leftBest - rightBest;
      if (right.tournamentMatchesWon !== left.tournamentMatchesWon) return right.tournamentMatchesWon - left.tournamentMatchesWon;
      if (right.tournamentPointsDiff !== left.tournamentPointsDiff) return right.tournamentPointsDiff - left.tournamentPointsDiff;
      if (right.tournamentsPlayed !== left.tournamentsPlayed) return right.tournamentsPlayed - left.tournamentsPlayed;
      if (right.lastActivityTs !== left.lastActivityTs) return right.lastActivityTs - left.lastActivityTs;
      return left.playerName.localeCompare(right.playerName, 'ru');
    }

    if (safeTab === 'dynamics') {
      if (right.levelDelta !== left.levelDelta) return right.levelDelta - left.levelDelta;
      if (right.currentLevel !== left.currentLevel) return right.currentLevel - left.currentLevel;
      if (right.totalEventsPlayed !== left.totalEventsPlayed) return right.totalEventsPlayed - left.totalEventsPlayed;
      if (right.lastActivityTs !== left.lastActivityTs) return right.lastActivityTs - left.lastActivityTs;
      return left.playerName.localeCompare(right.playerName, 'ru');
    }

    if (right.overallScore !== left.overallScore) return right.overallScore - left.overallScore;
    if (right.gamesScore !== left.gamesScore) return right.gamesScore - left.gamesScore;
    if (right.tournamentScore !== left.tournamentScore) return right.tournamentScore - left.tournamentScore;
    if (right.activityScore !== left.activityScore) return right.activityScore - left.activityScore;
    if (right.lastActivityTs !== left.lastActivityTs) return right.lastActivityTs - left.lastActivityTs;
    return left.playerName.localeCompare(right.playerName, 'ru');
  });
};
const calculateCommunityRatingItems = ({ community, feedPosts, games, tournaments, period, tab }) => {
  const safeTab = normalizeRatingTab(tab);
  const safePeriod = normalizeRatingPeriod(period);
  const periodStartTs = getRatingPeriodStartTs(safePeriod);
  const members = toArray(community?.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
  if (members.length === 0) return [];

  const items = [];
  const itemByIdentity = new Map();
  members.forEach((member, index) => {
    const item = {
      communityId: toStr(community?.id) || null,
      playerId: member.id || member.phone || ('member:' + index),
      playerName: member.name || ('Игрок ' + (index + 1)),
      avatarUrl: member.avatar || null,
      currentLevel: roundNumber(toNum(member.levelScore) || 0, 3),
      levelDelta: 0,
      gamesPlayed: 0,
      gamesWon: 0,
      gamesLost: 0,
      winRate: 0,
      setsWon: 0,
      gamesWonCount: 0,
      gamesDiff: 0,
      gamesRawScore: 0,
      gamesReliabilityFactor: 0,
      gamesScore: 0,
      gamesNormalized: 0,
      tournamentsPlayed: 0,
      tournamentMatchesWon: 0,
      tournamentPointsScored: 0,
      tournamentPointsDiff: 0,
      bestPlace: null,
      averagePlace: null,
      tournamentRawScore: 0,
      tournamentReliabilityFactor: 0,
      tournamentScore: 0,
      tournamentNormalized: 0,
      visitsAttended: 0,
      activityScore: 0,
      overallScore: 0,
      totalEventsPlayed: 0,
      lastActivityAt: null,
      badges: [],
      _placesSum: 0,
      lastActivityTs: 0,
    };
    items.push(item);
    memberIdentityKeys(member).forEach((key) => {
      itemByIdentity.set(key, item);
    });
  });

  const gameById = new Map(
    toArray(games)
      .filter((item) => isObj(item))
      .flatMap((item) => {
        const keys = uniq([toStr(item.id), toStr(item.gameId)]).filter(Boolean);
        return keys.map((key) => [key, item]);
      }),
  );
  const tournamentById = new Map(
    toArray(tournaments)
      .filter((item) => isObj(item))
      .flatMap((item) => {
        const keys = collectTournamentRecordIds(item);
        return keys.map((key) => [key, item]);
      }),
  );

  toArray(feedPosts).forEach((post) => {
    if (!isObj(post) || post.archived === true) return;
    const kind = toStr(post.kind || post.type)?.toUpperCase();
    const fallbackTs = resolveCreatedTs(post);
    if (kind === 'GAME') {
      const gameId = toStr(post.relatedGameId || post.gameId);
      if (!gameId) return;
      const game = gameById.get(gameId);
      if (!game || !isConfirmedGameResult(game)) return;
      const eventTs = resolveGameTimestamp(game, fallbackTs);
      if (periodStartTs !== null && eventTs < periodStartTs) return;
      const sets = resolveGameSets(game);
      if (sets.length === 0) return;

      const rowGameStats = new Map();
      const addSetStats = (player, scoreFor, scoreAgainst) => {
        const row = memberIdentityKeys(player).map((key) => itemByIdentity.get(key)).find(Boolean);
        if (!row) return;
        const stats = rowGameStats.get(row) || { setsWon: 0, setsLost: 0, gamesWonCount: 0, gamesLostCount: 0 };
        stats.setsWon += scoreFor > scoreAgainst ? 1 : 0;
        stats.setsLost += scoreAgainst > scoreFor ? 1 : 0;
        stats.gamesWonCount += scoreFor;
        stats.gamesLostCount += scoreAgainst;
        rowGameStats.set(row, stats);
        row.setsWon += scoreFor > scoreAgainst ? 1 : 0;
        row.gamesWonCount += scoreFor;
        row.gamesDiff += scoreFor - scoreAgainst;
        row.lastActivityTs = Math.max(row.lastActivityTs, eventTs);
      };
      resolveGameSetTeams(game, sets).forEach(({ score, teams }) => {
        uniq(teams.left).forEach((player) => addSetStats(player, score.left, score.right));
        uniq(teams.right).forEach((player) => addSetStats(player, score.right, score.left));
      });
      rowGameStats.forEach((stats, row) => {
        const playerWon = stats.setsWon > stats.setsLost
          || (stats.setsWon === stats.setsLost && stats.gamesWonCount > stats.gamesLostCount);
        const playerLost = stats.setsLost > stats.setsWon
          || (stats.setsWon === stats.setsLost && stats.gamesLostCount > stats.gamesWonCount);
        row.gamesPlayed += 1;
        row.gamesWon += playerWon ? 1 : 0;
        row.gamesLost += playerLost ? 1 : 0;
      });

      const matchResult = resolveGameMatchResult(game);
      toArray(matchResult?.ratingImpact).forEach((impact) => {
        if (!isObj(impact)) return;
        const impactKeys = [];
        const impactId = toStr(impact.id || impact.clientId || impact.playerId || impact.userId);
        const impactPhone = normPhone(impact.phoneNorm || impact.phone || impact.phoneNumber);
        const impactName = toStr(impact.name || impact.playerName);
        if (impactId) impactKeys.push('id:' + impactId);
        if (impactPhone) impactKeys.push('phone:' + impactPhone);
        if (impactName) impactKeys.push('name:' + impactName.toLowerCase());
        const row = impactKeys.map((key) => itemByIdentity.get(key)).find(Boolean);
        if (!row) return;
        row.levelDelta += toNum(impact.delta) || 0;
        row.lastActivityTs = Math.max(row.lastActivityTs, eventTs);
      });
      return;
    }

    if (kind === 'TOURNAMENT') {
      const tournamentId = resolvePostTournamentLinkId(post);
      if (!tournamentId) return;
      const tournament = tournamentById.get(tournamentId);
      if (!tournament) return;
      if (!isTournamentFinalized(tournament)) return;
      const eventTs = resolveTournamentTimestamp(tournament, fallbackTs);
      if (periodStartTs !== null && eventTs < periodStartTs) return;
      const rows = resolveTournamentRows(tournament);
      const participantsCount = resolveTournamentParticipantsCount(tournament, rows);
      if (participantsCount <= 0 || rows.length === 0) return;

      rows.forEach((standing, index) => {
        const keys = [];
        if (standing.id) keys.push('id:' + standing.id);
        if (standing.phone) keys.push('phone:' + standing.phone);
        if (standing.name) keys.push('name:' + standing.name.toLowerCase());
        const row = keys.map((key) => itemByIdentity.get(key)).find(Boolean);
        if (!row) return;
        const place = Math.max(1, Math.floor(toNum(standing.place) || (index + 1)));
        const placeScore = calculatePlaceScore(place, participantsCount);
        const placeBonus = getPlaceBonus(place);
        const rawTournamentScore = roundNumber(
          placeScore
          + (toNum(standing.wins) || 0) * 8
          + (toNum(standing.pointsFor) || 0) * 0.5
          + (toNum(standing.pointDiff) || 0)
          + placeBonus,
        );

        row.tournamentsPlayed += 1;
        row.tournamentMatchesWon += toNum(standing.wins) || 0;
        row.tournamentPointsScored += toNum(standing.pointsFor) || 0;
        row.tournamentPointsDiff += toNum(standing.pointDiff) || 0;
        row.tournamentRawScore += rawTournamentScore;
        row.bestPlace = Number.isFinite(row.bestPlace) ? Math.min(row.bestPlace, place) : place;
        row._placesSum += place;
        row.lastActivityTs = Math.max(row.lastActivityTs, eventTs);
      });
    }
  });

  let maxGamesScore = 0;
  let maxTournamentScore = 0;
  items.forEach((row) => {
    row.levelDelta = roundNumber(row.levelDelta, 3);
    row.gamesRawScore = calculateGamesRawScore(row);
    row.gamesReliabilityFactor = getGamesReliabilityFactor(row.gamesPlayed);
    row.gamesScore = roundNumber(row.gamesRawScore * row.gamesReliabilityFactor, 3);
    row.winRate = row.gamesPlayed > 0 ? roundNumber(row.gamesWon / row.gamesPlayed, 3) : 0;

    row.tournamentRawScore = roundNumber(row.tournamentRawScore, 3);
    row.tournamentReliabilityFactor = getTournamentReliabilityFactor(row.tournamentsPlayed);
    row.tournamentScore = roundNumber(row.tournamentRawScore * row.tournamentReliabilityFactor, 3);
    row.averagePlace = row.tournamentsPlayed > 0
      ? roundNumber(row._placesSum / row.tournamentsPlayed, 2)
      : null;

    row.activityScore = calculateActivityScore(row.gamesPlayed, row.tournamentsPlayed, row.visitsAttended);
    row.totalEventsPlayed = row.gamesPlayed + row.tournamentsPlayed + row.visitsAttended;
    row.lastActivityAt = row.lastActivityTs > 0 ? new Date(row.lastActivityTs).toISOString() : null;

    if (row.gamesScore > maxGamesScore) maxGamesScore = row.gamesScore;
    if (row.tournamentScore > maxTournamentScore) maxTournamentScore = row.tournamentScore;
  });

  items.forEach((row) => {
    row.gamesNormalized = normalizeScore(row.gamesScore, maxGamesScore);
    row.tournamentNormalized = normalizeScore(row.tournamentScore, maxTournamentScore);
    row.overallScore = calculateOverallScore(row.gamesNormalized, row.tournamentNormalized, row.activityScore);
    row.badges = buildRatingBadges(row);
  });

  return sortCommunityRatingItems(items, safeTab).map((row, index) => ({
    rank: index + 1,
    communityId: row.communityId,
    playerId: row.playerId,
    playerName: row.playerName,
    avatarUrl: row.avatarUrl,
    currentLevel: row.currentLevel,
    levelDelta: row.levelDelta,
    gamesPlayed: row.gamesPlayed,
    gamesWon: row.gamesWon,
    gamesLost: row.gamesLost,
    winRate: row.winRate,
    setsWon: row.setsWon,
    gamesWonCount: row.gamesWonCount,
    gamesDiff: row.gamesDiff,
    gamesRawScore: row.gamesRawScore,
    gamesReliabilityFactor: row.gamesReliabilityFactor,
    gamesScore: row.gamesScore,
    gamesNormalized: row.gamesNormalized,
    tournamentsPlayed: row.tournamentsPlayed,
    tournamentMatchesWon: row.tournamentMatchesWon,
    tournamentPointsScored: row.tournamentPointsScored,
    tournamentPointsDiff: row.tournamentPointsDiff,
    bestPlace: row.bestPlace,
    averagePlace: row.averagePlace,
    tournamentRawScore: row.tournamentRawScore,
    tournamentReliabilityFactor: row.tournamentReliabilityFactor,
    tournamentScore: row.tournamentScore,
    tournamentNormalized: row.tournamentNormalized,
    visitsAttended: row.visitsAttended,
    activityScore: row.activityScore,
    overallScore: row.overallScore,
    totalEventsPlayed: row.totalEventsPlayed,
    lastActivityAt: row.lastActivityAt,
    badges: row.badges,
  }));
};
const buildConnections = (communities) => {
  const result = [];
  const safeCommunities = toArray(communities).map((item) => normalizeCommunityForResponse(item));

  for (let leftIndex = 0; leftIndex < safeCommunities.length; leftIndex += 1) {
    const left = safeCommunities[leftIndex];
    const leftKeys = new Set(left.members.map((member) => memberKey(member)));

    for (let rightIndex = leftIndex + 1; rightIndex < safeCommunities.length; rightIndex += 1) {
      const right = safeCommunities[rightIndex];
      const overlap = right.members.reduce((count, member) => count + (leftKeys.has(memberKey(member)) ? 1 : 0), 0);
      if (overlap > 0) {
        result.push({ left: left.id, right: right.id, overlap });
      }
    }
  }

  return result;
};
const isMongoObjectIdLike = (value) => /^[0-9a-f]{24}$/i.test(String(value || '').trim());
const pickNestedRecord = (value, keys) => {
  if (!isObj(value)) return null;
  for (const key of keys) {
    if (isObj(value[key])) return value[key];
  }
  return null;
};
const resolvePostTournamentLinkId = (post) => {
  if (!isObj(post)) return null;
  const direct = toStr(post.relatedTournamentId || post.tournamentId);
  if (direct) return direct;

  const details = pickNestedRecord(post, ['details']);
  const nestedDetails = pickNestedRecord(details, ['details']);
  const publicTournament = pickNestedRecord(details, ['publicTournament']);
  const sourceTournamentSnapshot = pickNestedRecord(details, ['sourceTournamentSnapshot', 'sourceTournament']);
  const stableNestedCandidate = toStr(details?.relatedTournamentId)
    || toStr(nestedDetails?.relatedTournamentId)
    || toStr(publicTournament?.exerciseId || publicTournament?.sourceTournamentId || publicTournament?.tournamentId || publicTournament?.id)
    || toStr(sourceTournamentSnapshot?.exerciseId || sourceTournamentSnapshot?.sourceTournamentId || sourceTournamentSnapshot?.tournamentId || sourceTournamentSnapshot?.id);
  if (stableNestedCandidate) return stableNestedCandidate;

  const legacyCandidate = toStr(details?.tournamentId || nestedDetails?.tournamentId);
  if (!legacyCandidate || isMongoObjectIdLike(legacyCandidate)) return null;
  return legacyCandidate;
};
const collectTournamentRecordIds = (tournament) => {
  const details = pickNestedRecord(tournament, ['details']);
  const publicTournament = pickNestedRecord(details, ['publicTournament']);
  const sourceTournamentSnapshot = pickNestedRecord(details, ['sourceTournamentSnapshot', 'sourceTournament']);
  return uniq([
    toStr(tournament?.tournamentId || tournament?.id || tournament?.exerciseId || tournament?.sourceTournamentId),
    toStr(details?.tournamentId || details?.id || details?.exerciseId || details?.sourceTournamentId),
    toStr(publicTournament?.tournamentId || publicTournament?.id || publicTournament?.exerciseId || publicTournament?.sourceTournamentId),
    toStr(sourceTournamentSnapshot?.tournamentId || sourceTournamentSnapshot?.id || sourceTournamentSnapshot?.exerciseId || sourceTournamentSnapshot?.sourceTournamentId),
  ]);
};
const extractInviteCode = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const decodeInviteToken = (token) => {
    const normalized = toStr(token);
    if (!normalized) return null;
    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  };
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) {
    const query = raw.slice(queryIndex + 1).split('#')[0] || '';
    const params = query.split('&').filter(Boolean);
    for (const pair of params) {
      const separatorIndex = pair.indexOf('=');
      const key = separatorIndex >= 0 ? pair.slice(0, separatorIndex) : pair;
      const paramValue = separatorIndex >= 0 ? pair.slice(separatorIndex + 1) : '';
      const decodedKey = decodeInviteToken(key);
      if (decodedKey === 'invite' || decodedKey === 'code') {
        return decodeInviteToken(paramValue.replace(/\+/g, ' '));
      }
    }
  }

  const pathWithoutHash = raw.split('#')[0] || '';
  const pathWithoutQuery = pathWithoutHash.split('?')[0] || '';
  const parts = pathWithoutQuery.split('/').filter(Boolean);
  return decodeInviteToken(parts.length ? parts[parts.length - 1] : null);
};
const toReaction = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized === 'LIKE') return 'LIKE';
  if (normalized === 'DISLIKE') return 'DISLIKE';
  return null;
};
const buildActorKey = (member) => {
  const normalized = buildMember(member, 'MEMBER');
  if (normalized.id) return normalized.id;
  if (normalized.phone) return normalized.phone;
  return buildSlug(normalized.name).slice(0, 40);
};
const buildFeedReactionDocId = (communityId, postId, member) => [
  toStr(communityId) || 'community',
  'reaction',
  toStr(postId) || 'post',
  buildActorKey(member),
].join(':');
const isPhotoFeedPost = (post) => toStr(post?.kind || post?.type)?.toUpperCase() === 'PHOTO';
const normalizeFeedCommentForResponse = (item) => {
  if (!isObj(item)) return null;
  const id = toStr(item.id || item.commentId || item.uuid);
  const communityId = toStr(item.communityId);
  const postId = toStr(item.postId || item.feedPostId);
  const text = toStr(item.text || item.body || item.message);
  if (!id || !communityId || !postId || !text) return null;

  return {
    id,
    communityId,
    postId,
    text,
    createdAt: toStr(item.createdAt || item.publishedAt) || nowIso,
    createdTs: resolveCreatedTs(item),
    authorId: toStr(item.authorId || item.author?.id || item.sender?.id),
    authorPhone: normPhone(
      item.authorPhone
      || item.author?.phone
      || item.author?.phoneNorm
      || item.sender?.phone
      || item.sender?.phoneNorm,
    ),
    authorName: toStr(item.authorName || item.author?.name || item.sender?.name) || 'Игрок',
    authorAvatar: toStr(
      item.authorAvatar
      || item.author?.avatar
      || item.author?.photo
      || item.author?.imageUrl
      || item.sender?.avatar
      || item.sender?.photo
      || item.sender?.imageUrl,
    ),
  };
};
const buildFeedThreadSnapshot = ({ communityId, postId, comments, reactions, clientId, phone }) => {
  const normalizedComments = toArray(comments)
    .map((item) => normalizeFeedCommentForResponse(item))
    .filter(Boolean)
    .sort((left, right) => left.createdTs - right.createdTs);
  let likesCount = 0;
  let dislikesCount = 0;
  let viewerReaction = null;

  toArray(reactions)
    .filter((item) => item && item.archived !== true)
    .forEach((item) => {
      const reaction = toReaction(item.reaction || item.value || item.kind);
      if (!reaction) return;
      if (reaction === 'LIKE') likesCount += 1;
      if (reaction === 'DISLIKE') dislikesCount += 1;

      if (matchesIdentity(item.actor || item.author || {}, clientId, phone)) {
        viewerReaction = reaction;
      }
    });

  return {
    communityId: toStr(communityId) || null,
    postId: toStr(postId) || null,
    likesCount,
    dislikesCount,
    commentsCount: normalizedComments.length,
    viewerReaction,
    comments: normalizedComments,
  };
};
`;

const fnMediaUpload = `${commonHelpers}
const body = isObj(msg.payload) ? msg.payload : {};
const originalSource = body.dataUrl || body.logoDataUrl || body.logo || null;
const thumbSource = body.thumbDataUrl || body.logoThumbDataUrl || body.thumbnailDataUrl || body.logoThumb || null;
const original = parseDataUrl(originalSource);
const thumb = parseDataUrl(thumbSource);

if (!original || !thumb) {
  const errorMsg = withJson(msg, 400, { error: 'dataUrl and thumbDataUrl are required' });
  return [null, errorMsg, errorMsg];
}

if (!String(original.mimeType || '').startsWith('image/') || !String(thumb.mimeType || '').startsWith('image/')) {
  const errorMsg = withJson(msg, 400, { error: 'Only image uploads are supported' });
  return [null, errorMsg, errorMsg];
}

const originalSize = getDataUrlByteSize(originalSource);
const thumbSize = getDataUrlByteSize(thumbSource);
if (!originalSize || !thumbSize) {
  const errorMsg = withJson(msg, 400, { error: 'Image payload is empty' });
  return [null, errorMsg, errorMsg];
}

if (originalSize > 2 * 1024 * 1024 || thumbSize > 256 * 1024) {
  const errorMsg = withJson(msg, 413, { error: 'Image payload is too large' });
  return [null, errorMsg, errorMsg];
}

const assetId = 'community_logo_' + nowTs + '_' + Math.random().toString(36).slice(2, 10);
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const assetDoc = {
  id: assetId,
  kind: 'community-logo',
  original: {
    mimeType: original.mimeType,
    encoding: original.encoding,
    body: original.body,
    size: originalSize,
  },
  thumb: {
    mimeType: thumb.mimeType,
    encoding: thumb.encoding,
    body: thumb.body,
    size: thumbSize,
  },
  createdAt: nowIso,
  updatedAt: nowIso,
  archived: false,
};

const insertMsg = Object.assign({}, msg, { payload: assetDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  assetId,
  logoUrl: buildCommunityLogoAssetUrl(publicBaseUrl, assetId, 'original'),
  logoThumbUrl: buildCommunityLogoAssetUrl(publicBaseUrl, assetId, 'thumb'),
});
return [insertMsg, responseMsg, responseMsg];
`;

const fnMediaAssetGetPrepare = `${commonHelpers}
const assetId = toStr(msg.req?.params?.assetId);
if (!assetId) {
  const errorMsg = withJson(msg, 400, { error: 'assetId is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityLogoAsset = {
  assetId,
  variant: resolveRequestedLogoVariant(msg.req),
};
msg.payload = { id: assetId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnMediaAssetGetResponse = `${commonHelpers}
const rows = toArray(msg.payload).filter((item) => !item?.archived);
const ctx = isObj(msg._communityLogoAsset) ? msg._communityLogoAsset : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Logo asset not found' });
  return [null, errorMsg, errorMsg];
}

const asset = rows[0];
const variant = ctx.variant === 'thumb' ? 'thumb' : 'original';
const storedPart = isObj(asset?.[variant])
  ? asset[variant]
  : (variant === 'thumb' && isObj(asset?.original) ? asset.original : null);
if (!storedPart) {
  const errorMsg = withJson(msg, 404, { error: 'Logo variant not found' });
  return [null, errorMsg, errorMsg];
}

const encoding = toStr(storedPart.encoding)?.toLowerCase() === 'utf8' ? 'utf8' : 'base64';
const rawBody = typeof storedPart.body === 'string' ? storedPart.body : '';
if (!rawBody) {
  const errorMsg = withJson(msg, 404, { error: 'Logo asset is empty' });
  return [null, errorMsg, errorMsg];
}

try {
  const buffer = Buffer.from(rawBody, encoding === 'utf8' ? 'utf8' : 'base64');
  msg.statusCode = 200;
  msg.headers = buildBinaryHeaders(storedPart.mimeType, buffer.length);
  msg.payload = buffer;
  return [msg, msg];
} catch {
  const errorMsg = withJson(msg, 500, { error: 'Failed to decode logo asset' });
  return [null, errorMsg, errorMsg];
}
`;

const fnMediaLegacyGetPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityLegacyLogo = {
  communityId,
  variant: resolveRequestedLogoVariant(msg.req),
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnMediaLegacyGetResponse = `${commonHelpers}
const rows = toArray(msg.payload).filter((item) => !item?.archived);
const ctx = isObj(msg._communityLegacyLogo) ? msg._communityLegacyLogo : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const variant = ctx.variant === 'thumb' ? 'thumb' : 'original';
const preferredSource = variant === 'thumb'
  ? (
      community.logoThumbLegacyDataUrl
      || community.logoThumbDataUrl
      || community.logoLegacyDataUrl
      || (isDataUrl(community.logoThumbUrl) ? community.logoThumbUrl : null)
      || (isDataUrl(community.logo) ? community.logo : null)
    )
  : (
      community.logoLegacyDataUrl
      || community.logoDataUrl
      || (isDataUrl(community.logoUrl) ? community.logoUrl : null)
      || (isDataUrl(community.logo) ? community.logo : null)
    );
const parsed = parseDataUrl(preferredSource);
if (!parsed) {
  const errorMsg = withJson(msg, 404, { error: 'Legacy logo not found' });
  return [null, errorMsg, errorMsg];
}

try {
  const buffer = Buffer.from(parsed.body, parsed.encoding === 'utf8' ? 'utf8' : 'base64');
  msg.statusCode = 200;
  msg.headers = buildBinaryHeaders(parsed.mimeType, buffer.length);
  msg.payload = buffer;
  return [msg, msg];
} catch {
  const errorMsg = withJson(msg, 500, { error: 'Failed to decode legacy logo' });
  return [null, errorMsg, errorMsg];
}
`;

const fnListPrepare = `${commonHelpers}
const listMode = toStr(msg.req?.query?.view || msg.req?.query?.mode)?.toLowerCase() === 'summary'
  ? 'SUMMARY'
  : 'FULL';
msg._communityList = {
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  clientId: toStr(msg.req?.query?.clientId),
  listMode,
};

const listQuery = { archived: { $ne: true } };
if (listMode !== 'SUMMARY') {
  msg.payload = listQuery;
  return [msg, null, msg];
}

const viewerIdentityFilters = [];
if (msg._communityList.clientId) {
  ['id', 'clientId', 'userId', 'uuid'].forEach((field) => {
    viewerIdentityFilters.push({ [field]: msg._communityList.clientId });
  });
}
if (msg._communityList.phone) {
  ['phone', 'phoneNorm', 'phoneNumber', 'mobile'].forEach((field) => {
    viewerIdentityFilters.push({ [field]: msg._communityList.phone });
  });
}

const summaryProjection = {
  _id: 0,
  id: 1,
  communityId: 1,
  name: 1,
  title: 1,
  slug: 1,
  logo: 1,
  logoUrl: 1,
  logoThumbUrl: 1,
  logoAssetId: 1,
  logoLegacyDataUrl: 1,
  imageUrl: 1,
  visibility: 1,
  description: 1,
  body: 1,
  city: 1,
  focusTags: 1,
  tags: 1,
  minimumLevel: 1,
  levelFrom: 1,
  joinRule: 1,
  rules: 1,
  policy: 1,
  inviteCode: 1,
  inviteLink: 1,
  link: 1,
  createdAt: 1,
  updatedAt: 1,
  lastVisibleFeedActivityAt: 1,
  lastVisibleFeedActivityTs: 1,
  memberCount: 1,
  isVerified: 1,
  verified: 1,
  isOfficial: 1,
  official: 1,
  verification: 1,
  verificationInfo: 1,
  verificationStatus: 1,
  statusVerification: 1,
  verifiedAt: 1,
};
if (viewerIdentityFilters.length > 0) {
  const viewerMatch = { $or: viewerIdentityFilters };
  summaryProjection.members = { $elemMatch: viewerMatch };
  summaryProjection.pendingMembers = { $elemMatch: viewerMatch };
}

msg.payload = listQuery;
msg.projection = summaryProjection;
return [msg, null, msg];
`;

const fnListResponse = `${commonHelpers}
const ctx = isObj(msg._communityList) ? msg._communityList : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const rows = toArray(msg.payload).filter((item) => !item?.archived);
const isSummaryMode = ctx.listMode === 'SUMMARY';
const scopedRows = isSummaryMode
  ? rows.filter((item) => canListCommunityForViewer(item, ctx.clientId, ctx.phone))
  : rows;
const communities = scopedRows
  .map((item) => (
    isSummaryMode
      ? normalizeCommunitySummaryForResponse(item, ctx.clientId, ctx.phone, { publicBaseUrl })
      : normalizeCommunityForResponse(item, { publicBaseUrl })
  ))
  .sort((left, right) => Date.parse(right.createdAt || nowIso) - Date.parse(left.createdAt || nowIso));

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = {
  communities,
  connections: isSummaryMode ? [] : buildConnections(scopedRows),
  total: communities.length,
};
return [msg, msg];
`;

const fnGetPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityGet = {
  communityId,
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  clientId: toStr(msg.req?.query?.clientId),
};

msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnGetResponse = `${commonHelpers}
const rows = toArray(msg.payload).filter((item) => !item?.archived);
const ctx = isObj(msg._communityGet) ? msg._communityGet : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const sourceCommunity = rows[0];
const visibility = toVisibility(sourceCommunity.visibility);
const viewerMembership = resolveCommunityViewerMembership(sourceCommunity, ctx.clientId, ctx.phone);
const canAccess = visibility === 'OPEN' || viewerMembership.status === 'ACTIVE';

if (!canAccess) {
  const errorMsg = withJson(msg, 403, { error: 'Access denied' });
  return [null, errorMsg, errorMsg];
}

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = normalizeCommunityForResponse(sourceCommunity, { publicBaseUrl });
return [msg, msg];
`;

const fnCreate = `${commonHelpers}
const body = isObj(msg.payload) ? msg.payload : {};
const name = toStr(body.name);
const description = toStr(body.description);
const city = toStr(body.city);
if (!name || !description || !city) {
  const errorMsg = withJson(msg, 400, { error: 'name, description and city are required' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const visibility = toVisibility(body.visibility);
const joinRule = toJoinRule(body.joinRule, visibility);
const creator = buildMember(body.creator || body.member || body.owner, 'OWNER');
creator.role = 'OWNER';
creator.status = 'ACTIVE';

if (!creator.id && !creator.phone) {
  const errorMsg = withJson(msg, 400, { error: 'creator id or phone is required' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const slug = toStr(body.slug) || buildSlug(name);
const communityId = toStr(body.id || body.communityId) || 'community_' + nowTs + '_' + slug;
const inviteCode = toStr(body.inviteCode) || buildInviteCode(name);
const focusTags = extractTags(body.focusTags || body.tags);
const minimumLevel = toStr(body.minimumLevel) || 'C';
const rules = toStr(body.rules) || 'Уважайте расписание и фиксируйте изменения в ленте сообщества.';
const logoFields = resolveIncomingCommunityLogoFields(body);
const publicBaseUrl = buildPublicBaseUrl(msg.req);

const communityDoc = {
  id: communityId,
  name,
  slug,
  logo: logoFields.logo,
  logoUrl: logoFields.logoUrl,
  logoThumbUrl: logoFields.logoThumbUrl,
  logoLegacyDataUrl: logoFields.logoLegacyDataUrl,
  visibility,
  description,
  city,
  focusTags,
  minimumLevel,
  joinRule,
  rules,
  inviteCode,
  inviteLink: buildInviteLink(inviteCode),
  createdAt: nowIso,
  updatedAt: nowIso,
  lastVisibleFeedActivityAt: null,
  lastVisibleFeedActivityTs: null,
  members: [creator],
  memberCount: 1,
  pendingMembers: [],
  bannedMembers: [],
  archived: false,
  createdBy: {
    id: creator.id,
    phone: creator.phone,
    name: creator.name,
  },
};

const rankingRows = buildRankingRows(communityDoc.members);
const rankingDoc = {
  communityId,
  rows: rankingRows,
  updatedAt: nowIso,
  createdAt: nowIso,
};

const responseCommunity = normalizeCommunityForResponse(communityDoc, { publicBaseUrl });
const responsePayload = {
  ok: true,
  membershipStatus: 'ACTIVE',
  message: 'Сообщество создано',
  community: responseCommunity,
  feedPost: null,
  ranking: {
    communityId,
    updatedAt: nowIso,
    rows: rankingRows,
  },
};

const communityMsg = Object.assign({}, msg, {
  query: { id: communityId },
  payload: {
    $set: communityDoc,
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});
const rankingMsg = Object.assign({}, msg, {
  query: { communityId },
  payload: {
    $set: {
      communityId,
      rows: rankingRows,
      updatedAt: nowIso,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});
const responseMsg = withJson(msg, 200, responsePayload);
return [communityMsg, null, rankingMsg, null, responseMsg, responseMsg];
`;

const fnJoinPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.user || body.actor, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityJoin = {
  viaInvite: false,
  communityId,
  member,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnInvitePrepare = `${commonHelpers}
const body = isObj(msg.payload) ? msg.payload : {};
const inviteCode = extractInviteCode(body.inviteCode || body.code || body.inviteLink || body.link);
if (!inviteCode) {
  const errorMsg = withJson(msg, 400, { error: 'inviteCode is required' });
  return [null, errorMsg, errorMsg];
}

const member = buildMember(body.member || body.user || body.actor, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityJoin = {
  viaInvite: true,
  inviteCode,
  member,
};
msg.payload = { inviteCode, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnJoinGamesQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityJoin) ? msg._communityJoin : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const member = buildMember(ctx.member, 'MEMBER');

if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
msg._communityJoin = Object.assign({}, ctx, {
  community,
  member,
  communityId: toStr(community.id || ctx.communityId),
});

// Skip lk_games lookup in join flow: it may be slow and should never block membership.
// Member stats will be empty when joining and can be refreshed asynchronously later.
msg.payload = [];
return [msg, null, msg];
`;

const fnJoinApply = `${commonHelpers}
const ctx = isObj(msg._communityJoin) ? msg._communityJoin : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const member = buildMember(ctx.member, 'MEMBER');
const community = isObj(ctx.community) ? ctx.community : null;
const memberGames = toArray(msg.payload);

if (!community) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const memberStats = buildMemberGameStats(memberGames, member);
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const pendingMembers = toArray(community.pendingMembers).map((item) => buildMember(item, 'MEMBER'));
const bannedMembers = toArray(community.bannedMembers).map((item) => buildMember(item, 'MEMBER'));
const communityVisibility = toVisibility(community.visibility);
const communityJoinRule = toJoinRule(community.joinRule, communityVisibility);
const alreadyMember = members.some((item) => sameMemberIdentity(item, member));
const alreadyPending = pendingMembers.some((item) => sameMemberIdentity(item, member));
const isBanned = bannedMembers.some((item) => sameMemberIdentity(item, member));

if (alreadyMember) {
  const existingCommunity = normalizeCommunityForResponse(community, { publicBaseUrl });
  const existingRankingRows = buildRankingRows(members);
  const responseMsg = withJson(msg, 200, {
    ok: true,
    membershipStatus: 'ACTIVE',
    message: 'Вы уже состоите в этом сообществе',
    community: existingCommunity,
    feedPost: null,
    ranking: {
      communityId: existingCommunity.id,
      updatedAt: toStr(community.updatedAt) || nowIso,
      rows: existingRankingRows,
    },
  });
  return [null, null, null, null, responseMsg, responseMsg];
}

if (isBanned) {
  const errorMsg = withJson(msg, 403, { error: 'Этот участник заблокирован в сообществе' });
  return [null, null, null, null, errorMsg, errorMsg];
}

if (!ctx.viaInvite && communityVisibility === 'CLOSED') {
  const errorMsg = withJson(msg, 403, { error: 'Closed communities are available only via invite' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const baseUpdate = {
  updatedAt: nowIso,
};

if (communityJoinRule === 'MODERATED' && !ctx.viaInvite) {
  if (alreadyPending) {
    const responseMsg = withJson(msg, 200, {
      ok: true,
      membershipStatus: 'PENDING',
      message: 'Заявка уже ожидает модерации',
      community: normalizeCommunityForResponse(Object.assign({}, community, {
        pendingMembers,
      }), { publicBaseUrl }),
      feedPost: null,
      ranking: null,
    });
    return [null, null, null, null, responseMsg, responseMsg];
  }

  const nextPendingMembers = [member, ...pendingMembers];
  const nextCommunity = Object.assign({}, community, {
    pendingMembers: nextPendingMembers,
    updatedAt: nowIso,
  });

  const eventDoc = {
    id: nextCommunity.id + ':event:' + nowTs + ':request:' + (member.id || member.phone || 'member'),
    communityId: nextCommunity.id,
    type: 'MEMBERSHIP_REQUESTED',
    actor: {
      id: member.id,
      phone: member.phone,
      name: member.name,
    },
    createdAt: nowIso,
    createdTs: nowTs,
    payload: {
      viaInvite: false,
    },
  };

  const communityMsg = Object.assign({}, msg, {
    query: { id: nextCommunity.id, archived: { $ne: true } },
    payload: {
      $set: Object.assign({}, baseUpdate, {
        pendingMembers: nextPendingMembers,
      }),
    },
  });

  const eventMsg = Object.assign({}, msg, { payload: eventDoc });
  const responseMsg = withJson(msg, 200, {
    ok: true,
    membershipStatus: 'PENDING',
    message: 'Заявка отправлена модератору сообщества',
    community: normalizeCommunityForResponse(nextCommunity, { publicBaseUrl }),
    feedPost: null,
    ranking: null,
  });
  return [communityMsg, null, null, eventMsg, responseMsg, responseMsg];
}

const cleanedPendingMembers = pendingMembers.filter((item) => !sameMemberIdentity(item, member));
const nextMembers = [member, ...members];
const nextCommunity = Object.assign({}, community, {
  members: nextMembers,
  memberCount: nextMembers.length,
  pendingMembers: cleanedPendingMembers,
  updatedAt: nowIso,
});
const rankingRows = buildRankingRows(nextMembers);

const feedDoc = {
  id: nextCommunity.id + ':post:' + nowTs + ':join',
  communityId: nextCommunity.id,
  kind: 'SYSTEM',
  title: 'Новый участник',
  body: member.name + ' вступил в сообщество.',
  imageUrl: null,
  previewLabel: member.levelLabel,
  memberPreview: {
    id: member.id,
    phone: member.phone,
    name: member.name,
    avatar: member.avatar,
    levelScore: member.levelScore,
    levelLabel: member.levelLabel,
    stats: memberStats,
  },
  ctaLabel: null,
  relatedGameId: null,
  relatedTournamentId: null,
  author: {
    id: member.id,
    phone: member.phone,
    name: member.name,
    avatar: member.avatar || null,
    levelScore: member.levelScore,
    levelLabel: member.levelLabel,
  },
  authorName: member.name,
  publishedAt: nowIso,
  createdAt: nowIso,
  createdTs: nowTs,
  archived: false,
};

const eventDoc = {
  id: nextCommunity.id + ':event:' + nowTs + ':join:' + (member.id || member.phone || 'member'),
  communityId: nextCommunity.id,
  type: ctx.viaInvite ? 'MEMBER_JOINED_BY_INVITE' : 'MEMBER_JOINED',
  actor: {
    id: member.id,
    phone: member.phone,
    name: member.name,
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    viaInvite: Boolean(ctx.viaInvite),
  },
};

const communityMsg = Object.assign({}, msg, {
  query: { id: nextCommunity.id, archived: { $ne: true } },
  payload: {
    $set: Object.assign({}, baseUpdate, {
      members: nextMembers,
      memberCount: nextMembers.length,
      pendingMembers: cleanedPendingMembers,
    }),
  },
});

const rankingMsg = Object.assign({}, msg, {
  query: { communityId: nextCommunity.id },
  payload: {
    $set: {
      communityId: nextCommunity.id,
      rows: rankingRows,
      updatedAt: nowIso,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});

const feedMsg = Object.assign({}, msg, { payload: feedDoc });
const eventMsg = Object.assign({}, msg, { payload: eventDoc });

const responseMsg = withJson(msg, 200, {
  ok: true,
  membershipStatus: 'ACTIVE',
  message: ctx.viaInvite ? 'Вы вошли в сообщество по приглашению' : 'Вступление в сообщество сохранено',
  community: normalizeCommunityForResponse(nextCommunity, { publicBaseUrl }),
  feedPost: feedDoc,
  ranking: {
    communityId: nextCommunity.id,
    updatedAt: nowIso,
    rows: rankingRows,
  },
});

return [communityMsg, rankingMsg, feedMsg, eventMsg, responseMsg, responseMsg];
`;

const fnUpdatePrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const actor = buildMember(body.actor || body.member || body.user, 'MEMBER');
if (!actor.id && !actor.phone) {
  const errorMsg = withJson(msg, 400, { error: 'actor id or phone is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityUpdate = {
  communityId,
  actor,
  body,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnUpdateApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityUpdate) ? msg._communityUpdate : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, null, errorMsg, errorMsg];
}

const community = rows[0];
const body = isObj(ctx.body) ? ctx.body : {};
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const manager = findMemberByIdentity(members, ctx.actor);
if (!manager || (manager.role !== 'OWNER' && manager.role !== 'ADMIN')) {
  const errorMsg = withJson(msg, 403, { error: 'Only owner or admin can update community settings' });
  return [null, null, errorMsg, errorMsg];
}

const currentName = toStr(community.name || community.title);
const name = toStr(body.name) || currentName;
const description = toStr(body.description || body.body) || toStr(community.description || community.body) || '';
const city = toStr(body.city) || toStr(community.city) || 'Москва';
if (!name || !description || !city) {
  const errorMsg = withJson(msg, 400, { error: 'name, description and city are required' });
  return [null, null, errorMsg, errorMsg];
}

const visibility = toVisibility(body.visibility || community.visibility);
const joinRule = visibility === 'CLOSED'
  ? 'INVITE_ONLY'
  : toJoinRule(body.joinRule || community.joinRule, visibility);
const minimumLevel = toStr(body.minimumLevel || community.minimumLevel || community.levelFrom) || 'C';
const rules = toStr(body.rules || body.policy) || toStr(community.rules || community.policy) || 'Уважайте правила сообщества.';
const focusTags = extractTags(
  Object.prototype.hasOwnProperty.call(body, 'focusTags') || Object.prototype.hasOwnProperty.call(body, 'tags')
    ? (body.focusTags || body.tags)
    : (community.focusTags || community.tags),
);
const inviteCode = toStr(community.inviteCode) || buildInviteCode(name);
const logoFields = resolveIncomingCommunityLogoFields(body, community);
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const nextCommunity = Object.assign({}, community, {
  name,
  slug: toStr(body.slug || community.slug) || buildSlug(name),
  logo: logoFields.logo,
  logoUrl: logoFields.logoUrl,
  logoThumbUrl: logoFields.logoThumbUrl,
  logoLegacyDataUrl: logoFields.logoLegacyDataUrl,
  visibility,
  description,
  city,
  focusTags,
  minimumLevel,
  joinRule,
  rules,
  inviteCode,
  inviteLink: buildInviteLink(inviteCode),
  memberCount: members.length,
  updatedAt: nowIso,
});
const rankingRows = buildRankingRows(members);

const eventDoc = {
  id: nextCommunity.id + ':event:' + nowTs + ':update',
  communityId: nextCommunity.id,
  type: 'COMMUNITY_UPDATED',
  actor: {
    id: manager.id,
    phone: manager.phone,
    name: manager.name,
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    visibility,
    joinRule,
    city,
    minimumLevel,
  },
};

const communityMsg = Object.assign({}, msg, {
  query: { id: nextCommunity.id, archived: { $ne: true } },
  payload: {
    $set: {
      name: nextCommunity.name,
      slug: nextCommunity.slug,
      logo: nextCommunity.logo || null,
      logoUrl: nextCommunity.logoUrl || null,
      logoThumbUrl: nextCommunity.logoThumbUrl || null,
      logoLegacyDataUrl: nextCommunity.logoLegacyDataUrl || null,
      visibility: nextCommunity.visibility,
      description: nextCommunity.description,
      city: nextCommunity.city,
      focusTags: nextCommunity.focusTags,
      minimumLevel: nextCommunity.minimumLevel,
      joinRule: nextCommunity.joinRule,
      rules: nextCommunity.rules,
      inviteCode: nextCommunity.inviteCode,
      inviteLink: nextCommunity.inviteLink,
      memberCount: nextCommunity.memberCount,
      updatedAt: nextCommunity.updatedAt,
    },
  },
});

const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  membershipStatus: 'ACTIVE',
  message: 'Настройки сообщества обновлены',
  community: normalizeCommunityForResponse(nextCommunity, { publicBaseUrl }),
  feedPost: null,
  ranking: {
    communityId: nextCommunity.id,
    updatedAt: nowIso,
    rows: rankingRows,
  },
});
return [communityMsg, eventMsg, responseMsg, responseMsg];
`;

const fnMemberManagePrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const action = toStr(body.action)?.toUpperCase();
if (action !== 'REMOVE' && action !== 'BAN') {
  const errorMsg = withJson(msg, 400, { error: 'action must be REMOVE or BAN' });
  return [null, errorMsg, errorMsg];
}

const actor = buildMember(body.actor || body.manager || body.user, 'MEMBER');
if (!actor.id && !actor.phone) {
  const errorMsg = withJson(msg, 400, { error: 'actor id or phone is required' });
  return [null, errorMsg, errorMsg];
}

const member = buildMember(body.member || body.target || body.participant, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityMemberManage = {
  communityId,
  action,
  actor,
  member,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnMemberManageApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityMemberManage) ? msg._communityMemberManage : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const community = rows[0];
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const manager = findMemberByIdentity(members, ctx.actor);
if (!manager) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can manage membership state' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const target = findMemberByIdentity(members, ctx.member);
if (!target) {
  const errorMsg = withJson(msg, 404, { error: 'Community member not found' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const isSelfRemoval = ctx.action === 'REMOVE' && sameMemberIdentity(target, manager);

if (!isSelfRemoval && (manager.role !== 'OWNER' && manager.role !== 'ADMIN')) {
  const errorMsg = withJson(msg, 403, { error: 'Only owner or admin can manage community members' });
  return [null, null, null, null, errorMsg, errorMsg];
}

if (isSelfRemoval && manager.role === 'OWNER') {
  const errorMsg = withJson(msg, 403, { error: 'Community owner must transfer ownership before leaving' });
  return [null, null, null, null, errorMsg, errorMsg];
}

if (!isSelfRemoval && sameMemberIdentity(target, manager)) {
  const errorMsg = withJson(msg, 400, { error: 'You cannot manage yourself' });
  return [null, null, null, null, errorMsg, errorMsg];
}

if (!isSelfRemoval && !canManageRole(manager.role, target.role)) {
  const errorMsg = withJson(msg, 403, { error: 'You cannot manage this member' });
  return [null, null, null, null, errorMsg, errorMsg];
}

const nextMembers = members.filter((item) => !sameMemberIdentity(item, target));
const currentBannedMembers = toArray(community.bannedMembers);
const nextBannedMembers = ctx.action === 'BAN'
  ? [
      Object.assign({}, target, {
        bannedAt: nowIso,
        bannedBy: {
          id: manager.id,
          phone: manager.phone,
          name: manager.name,
        },
      }),
      ...currentBannedMembers.filter((item) => !sameMemberIdentity(item, target)),
    ]
  : currentBannedMembers.filter((item) => !sameMemberIdentity(item, target));
const nextCommunity = Object.assign({}, community, {
  members: nextMembers,
  memberCount: nextMembers.length,
  bannedMembers: nextBannedMembers,
  updatedAt: nowIso,
});
const rankingRows = buildRankingRows(nextMembers);

const feedDoc = {
  id: nextCommunity.id + ':post:' + nowTs + ':' + String(ctx.action || 'member').toLowerCase(),
  communityId: nextCommunity.id,
  kind: 'SYSTEM',
  title: ctx.action === 'BAN'
    ? 'Участник заблокирован'
    : (isSelfRemoval ? 'Участник покинул сообщество' : 'Участник удален'),
  body: ctx.action === 'BAN'
    ? manager.name + ' забанил ' + target.name + ' в сообществе.'
    : (isSelfRemoval
      ? target.name + ' покинул сообщество.'
      : manager.name + ' удалил ' + target.name + ' из сообщества.'),
  imageUrl: null,
  previewLabel: target.name,
  ctaLabel: null,
  relatedGameId: null,
  relatedTournamentId: null,
  author: {
    id: manager.id,
    phone: manager.phone,
    name: manager.name,
  },
  authorName: manager.name,
  publishedAt: nowIso,
  createdAt: nowIso,
  createdTs: nowTs,
  archived: false,
};

const eventDoc = {
  id: nextCommunity.id + ':event:' + nowTs + ':' + String(ctx.action || 'member').toLowerCase(),
  communityId: nextCommunity.id,
  type: ctx.action === 'BAN'
    ? 'MEMBER_BANNED'
    : (isSelfRemoval ? 'MEMBER_LEFT' : 'MEMBER_REMOVED'),
  actor: {
    id: manager.id,
    phone: manager.phone,
    name: manager.name,
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    targetId: target.id,
    targetPhone: target.phone,
    targetName: target.name,
    targetRole: target.role,
  },
};

const communityMsg = Object.assign({}, msg, {
  query: { id: nextCommunity.id, archived: { $ne: true } },
  payload: {
    $set: {
      members: nextMembers,
      memberCount: nextMembers.length,
      bannedMembers: nextBannedMembers,
      updatedAt: nowIso,
    },
  },
});

const rankingMsg = Object.assign({}, msg, {
  query: { communityId: nextCommunity.id },
  payload: {
    $set: {
      communityId: nextCommunity.id,
      rows: rankingRows,
      updatedAt: nowIso,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});

const feedMsg = Object.assign({}, msg, { payload: feedDoc });
const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  membershipStatus: isSelfRemoval ? null : 'ACTIVE',
  message: ctx.action === 'BAN'
    ? target.name + ' больше не сможет вступить в это сообщество'
    : (isSelfRemoval ? 'Вы покинули сообщество' : target.name + ' удален из сообщества'),
  community: normalizeCommunityForResponse(nextCommunity, { publicBaseUrl }),
  feedPost: feedDoc,
  ranking: {
    communityId: nextCommunity.id,
    updatedAt: nowIso,
    rows: rankingRows,
  },
});
return [communityMsg, rankingMsg, feedMsg, eventMsg, responseMsg, responseMsg];
`;

const fnFeedGetPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const limitRaw = Number(msg.req?.query?.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 40;
const beforeRaw = Number(msg.req?.query?.beforeTs ?? msg.req?.query?.before);
const beforeTs = Number.isFinite(beforeRaw) ? Math.trunc(beforeRaw) : Date.now() + 1;
msg._communityFeed = {
  communityId,
  clientId: toStr(msg.req?.query?.clientId),
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  limit,
  beforeTs,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedGetQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeed) ? msg._communityFeed : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const visibility = toVisibility(community.visibility);
const canAccess = visibility === 'OPEN'
  || toArray(community.members).some((item) => matchesIdentity(item, ctx.clientId, ctx.phone));

if (!canAccess) {
  const errorMsg = withJson(msg, 403, { error: 'Access denied' });
  return [null, errorMsg, errorMsg];
}

const beforeTs = Number.isFinite(Number(ctx.beforeTs)) ? Number(ctx.beforeTs) : Date.now() + 1;
msg._communityFeed = Object.assign({}, ctx, { communityId: toStr(community.id) || ctx.communityId, beforeTs });
msg.payload = {
  communityId: toStr(community.id),
  kind: { $in: ['PHOTO', 'GAME', 'TOURNAMENT'] },
  archived: { $ne: true },
  $or: [
    { createdTs: { $lt: beforeTs } },
    { createdTs: { $exists: false } },
    { createdTs: null },
  ],
};
return [msg, null, msg];
`;

const fnFeedCommentsQuery = `${commonHelpers}
const ctx = isObj(msg._communityFeed) ? msg._communityFeed : {};
const limit = Number.isFinite(Number(ctx.limit)) ? Number(ctx.limit) : toArray(msg.payload).length;
const beforeTs = Number.isFinite(Number(ctx.beforeTs)) ? Number(ctx.beforeTs) : Date.now() + 1;
const rows = toArray(msg.payload)
  .filter((item) => item && item.archived !== true)
  .map((item) => Object.assign({}, item, {
    createdTs: resolveCreatedTs(item),
  }))
  .filter((item) => resolveCreatedTs(item) < beforeTs)
  .sort((left, right) => resolveCreatedTs(right) - resolveCreatedTs(left));
const sliced = rows.slice(0, limit);
const hasMore = rows.length > sliced.length;
const nextBeforeTs = sliced.length > 0 ? resolveCreatedTs(sliced[sliced.length - 1]) : null;
const newsPostIds = sliced
  .filter((item) => isPhotoFeedPost(item))
  .map((item) => toStr(item.id))
  .filter(Boolean);

msg._communityFeed = Object.assign({}, ctx, {
  slicedPosts: sliced,
  totalFetched: sliced.length,
  hasMore,
  nextBeforeTs: Number.isFinite(nextBeforeTs) && nextBeforeTs > 0 ? nextBeforeTs : null,
  newsPostIds,
});
msg.payload = {
  communityId: ctx.communityId || null,
  postId: newsPostIds.length > 0 ? { $in: newsPostIds } : '__none__',
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedReactionsQuery = `${commonHelpers}
const ctx = isObj(msg._communityFeed) ? msg._communityFeed : {};
const newsPostIds = toArray(ctx.newsPostIds).map((item) => toStr(item)).filter(Boolean);
msg._communityFeed = Object.assign({}, ctx, {
  comments: toArray(msg.payload).filter((item) => item && item.archived !== true),
});
msg.payload = {
  communityId: ctx.communityId || null,
  postId: newsPostIds.length > 0 ? { $in: newsPostIds } : '__none__',
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedResponse = `${commonHelpers}
const ctx = isObj(msg._communityFeed) ? msg._communityFeed : {};
const slicedPosts = toArray(ctx.slicedPosts);
const comments = toArray(ctx.comments).filter((item) => item && item.archived !== true);
const reactions = toArray(msg.payload).filter((item) => item && item.archived !== true);

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = {
  communityId: ctx.communityId || null,
  totalFetched: Number.isFinite(Number(ctx.totalFetched)) ? Number(ctx.totalFetched) : slicedPosts.length,
  hasMore: Boolean(ctx.hasMore),
  nextBeforeTs: Number.isFinite(Number(ctx.nextBeforeTs)) ? Number(ctx.nextBeforeTs) : null,
  posts: slicedPosts.map((post) => {
    if (!isPhotoFeedPost(post)) return post;
    const snapshot = buildFeedThreadSnapshot({
      communityId: ctx.communityId,
      postId: post.id,
      comments: comments.filter((item) => toStr(item.postId || item.feedPostId) === toStr(post.id)),
      reactions: reactions.filter((item) => toStr(item.postId) === toStr(post.id)),
      clientId: ctx.clientId,
      phone: ctx.phone,
    });
    return Object.assign({}, post, {
      likesCount: snapshot.likesCount,
      dislikesCount: snapshot.dislikesCount,
      commentsCount: snapshot.commentsCount,
      viewerReaction: snapshot.viewerReaction,
    });
  }),
};
return [msg, msg];
`;

const fnFeedPostPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.actor || body.user, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

const kind = toStr(body.kind)?.toUpperCase();
if (kind !== 'PHOTO' && kind !== 'GAME' && kind !== 'TOURNAMENT') {
  const errorMsg = withJson(msg, 400, { error: 'kind must be PHOTO, GAME or TOURNAMENT' });
  return [null, errorMsg, errorMsg];
}

const title = toStr(body.title);
const postBody = toStr(body.body || body.text || body.description);
if (!title || !postBody) {
  const errorMsg = withJson(msg, 400, { error: 'title and body are required' });
  return [null, errorMsg, errorMsg];
}

msg._communityPost = {
  communityId,
  member,
  kind,
  title,
  body: postBody,
  imageUrl: toStr(body.imageUrl || body.image),
  previewLabel: toStr(body.previewLabel || body.preview),
  ctaLabel: toStr(body.ctaLabel || body.actionLabel),
  relatedGameId: toStr(body.relatedGameId || body.gameId),
  relatedTournamentId: resolvePostTournamentLinkId(body),
  details: isObj(body.details) ? body.details : null,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedPostApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityPost) ? msg._communityPost : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, errorMsg, errorMsg];
}

const community = rows[0];
const isAllowed = toArray(community.members).some((item) => matchesIdentity(item, ctx.member?.id, ctx.member?.phone));
if (!isAllowed) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can publish posts' });
  return [null, null, null, errorMsg, errorMsg];
}
const actorMember = findMemberByIdentity(community.members, ctx.member);
if (ctx.kind === 'TOURNAMENT' && !canCreateTournamentFeedPost(actorMember?.role)) {
  const errorMsg = withJson(msg, 403, { error: 'Tournament posts are only available to moderators and administrators' });
  return [null, null, null, errorMsg, errorMsg];
}

const postDoc = {
  id: toStr(ctx.communityId) + ':post:' + nowTs + ':' + String(ctx.kind || 'post').toLowerCase(),
  communityId: toStr(ctx.communityId),
  kind: ctx.kind,
  title: ctx.title,
  body: ctx.body,
  imageUrl: ctx.imageUrl || null,
  previewLabel: ctx.previewLabel || null,
  ctaLabel: ctx.ctaLabel || null,
  relatedGameId: ctx.relatedGameId || null,
  relatedTournamentId: resolvePostTournamentLinkId(ctx) || null,
  details: ctx.details || null,
  author: {
    id: ctx.member?.id || null,
    phone: ctx.member?.phone || null,
    name: ctx.member?.name || 'Игрок',
  },
  authorName: ctx.member?.name || 'Игрок',
  publishedAt: nowIso,
  createdAt: nowIso,
  createdTs: nowTs,
  archived: false,
};

const eventDoc = {
  id: toStr(ctx.communityId) + ':event:' + nowTs + ':feed',
  communityId: toStr(ctx.communityId),
  type: 'FEED_POST_CREATED',
  actor: {
    id: ctx.member?.id || null,
    phone: ctx.member?.phone || null,
    name: ctx.member?.name || 'Игрок',
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    postId: postDoc.id,
    kind: postDoc.kind,
  },
};

const communityUpdateMsg = Object.assign({}, msg, {
  query: { id: toStr(ctx.communityId), archived: { $ne: true } },
  payload: {
    $set: {
      updatedAt: nowIso,
      lastVisibleFeedActivityAt: nowIso,
      lastVisibleFeedActivityTs: nowTs,
    },
  },
});
const feedMsg = Object.assign({}, msg, { payload: postDoc });
const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  post: postDoc,
});
return [feedMsg, eventMsg, communityUpdateMsg, responseMsg, responseMsg];
`;

const fnFeedArchivePrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
const postId = toStr(msg.req?.params?.postId);
if (!communityId || !postId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId and postId are required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.actor || body.user, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedArchive = {
  communityId,
  postId,
  member,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedArchivePostQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedArchive) ? msg._communityFeedArchive : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const communityMember = members.find((item) => matchesIdentity(item, ctx.member?.id, ctx.member?.phone)) || null;
if (!communityMember) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can archive posts' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedArchive = Object.assign({}, ctx, {
  community,
  member: communityMember,
});
msg.payload = {
  id: ctx.postId,
  communityId: ctx.communityId,
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedArchiveApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedArchive) ? msg._communityFeedArchive : {};
const community = isObj(ctx.community) ? ctx.community : null;
const member = buildMember(ctx.member, 'MEMBER');

if (!community) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, null, errorMsg, errorMsg];
}

if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Feed post not found' });
  return [null, null, null, errorMsg, errorMsg];
}

const post = rows[0];
const isAuthor = matchesIdentity(post.author || {}, member.id, member.phone);
const canManage = canCreateTournamentFeedPost(member.role);
if (!isAuthor && !canManage) {
  const errorMsg = withJson(msg, 403, { error: 'You can archive only your own posts or moderate as admin' });
  return [null, null, null, errorMsg, errorMsg];
}

const archiveMsg = Object.assign({}, msg, {
  query: {
    id: ctx.postId,
    communityId: ctx.communityId,
    archived: { $ne: true },
  },
  payload: {
    $set: {
      archived: true,
      archivedAt: nowIso,
      archivedBy: {
        id: member.id,
        phone: member.phone,
        name: member.name,
      },
    },
  },
});

const remainingPostsMsg = Object.assign({}, msg, {
  _communityFeedArchive: Object.assign({}, ctx, { post }),
  payload: {
    id: { $ne: ctx.postId },
    communityId: ctx.communityId,
    kind: { $in: ['PHOTO', 'GAME', 'TOURNAMENT'] },
    archived: { $ne: true },
  },
});

const eventMsg = Object.assign({}, msg, {
  payload: {
    id: toStr(ctx.communityId) + ':event:' + nowTs + ':feed-archived',
    communityId: toStr(ctx.communityId),
    type: 'FEED_POST_ARCHIVED',
    actor: {
      id: member.id,
      phone: member.phone,
      name: member.name,
    },
    createdAt: nowIso,
    createdTs: nowTs,
    payload: {
      postId: toStr(ctx.postId),
      kind: toStr(post.kind || post.type),
    },
  },
});

const responseMsg = withJson(msg, 200, {
  ok: true,
  communityId: toStr(ctx.communityId),
  postId: toStr(ctx.postId),
  archived: true,
});

return [archiveMsg, remainingPostsMsg, eventMsg, responseMsg, responseMsg];
`;

const fnFeedArchiveCommunityUpdate = `${commonHelpers}
const ctx = isObj(msg._communityFeedArchive) ? msg._communityFeedArchive : {};
const communityId = toStr(ctx.communityId);
if (!communityId) {
  return [null, msg];
}

let latestPost = null;
let latestTs = 0;

toArray(msg.payload)
  .filter((item) => (
    item
    && item.archived !== true
    && toStr(item.communityId) === communityId
    && ['PHOTO', 'GAME', 'TOURNAMENT'].includes(toStr(item.kind || item.type)?.toUpperCase() || '')
  ))
  .forEach((item) => {
    const itemTs = resolveCreatedTs(item);
    if (itemTs <= latestTs) return;
    latestTs = itemTs;
    latestPost = item;
  });

const latestAt = latestPost
  ? (toStr(latestPost.publishedAt || latestPost.createdAt) || (latestTs > 0 ? new Date(latestTs).toISOString() : null))
  : null;

msg.query = {
  id: communityId,
  archived: { $ne: true },
};
msg.payload = {
  $set: {
    lastVisibleFeedActivityAt: latestAt,
    lastVisibleFeedActivityTs: latestTs > 0 ? latestTs : null,
  },
};
return [msg, msg];
`;

const fnFeedThreadPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
const postId = toStr(msg.req?.params?.postId);
if (!communityId || !postId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId and postId are required' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedThread = {
  communityId,
  postId,
  clientId: toStr(msg.req?.query?.clientId),
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedThreadPostQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedThread) ? msg._communityFeedThread : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const visibility = toVisibility(community.visibility);
const canAccess = visibility === 'OPEN'
  || toArray(community.members).some((item) => matchesIdentity(item, ctx.clientId, ctx.phone));

if (!canAccess) {
  const errorMsg = withJson(msg, 403, { error: 'Access denied' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedThread = Object.assign({}, ctx, {
  communityId: toStr(community.id) || ctx.communityId,
});
msg.payload = {
  id: ctx.postId,
  communityId: toStr(community.id),
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedThreadCommentsQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedThread) ? msg._communityFeedThread : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Feed post not found' });
  return [null, errorMsg, errorMsg];
}

const post = rows[0];
if (!isPhotoFeedPost(post)) {
  const errorMsg = withJson(msg, 400, { error: 'Comments are available only for news posts' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedThread = Object.assign({}, ctx, { post });
msg.payload = {
  communityId: ctx.communityId,
  postId: ctx.postId,
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedThreadReactionsQuery = `${commonHelpers}
const ctx = isObj(msg._communityFeedThread) ? msg._communityFeedThread : {};
msg._communityFeedThread = Object.assign({}, ctx, {
  comments: toArray(msg.payload).filter((item) => item && item.archived !== true),
});
msg.payload = {
  communityId: ctx.communityId,
  postId: ctx.postId,
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedThreadResponse = `${commonHelpers}
const ctx = isObj(msg._communityFeedThread) ? msg._communityFeedThread : {};
const snapshot = buildFeedThreadSnapshot({
  communityId: ctx.communityId,
  postId: ctx.postId,
  comments: ctx.comments,
  reactions: msg.payload,
  clientId: ctx.clientId,
  phone: ctx.phone,
});

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = Object.assign({ ok: true }, snapshot);
return [msg, msg];
`;

const fnFeedCommentPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
const postId = toStr(msg.req?.params?.postId);
if (!communityId || !postId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId and postId are required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.actor || body.user, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

const text = toStr(body.text || body.body || body.message);
if (!text) {
  const errorMsg = withJson(msg, 400, { error: 'text is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedComment = {
  communityId,
  postId,
  member,
  text,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedCommentPostQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedComment) ? msg._communityFeedComment : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const communityMember = members.find((item) => matchesIdentity(item, ctx.member?.id, ctx.member?.phone)) || null;
if (!communityMember) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can comment on news' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedComment = Object.assign({}, ctx, { member: communityMember });
msg.payload = {
  id: ctx.postId,
  communityId: ctx.communityId,
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedCommentApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedComment) ? msg._communityFeedComment : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Feed post not found' });
  return [null, null, errorMsg, errorMsg];
}

const post = rows[0];
if (!isPhotoFeedPost(post)) {
  const errorMsg = withJson(msg, 400, { error: 'Comments are available only for news posts' });
  return [null, null, errorMsg, errorMsg];
}

const commentDoc = {
  id: toStr(ctx.communityId) + ':comment:' + toStr(ctx.postId) + ':' + nowTs + ':' + Math.random().toString(36).slice(2, 8),
  communityId: toStr(ctx.communityId),
  postId: toStr(ctx.postId),
  text: ctx.text,
  createdAt: nowIso,
  createdTs: nowTs,
  authorId: ctx.member?.id || null,
  authorPhone: ctx.member?.phone || null,
  authorName: ctx.member?.name || 'Игрок',
  authorAvatar: ctx.member?.avatar || null,
  author: {
    id: ctx.member?.id || null,
    phone: ctx.member?.phone || null,
    name: ctx.member?.name || 'Игрок',
    avatar: ctx.member?.avatar || null,
    role: ctx.member?.role || 'MEMBER',
    levelScore: Number.isFinite(Number(ctx.member?.levelScore)) ? Number(ctx.member.levelScore) : 3.2,
    levelLabel: ctx.member?.levelLabel || 'C',
  },
  archived: false,
};

const eventDoc = {
  id: toStr(ctx.communityId) + ':event:' + nowTs + ':comment',
  communityId: toStr(ctx.communityId),
  type: 'FEED_POST_COMMENT_CREATED',
  actor: {
    id: ctx.member?.id || null,
    phone: ctx.member?.phone || null,
    name: ctx.member?.name || 'Игрок',
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    postId: toStr(ctx.postId),
    commentId: commentDoc.id,
    textPreview: String(ctx.text || '').slice(0, 120),
  },
};

const commentMsg = Object.assign({}, msg, { payload: commentDoc });
const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  comment: normalizeFeedCommentForResponse(commentDoc),
});
return [commentMsg, eventMsg, responseMsg, responseMsg];
`;

const fnFeedReactionPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
const postId = toStr(msg.req?.params?.postId);
if (!communityId || !postId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId and postId are required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.actor || body.user, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

const hasReactionValue = Object.prototype.hasOwnProperty.call(body, 'reaction')
  || Object.prototype.hasOwnProperty.call(body, 'value')
  || Object.prototype.hasOwnProperty.call(body, 'kind');
if (!hasReactionValue) {
  const errorMsg = withJson(msg, 400, { error: 'reaction is required' });
  return [null, errorMsg, errorMsg];
}

const rawReaction = Object.prototype.hasOwnProperty.call(body, 'reaction')
  ? body.reaction
  : (Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : body.kind);
const reaction = toReaction(rawReaction);
const normalizedRawReaction = toStr(rawReaction);
if (normalizedRawReaction && !reaction) {
  const errorMsg = withJson(msg, 400, { error: 'reaction must be LIKE, DISLIKE or null' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedReaction = {
  communityId,
  postId,
  member,
  reaction,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnFeedReactionPostQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedReaction) ? msg._communityFeedReaction : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const communityMember = members.find((item) => matchesIdentity(item, ctx.member?.id, ctx.member?.phone)) || null;
if (!communityMember) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can react to news' });
  return [null, errorMsg, errorMsg];
}

msg._communityFeedReaction = Object.assign({}, ctx, { member: communityMember });
msg.payload = {
  id: ctx.postId,
  communityId: ctx.communityId,
  archived: { $ne: true },
};
return [msg, null, msg];
`;

const fnFeedReactionLookupQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedReaction) ? msg._communityFeedReaction : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Feed post not found' });
  return [null, errorMsg, errorMsg];
}

const post = rows[0];
if (!isPhotoFeedPost(post)) {
  const errorMsg = withJson(msg, 400, { error: 'Reactions are available only for news posts' });
  return [null, errorMsg, errorMsg];
}

const reactionDocId = buildFeedReactionDocId(ctx.communityId, ctx.postId, ctx.member);
msg._communityFeedReaction = Object.assign({}, ctx, {
  post,
  reactionDocId,
});
msg.payload = { id: reactionDocId };
return [msg, null, msg];
`;

const fnFeedReactionApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityFeedReaction) ? msg._communityFeedReaction : {};
const existing = rows.length > 0 && isObj(rows[0]) ? rows[0] : null;
const reactionDocId = toStr(ctx.reactionDocId) || buildFeedReactionDocId(ctx.communityId, ctx.postId, ctx.member);
const previousReaction = toReaction(existing?.reaction || existing?.value || existing?.kind);
const nextReaction = toReaction(ctx.reaction);
const currentLikesCount = Math.max(0, toNum(
  ctx.post?.likesCount
  ?? ctx.post?.likes
  ?? ctx.post?.positiveReactions
  ?? ctx.post?.goodCount
) ?? 0);
const currentDislikesCount = Math.max(0, toNum(
  ctx.post?.dislikesCount
  ?? ctx.post?.dislikes
  ?? ctx.post?.negativeReactions
  ?? ctx.post?.badCount
) ?? 0);
const likeDelta = (nextReaction === 'LIKE' ? 1 : 0) - (previousReaction === 'LIKE' ? 1 : 0);
const dislikeDelta = (nextReaction === 'DISLIKE' ? 1 : 0) - (previousReaction === 'DISLIKE' ? 1 : 0);
const nextLikesCount = Math.max(0, currentLikesCount + likeDelta);
const nextDislikesCount = Math.max(0, currentDislikesCount + dislikeDelta);

const reactionMsg = nextReaction
  ? Object.assign({}, msg, {
      query: { id: reactionDocId },
      payload: {
        $set: {
          id: reactionDocId,
          communityId: toStr(ctx.communityId),
          postId: toStr(ctx.postId),
          reaction: nextReaction,
          actor: {
            id: ctx.member?.id || null,
            phone: ctx.member?.phone || null,
            name: ctx.member?.name || 'Игрок',
          },
          updatedAt: nowIso,
          updatedTs: nowTs,
          archived: false,
        },
        $setOnInsert: {
          createdAt: nowIso,
          createdTs: nowTs,
        },
      },
    })
  : (existing
      ? Object.assign({}, msg, {
          query: { id: reactionDocId },
          payload: {
            $set: {
              reaction: null,
              archived: true,
              updatedAt: nowIso,
              updatedTs: nowTs,
            },
          },
        })
      : null);

const postUpdatePayload = {
  $set: {
    updatedAt: nowIso,
    updatedTs: nowTs,
  },
};
if (likeDelta !== 0 || dislikeDelta !== 0) {
  postUpdatePayload.$inc = {
    likesCount: likeDelta,
    dislikesCount: dislikeDelta,
  };
}

const postUpdateMsg = Object.assign({}, msg, {
  query: {
    id: toStr(ctx.postId),
    communityId: toStr(ctx.communityId),
  },
  payload: postUpdatePayload,
});

const eventDoc = {
  id: toStr(ctx.communityId) + ':event:' + nowTs + ':reaction',
  communityId: toStr(ctx.communityId),
  type: nextReaction ? 'FEED_POST_REACTION_SET' : 'FEED_POST_REACTION_CLEARED',
  actor: {
    id: ctx.member?.id || null,
    phone: ctx.member?.phone || null,
    name: ctx.member?.name || 'Игрок',
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    postId: toStr(ctx.postId),
    reaction: nextReaction,
    previousReaction,
  },
};

const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  reaction: nextReaction,
  likesCount: nextLikesCount,
  dislikesCount: nextDislikesCount,
});
return [reactionMsg, postUpdateMsg, eventMsg, responseMsg, responseMsg];
`;

const fnChatGetPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const limitRaw = Number(msg.req?.query?.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 15;
const beforeRaw = Number(msg.req?.query?.beforeTs ?? msg.req?.query?.before);
const beforeTs = Number.isFinite(beforeRaw) ? Math.trunc(beforeRaw) : Date.now() + 1;
msg._communityChat = {
  communityId,
  clientId: toStr(msg.req?.query?.clientId),
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  limit,
  beforeTs,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnChatGetQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityChat) ? msg._communityChat : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const visibility = toVisibility(community.visibility);
const canAccess = visibility === 'OPEN'
  || toArray(community.members).some((item) => matchesIdentity(item, ctx.clientId, ctx.phone));

if (!canAccess) {
  const errorMsg = withJson(msg, 403, { error: 'Access denied' });
  return [null, errorMsg, errorMsg];
}

const beforeTs = Number.isFinite(Number(ctx.beforeTs)) ? Number(ctx.beforeTs) : Date.now() + 1;
msg._communityChat = Object.assign({}, ctx, {
  communityId: toStr(community.id) || ctx.communityId,
  beforeTs,
});
msg.payload = {
  communityId: toStr(community.id),
  archived: { $ne: true },
  $or: [
    { createdTs: { $lt: beforeTs } },
    { createdTs: { $exists: false } },
    { createdTs: null },
  ],
};
return [msg, null, msg];
`;

const fnChatGetResponse = `${commonHelpers}
const ctx = isObj(msg._communityChat) ? msg._communityChat : {};
const limit = Number.isFinite(Number(ctx.limit)) ? Number(ctx.limit) : toArray(msg.payload).length;
const beforeTs = Number.isFinite(Number(ctx.beforeTs)) ? Number(ctx.beforeTs) : Date.now() + 1;
const rows = toArray(msg.payload)
  .filter((item) => item && item.archived !== true)
  .map((item) => {
    const createdTs = resolveCreatedTs(item);
    const createdAt = toStr(item.createdAt) || toStr(item.publishedAt) || nowIso;
    const text = toStr(item.text || item.body || item.message);
    return {
      id: toStr(item.id || item.messageId) || null,
      communityId: toStr(item.communityId) || ctx.communityId || null,
      text,
      createdAt,
      createdTs,
      authorId: toStr(item.authorId || item.author?.id || item.sender?.id),
      authorPhone: normPhone(
        item.authorPhone
        || item.author?.phone
        || item.author?.phoneNorm
        || item.sender?.phone
        || item.sender?.phoneNorm,
      ),
      authorName: toStr(item.authorName || item.author?.name || item.sender?.name) || 'Игрок',
      authorAvatar: toStr(
        item.authorAvatar
        || item.author?.avatar
        || item.author?.photo
        || item.author?.imageUrl
        || item.sender?.avatar
        || item.sender?.photo
        || item.sender?.imageUrl,
      ),
    };
  })
  .filter((item) => item.id && item.communityId && item.text && item.createdTs < beforeTs)
  .sort((left, right) => left.createdTs - right.createdTs);
const sliced = rows.slice(Math.max(0, rows.length - limit));
const hasMore = rows.length > sliced.length;
const nextBeforeTs = sliced.length > 0 ? Number(sliced[0].createdTs || 0) : null;

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = {
  communityId: ctx.communityId || null,
  totalFetched: sliced.length,
  hasMore,
  nextBeforeTs: Number.isFinite(nextBeforeTs) && nextBeforeTs > 0 ? nextBeforeTs : null,
  messages: sliced,
};
return [msg, msg];
`;

const fnChatPostPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const member = buildMember(body.member || body.actor || body.user, 'MEMBER');
if (!member.id && !member.phone) {
  const errorMsg = withJson(msg, 400, { error: 'member id or phone is required' });
  return [null, errorMsg, errorMsg];
}

const text = toStr(body.text || body.body || body.message);
if (!text) {
  const errorMsg = withJson(msg, 400, { error: 'text is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityChatPost = {
  communityId,
  member,
  text,
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnChatPostApply = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityChatPost) ? msg._communityChatPost : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, null, errorMsg, errorMsg];
}

const community = rows[0];
const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));
const communityMember = members.find((item) => matchesIdentity(item, ctx.member?.id, ctx.member?.phone)) || null;
if (!communityMember) {
  const errorMsg = withJson(msg, 403, { error: 'Only community members can write to chat' });
  return [null, null, errorMsg, errorMsg];
}

const messageDoc = {
  id: toStr(ctx.communityId) + ':message:' + nowTs + ':' + Math.random().toString(36).slice(2, 8),
  communityId: toStr(ctx.communityId),
  text: ctx.text,
  createdAt: nowIso,
  createdTs: nowTs,
  authorId: communityMember.id || null,
  authorPhone: communityMember.phone || null,
  authorName: communityMember.name || 'Игрок',
  authorAvatar: communityMember.avatar || null,
  author: {
    id: communityMember.id || null,
    phone: communityMember.phone || null,
    name: communityMember.name || 'Игрок',
    avatar: communityMember.avatar || null,
    role: communityMember.role || 'MEMBER',
    levelScore: Number.isFinite(Number(communityMember.levelScore)) ? Number(communityMember.levelScore) : 3.2,
    levelLabel: communityMember.levelLabel || 'C',
  },
  archived: false,
};

const eventDoc = {
  id: toStr(ctx.communityId) + ':event:' + nowTs + ':chat',
  communityId: toStr(ctx.communityId),
  type: 'CHAT_MESSAGE_CREATED',
  actor: {
    id: communityMember.id || null,
    phone: communityMember.phone || null,
    name: communityMember.name || 'Игрок',
  },
  createdAt: nowIso,
  createdTs: nowTs,
  payload: {
    messageId: messageDoc.id,
    textPreview: String(ctx.text || '').slice(0, 120),
  },
};

const chatMsg = Object.assign({}, msg, { payload: messageDoc });
const eventMsg = Object.assign({}, msg, { payload: eventDoc });
const responseMsg = withJson(msg, 200, {
  ok: true,
  message: messageDoc,
});
return [chatMsg, eventMsg, responseMsg, responseMsg];
`;

const fnRankingPrepare = `${commonHelpers}
const communityId = toStr(msg.req?.params?.communityId);
if (!communityId) {
  const errorMsg = withJson(msg, 400, { error: 'communityId is required' });
  return [null, errorMsg, errorMsg];
}

msg._communityRatingCtx = {
  communityId,
  clientId: toStr(msg.req?.query?.clientId),
  phone: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  tab: normalizeRatingTab(msg.req?.query?.tab),
  period: normalizeRatingPeriod(msg.req?.query?.period),
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null, msg];
`;

const fnRankingQuery = `${commonHelpers}
const rows = toArray(msg.payload);
const ctx = isObj(msg._communityRatingCtx) ? msg._communityRatingCtx : {};
if (rows.length === 0) {
  const errorMsg = withJson(msg, 404, { error: 'Community not found' });
  return [null, errorMsg, errorMsg];
}

const community = rows[0];
const visibility = toVisibility(community.visibility);
const canAccess = visibility === 'OPEN'
  || toArray(community.members).some((item) => matchesIdentity(item, ctx.clientId, ctx.phone));

if (!canAccess) {
  const errorMsg = withJson(msg, 403, { error: 'Access denied' });
  return [null, errorMsg, errorMsg];
}

msg._communityRatingCtx = Object.assign({}, ctx, {
  community,
  communityId: toStr(community.id) || ctx.communityId,
});
msg.payload = {
  communityId: toStr(community.id),
  tab: normalizeRatingTab(ctx.tab),
  period: normalizeRatingPeriod(ctx.period),
  calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
};
return [msg, null, msg];
`;

const fnRankingSnapshotResponse = `${commonHelpers}
const ctx = isObj(msg._communityRatingCtx) ? msg._communityRatingCtx : {};
const snapshots = toArray(msg.payload).filter((item) => isObj(item));
const snapshot = snapshots[0] || null;

if (snapshot && (Array.isArray(snapshot.rows) || Array.isArray(snapshot.items))) {
  const snapshotRows = toArray(snapshot.rows || snapshot.items)
    .map((row, index) => {
      if (!isObj(row)) return null;
      const rank = toNum(row.rank);
      return Object.assign({}, row, {
        rank: Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : index + 1,
      });
    })
    .filter(Boolean);

  msg.statusCode = 200;
  msg.headers = jsonHeaders;
  msg.payload = {
    communityId: ctx.communityId || snapshot.communityId || null,
    tab: normalizeRatingTab(snapshot.tab || ctx.tab),
    period: normalizeRatingPeriod(snapshot.period || ctx.period),
    updatedAt: toStr(snapshot.updatedAt) || nowIso,
    dataThrough: toStr(snapshot.dataThrough),
    sourceVersion: toStr(snapshot.sourceVersion) || 'rating_events+player_rating_state+attendance-v1',
    degraded: false,
    calculationVersion: toStr(snapshot.calculationVersion) || COMMUNITY_RATING_CALCULATION_VERSION,
    items: snapshotRows,
    rows: snapshotRows,
  };
  return [msg, null, msg];
}

const errorMsg = withJson(msg, 503, {
  error: 'RATING_SNAPSHOT_NOT_READY',
  communityId: ctx.communityId || null,
  tab: normalizeRatingTab(ctx.tab),
  period: normalizeRatingPeriod(ctx.period),
  calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  degraded: true,
});
return [errorMsg, null, errorMsg];
`;

const fnRankingFeedQuery = `${commonHelpers}
const ctx = isObj(msg._communityRatingCtx) ? msg._communityRatingCtx : {};
const feedRows = toArray(msg.payload).filter((item) => item && item.archived !== true);
const gameIds = uniq(feedRows
  .filter((item) => toStr(item.kind || item.type)?.toUpperCase() === 'GAME')
  .map((item) => toStr(item.relatedGameId || item.gameId)));
const tournamentIds = uniq(feedRows
  .filter((item) => toStr(item.kind || item.type)?.toUpperCase() === 'TOURNAMENT')
  .map((item) => resolvePostTournamentLinkId(item)));

msg._communityRatingCtx = Object.assign({}, ctx, {
  feedRows,
  gameIds,
  tournamentIds,
});
msg.payload = gameIds.length > 0
  ? {
    $or: [
      { id: { $in: gameIds } },
      { gameId: { $in: gameIds } },
    ],
    archived: { $ne: true },
  }
  : { id: '__none__' };
return [msg, msg];
`;

const fnRankingTournamentsQuery = `${commonHelpers}
const ctx = isObj(msg._communityRatingCtx) ? msg._communityRatingCtx : {};
const gamesRows = toArray(msg.payload).filter((item) => item && item.archived !== true);
const tournamentIds = toArray(ctx.tournamentIds).map((item) => toStr(item)).filter(Boolean);

msg._communityRatingCtx = Object.assign({}, ctx, { gamesRows });
msg.payload = tournamentIds.length > 0
  ? {
    $or: [
      { tournamentId: { $in: tournamentIds } },
      { id: { $in: tournamentIds } },
      { exerciseId: { $in: tournamentIds } },
      { sourceTournamentId: { $in: tournamentIds } },
    ],
    archived: { $ne: true },
  }
  : { tournamentId: '__none__' };
return [msg, msg];
`;

const fnRankingResponse = `${commonHelpers}
const ctx = isObj(msg._communityRatingCtx) ? msg._communityRatingCtx : {};
const tournamentsRows = toArray(msg.payload).filter((item) => item && item.archived !== true);
const items = calculateCommunityRatingItems({
  community: ctx.community || {},
  feedPosts: ctx.feedRows || [],
  games: ctx.gamesRows || [],
  tournaments: tournamentsRows,
  period: normalizeRatingPeriod(ctx.period),
  tab: normalizeRatingTab(ctx.tab),
});

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = {
  communityId: ctx.communityId || null,
  tab: normalizeRatingTab(ctx.tab),
  period: normalizeRatingPeriod(ctx.period),
  updatedAt: nowIso,
  calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  items,
  rows: items,
};
return [msg, msg];
`;

function commentNode(id, name, info, x, y) {
  return {
    id,
    type: 'comment',
    z: tabId,
    name,
    info,
    x,
    y,
    wires: [],
  };
}

function httpInNode(id, name, url, method, x, y, nextId) {
  return {
    id,
    type: 'http in',
    z: tabId,
    name,
    url,
    method,
    upload: false,
    swaggerDoc: '',
    x,
    y,
    wires: [[nextId]],
  };
}

function functionNode(id, name, func, outputs, x, y, wires) {
  return {
    id,
    type: 'function',
    z: tabId,
    name,
    func,
    outputs,
    timeout: '',
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x,
    y,
    wires,
  };
}

function mongoInNode(id, name, collection, x, y, nextId) {
  return {
    id,
    type: 'mongodb in',
    z: tabId,
    mongodb: 'mongo_lk',
    name,
    collection,
    operation: 'find',
    x,
    y,
    wires: [[nextId]],
  };
}

function mongoOutNode(id, name, collection, operation, upsert, x, y) {
  return {
    id,
    type: 'mongodb out',
    z: tabId,
    mongodb: 'mongo_lk',
    name,
    collection,
    payonly: false,
    upsert,
    multi: false,
    operation,
    x,
    y,
    wires: [],
  };
}

function httpResponseNode(id, x, y) {
  return {
    id,
    type: 'http response',
    z: tabId,
    name: '',
    x,
    y,
    wires: [],
  };
}

function debugNode(id, name, x, y) {
  return {
    id,
    type: 'debug',
    z: tabId,
    name,
    active: false,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    statusVal: '',
    statusType: 'auto',
    x,
    y,
    wires: [],
  };
}

const nodes = [
  commentNode(
    'community_comment_001',
    'LK communities (communities/feed/ranking/events)',
    'Community graph, invite-only access, feed, ranking snapshots and audit events stored in Mongo.',
    320,
    4140,
  ),

  httpInNode('community_logo_upload_in_001', 'LK community logo upload', '/lk/media/community-logo', 'post', 140, 4020, 'community_logo_upload_fn_001'),
  functionNode(
    'community_logo_upload_fn_001',
    'Store community logo asset',
    fnMediaUpload,
    3,
    430,
    4020,
    [['community_logo_upload_insert_001'], ['community_logo_upload_http_resp_001'], ['community_logo_upload_debug_001']],
  ),
  mongoOutNode('community_logo_upload_insert_001', 'Insert community logo asset', 'lk_media_assets', 'insert', false, 760, 3980),
  httpResponseNode('community_logo_upload_http_resp_001', 760, 4020),
  debugNode('community_logo_upload_debug_001', 'community logo upload debug', 760, 4060),

  httpInNode('community_logo_asset_in_001', 'LK community logo asset', '/lk/media/community-logo/:assetId', 'get', 140, 4100, 'community_logo_asset_fn_prepare_001'),
  functionNode(
    'community_logo_asset_fn_prepare_001',
    'Prepare community logo asset query',
    fnMediaAssetGetPrepare,
    3,
    430,
    4100,
    [['community_logo_asset_find_001'], ['community_logo_asset_http_resp_001'], ['community_logo_asset_debug_001']],
  ),
  mongoInNode('community_logo_asset_find_001', 'Find community logo asset', 'lk_media_assets', 760, 4060, 'community_logo_asset_fn_response_001'),
  functionNode(
    'community_logo_asset_fn_response_001',
    'Build community logo asset response',
    fnMediaAssetGetResponse,
    2,
    1040,
    4060,
    [['community_logo_asset_http_resp_001'], ['community_logo_asset_debug_001']],
  ),
  httpResponseNode('community_logo_asset_http_resp_001', 1320, 4100),
  debugNode('community_logo_asset_debug_001', 'community logo asset debug', 1310, 4140),

  httpInNode('community_logo_thumb_in_001', 'LK community logo thumb', '/lk/media/community-logo/:assetId/thumb', 'get', 140, 4180, 'community_logo_thumb_fn_prepare_001'),
  functionNode(
    'community_logo_thumb_fn_prepare_001',
    'Prepare community logo thumb query',
    fnMediaAssetGetPrepare,
    3,
    430,
    4180,
    [['community_logo_thumb_find_001'], ['community_logo_thumb_http_resp_001'], ['community_logo_thumb_debug_001']],
  ),
  mongoInNode('community_logo_thumb_find_001', 'Find community logo thumb asset', 'lk_media_assets', 760, 4140, 'community_logo_thumb_fn_response_001'),
  functionNode(
    'community_logo_thumb_fn_response_001',
    'Build community logo thumb response',
    fnMediaAssetGetResponse,
    2,
    1040,
    4140,
    [['community_logo_thumb_http_resp_001'], ['community_logo_thumb_debug_001']],
  ),
  httpResponseNode('community_logo_thumb_http_resp_001', 1320, 4180),
  debugNode('community_logo_thumb_debug_001', 'community logo thumb debug', 1310, 4220),

  httpInNode('community_logo_legacy_in_001', 'LK community legacy logo', '/lk/media/community-logo-legacy/:communityId', 'get', 140, 4260, 'community_logo_legacy_fn_prepare_001'),
  functionNode(
    'community_logo_legacy_fn_prepare_001',
    'Prepare legacy community logo query',
    fnMediaLegacyGetPrepare,
    3,
    430,
    4260,
    [['community_logo_legacy_find_001'], ['community_logo_legacy_http_resp_001'], ['community_logo_legacy_debug_001']],
  ),
  mongoInNode('community_logo_legacy_find_001', 'Find community for legacy logo', 'lk_communities', 760, 4220, 'community_logo_legacy_fn_response_001'),
  functionNode(
    'community_logo_legacy_fn_response_001',
    'Build legacy community logo response',
    fnMediaLegacyGetResponse,
    2,
    1040,
    4220,
    [['community_logo_legacy_http_resp_001'], ['community_logo_legacy_debug_001']],
  ),
  httpResponseNode('community_logo_legacy_http_resp_001', 1320, 4260),
  debugNode('community_logo_legacy_debug_001', 'community legacy logo debug', 1310, 4300),

  httpInNode('community_logo_legacy_thumb_in_001', 'LK community legacy logo thumb', '/lk/media/community-logo-legacy/:communityId/thumb', 'get', 140, 4340, 'community_logo_legacy_thumb_fn_prepare_001'),
  functionNode(
    'community_logo_legacy_thumb_fn_prepare_001',
    'Prepare legacy community logo thumb query',
    fnMediaLegacyGetPrepare,
    3,
    430,
    4340,
    [['community_logo_legacy_thumb_find_001'], ['community_logo_legacy_thumb_http_resp_001'], ['community_logo_legacy_thumb_debug_001']],
  ),
  mongoInNode('community_logo_legacy_thumb_find_001', 'Find community for legacy logo thumb', 'lk_communities', 760, 4300, 'community_logo_legacy_thumb_fn_response_001'),
  functionNode(
    'community_logo_legacy_thumb_fn_response_001',
    'Build legacy community logo thumb response',
    fnMediaLegacyGetResponse,
    2,
    1040,
    4300,
    [['community_logo_legacy_thumb_http_resp_001'], ['community_logo_legacy_thumb_debug_001']],
  ),
  httpResponseNode('community_logo_legacy_thumb_http_resp_001', 1320, 4340),
  debugNode('community_logo_legacy_thumb_debug_001', 'community legacy logo thumb debug', 1310, 4380),

  httpInNode('community_list_in_001', 'LK communities list', '/lk/communities', 'get', 140, 4180, 'community_list_fn_prepare_001'),
  functionNode(
    'community_list_fn_prepare_001',
    'Prepare communities list query',
    fnListPrepare,
    3,
    410,
    4180,
    [['community_list_find_001'], ['community_list_http_resp_001'], ['community_list_debug_001']],
  ),
  mongoInNode('community_list_find_001', 'Find communities', 'lk_communities', 700, 4140, 'community_list_fn_response_001'),
  functionNode(
    'community_list_fn_response_001',
    'Build communities list response',
    fnListResponse,
    2,
    980,
    4140,
    [['community_list_http_resp_001'], ['community_list_debug_001']],
  ),
  httpResponseNode('community_list_http_resp_001', 1260, 4180),
  debugNode('community_list_debug_001', 'communities list debug', 1250, 4220),

  httpInNode('community_get_in_001', 'LK community get', '/lk/communities/:communityId', 'get', 140, 4360, 'community_get_fn_prepare_001'),
  functionNode(
    'community_get_fn_prepare_001',
    'Prepare community get query',
    fnGetPrepare,
    3,
    410,
    4360,
    [['community_get_find_001'], ['community_get_http_resp_001'], ['community_get_debug_001']],
  ),
  mongoInNode('community_get_find_001', 'Find community by id', 'lk_communities', 700, 4320, 'community_get_fn_response_001'),
  functionNode(
    'community_get_fn_response_001',
    'Build community get response',
    fnGetResponse,
    2,
    980,
    4320,
    [['community_get_http_resp_001'], ['community_get_debug_001']],
  ),
  httpResponseNode('community_get_http_resp_001', 1260, 4360),
  debugNode('community_get_debug_001', 'community get debug', 1250, 4400),

  httpInNode('community_create_in_001', 'LK community create', '/lk/communities', 'post', 140, 4280, 'community_create_fn_prepare_001'),
  functionNode(
    'community_create_fn_prepare_001',
    'Build community create docs',
    fnCreate,
    6,
    420,
    4280,
    [
      ['community_create_upsert_001'],
      ['community_create_feed_insert_001'],
      ['community_create_ranking_upsert_001'],
      ['community_create_event_insert_001'],
      ['community_create_http_resp_001'],
      ['community_create_debug_001'],
    ],
  ),
  mongoOutNode('community_create_upsert_001', 'Upsert community', 'lk_communities', 'update', true, 760, 4220),
  mongoOutNode('community_create_feed_insert_001', 'Insert community feed post', 'lk_community_feed', 'insert', false, 760, 4260),
  mongoOutNode('community_create_ranking_upsert_001', 'Upsert community ranking', 'lk_community_rankings', 'update', true, 770, 4300),
  mongoOutNode('community_create_event_insert_001', 'Insert community event', 'lk_community_events', 'insert', false, 750, 4340),
  httpResponseNode('community_create_http_resp_001', 760, 4380),
  debugNode('community_create_debug_001', 'community create debug', 760, 4420),

  httpInNode('community_update_in_001', 'LK community update', '/lk/communities/:communityId', 'patch', 140, 4440, 'community_update_fn_prepare_001'),
  functionNode(
    'community_update_fn_prepare_001',
    'Prepare community update',
    fnUpdatePrepare,
    3,
    400,
    4440,
    [['community_update_find_001'], ['community_update_http_resp_001'], ['community_update_debug_001']],
  ),
  mongoInNode('community_update_find_001', 'Find community for update', 'lk_communities', 700, 4400, 'community_update_fn_apply_001'),
  functionNode(
    'community_update_fn_apply_001',
    'Apply community update',
    fnUpdateApply,
    4,
    990,
    4400,
    [
      ['community_update_save_001'],
      ['community_update_event_insert_001'],
      ['community_update_http_resp_001'],
      ['community_update_debug_001'],
    ],
  ),
  mongoOutNode('community_update_save_001', 'Update community settings', 'lk_communities', 'update', false, 1280, 4360),
  mongoOutNode('community_update_event_insert_001', 'Insert community update event', 'lk_community_events', 'insert', false, 1280, 4400),
  httpResponseNode('community_update_http_resp_001', 1280, 4440),
  debugNode('community_update_debug_001', 'community update debug', 1270, 4480),

  httpInNode('community_join_in_001', 'LK community join', '/lk/communities/:communityId/join', 'post', 140, 4520, 'community_join_fn_prepare_001'),
  httpInNode('community_add_member_in_001', 'LK community add member', '/lk/communities/:communityId/add-member', 'post', 140, 4560, 'community_join_fn_prepare_001'),
  functionNode(
    'community_join_fn_prepare_001',
    'Prepare community join',
    fnJoinPrepare,
    3,
    390,
    4520,
    [['community_join_find_001'], ['community_join_http_resp_001'], ['community_join_debug_001']],
  ),
  functionNode(
    'community_join_fn_games_query_001',
    'Build member games query',
    fnJoinGamesQuery,
    3,
    970,
    4480,
    [['community_join_fn_apply_001'], ['community_join_http_resp_001'], ['community_join_debug_001']],
  ),
  mongoInNode('community_join_find_games_001', 'Find member games for stats', 'lk_games', 1260, 4440, 'community_join_fn_apply_001'),
  functionNode(
    'community_join_fn_apply_001',
    'Apply community join',
    fnJoinApply,
    6,
    1540,
    4480,
    [
      ['community_join_update_001'],
      ['community_join_ranking_upsert_001'],
      ['community_join_feed_insert_001'],
      ['community_join_event_insert_001'],
      ['community_join_http_resp_001'],
      ['community_join_debug_001'],
    ],
  ),
  mongoInNode('community_join_find_001', 'Find community for join', 'lk_communities', 690, 4480, 'community_join_fn_games_query_001'),
  mongoOutNode('community_join_update_001', 'Update community members', 'lk_communities', 'update', false, 1840, 4400),
  mongoOutNode('community_join_ranking_upsert_001', 'Upsert join ranking', 'lk_community_rankings', 'update', true, 1840, 4440),
  mongoOutNode('community_join_feed_insert_001', 'Insert join feed post', 'lk_community_feed', 'insert', false, 1840, 4480),
  mongoOutNode('community_join_event_insert_001', 'Insert join event', 'lk_community_events', 'insert', false, 1840, 4520),
  httpResponseNode('community_join_http_resp_001', 1840, 4560),
  debugNode('community_join_debug_001', 'community join debug', 1840, 4600),

  httpInNode('community_invite_in_001', 'LK community join by invite', '/lk/communities/join-by-invite', 'post', 150, 4700, 'community_invite_fn_prepare_001'),
  functionNode(
    'community_invite_fn_prepare_001',
    'Prepare invite join',
    fnInvitePrepare,
    3,
    400,
    4700,
    [['community_invite_find_001'], ['community_invite_http_resp_001'], ['community_invite_debug_001']],
  ),
  mongoInNode('community_invite_find_001', 'Find community by invite', 'lk_communities', 700, 4660, 'community_invite_fn_games_query_001'),
  functionNode(
    'community_invite_fn_games_query_001',
    'Build invited member games query',
    fnJoinGamesQuery,
    3,
    980,
    4660,
    [['community_invite_fn_apply_001'], ['community_invite_http_resp_001'], ['community_invite_debug_001']],
  ),
  mongoInNode('community_invite_find_games_001', 'Find invited member games for stats', 'lk_games', 1270, 4620, 'community_invite_fn_apply_001'),
  functionNode(
    'community_invite_fn_apply_001',
    'Apply invite join',
    fnJoinApply,
    6,
    1550,
    4660,
    [
      ['community_invite_update_001'],
      ['community_invite_ranking_upsert_001'],
      ['community_invite_feed_insert_001'],
      ['community_invite_event_insert_001'],
      ['community_invite_http_resp_001'],
      ['community_invite_debug_001'],
    ],
  ),
  mongoOutNode('community_invite_update_001', 'Update invite join members', 'lk_communities', 'update', false, 1850, 4580),
  mongoOutNode('community_invite_ranking_upsert_001', 'Upsert invite ranking', 'lk_community_rankings', 'update', true, 1850, 4620),
  mongoOutNode('community_invite_feed_insert_001', 'Insert invite join feed post', 'lk_community_feed', 'insert', false, 1850, 4660),
  mongoOutNode('community_invite_event_insert_001', 'Insert invite join event', 'lk_community_events', 'insert', false, 1850, 4700),
  httpResponseNode('community_invite_http_resp_001', 1850, 4740),
  debugNode('community_invite_debug_001', 'community invite debug', 1850, 4780),

  httpInNode('community_member_manage_in_001', 'LK community member manage', '/lk/communities/:communityId/members/manage', 'post', 150, 4820, 'community_member_manage_fn_prepare_001'),
  functionNode(
    'community_member_manage_fn_prepare_001',
    'Prepare member management',
    fnMemberManagePrepare,
    3,
    430,
    4820,
    [['community_member_manage_find_001'], ['community_member_manage_http_resp_001'], ['community_member_manage_debug_001']],
  ),
  mongoInNode('community_member_manage_find_001', 'Find community for member management', 'lk_communities', 760, 4780, 'community_member_manage_fn_apply_001'),
  functionNode(
    'community_member_manage_fn_apply_001',
    'Apply member management',
    fnMemberManageApply,
    6,
    1090,
    4780,
    [
      ['community_member_manage_update_001'],
      ['community_member_manage_ranking_upsert_001'],
      ['community_member_manage_feed_insert_001'],
      ['community_member_manage_event_insert_001'],
      ['community_member_manage_http_resp_001'],
      ['community_member_manage_debug_001'],
    ],
  ),
  mongoOutNode('community_member_manage_update_001', 'Update community members after moderation', 'lk_communities', 'update', false, 1450, 4700),
  mongoOutNode('community_member_manage_ranking_upsert_001', 'Upsert moderated ranking', 'lk_community_rankings', 'update', true, 1450, 4740),
  mongoOutNode('community_member_manage_feed_insert_001', 'Insert moderation feed post', 'lk_community_feed', 'insert', false, 1450, 4780),
  mongoOutNode('community_member_manage_event_insert_001', 'Insert moderation event', 'lk_community_events', 'insert', false, 1450, 4820),
  httpResponseNode('community_member_manage_http_resp_001', 1450, 4860),
  debugNode('community_member_manage_debug_001', 'community member manage debug', 1450, 4900),

  httpInNode('community_feed_get_in_001', 'LK community feed', '/lk/communities/:communityId/feed', 'get', 150, 4900, 'community_feed_get_fn_prepare_001'),
  functionNode(
    'community_feed_get_fn_prepare_001',
    'Prepare feed request',
    fnFeedGetPrepare,
    3,
    400,
    4900,
    [['community_feed_get_find_community_001'], ['community_feed_get_http_resp_001'], ['community_feed_get_debug_001']],
  ),
  mongoInNode('community_feed_get_find_community_001', 'Find community for feed access', 'lk_communities', 720, 4860, 'community_feed_get_fn_query_001'),
  functionNode(
    'community_feed_get_fn_query_001',
    'Build feed query',
    fnFeedGetQuery,
    3,
    1010,
    4860,
    [['community_feed_get_find_posts_001'], ['community_feed_get_http_resp_001'], ['community_feed_get_debug_001']],
  ),
  mongoInNode('community_feed_get_find_posts_001', 'Find community feed posts', 'lk_community_feed', 1320, 4860, 'community_feed_get_fn_comments_query_001'),
  functionNode(
    'community_feed_get_fn_comments_query_001',
    'Build feed comments query',
    fnFeedCommentsQuery,
    3,
    1600,
    4860,
    [['community_feed_get_find_comments_001'], ['community_feed_get_http_resp_001'], ['community_feed_get_debug_001']],
  ),
  mongoInNode('community_feed_get_find_comments_001', 'Find community feed comments', 'lk_community_feed_comments', 1900, 4820, 'community_feed_get_fn_reactions_query_001'),
  functionNode(
    'community_feed_get_fn_reactions_query_001',
    'Build feed reactions query',
    fnFeedReactionsQuery,
    3,
    2190,
    4820,
    [['community_feed_get_find_reactions_001'], ['community_feed_get_http_resp_001'], ['community_feed_get_debug_001']],
  ),
  mongoInNode('community_feed_get_find_reactions_001', 'Find community feed reactions', 'lk_community_feed_reactions', 2500, 4820, 'community_feed_get_fn_response_001'),
  functionNode(
    'community_feed_get_fn_response_001',
    'Build feed response',
    fnFeedResponse,
    2,
    2790,
    4860,
    [['community_feed_get_http_resp_001'], ['community_feed_get_debug_001']],
  ),
  httpResponseNode('community_feed_get_http_resp_001', 3070, 4900),
  debugNode('community_feed_get_debug_001', 'community feed get debug', 3060, 4940),

  httpInNode('community_feed_post_in_001', 'LK community feed create', '/lk/communities/:communityId/feed', 'post', 150, 5060, 'community_feed_post_fn_prepare_001'),
  functionNode(
    'community_feed_post_fn_prepare_001',
    'Prepare feed post',
    fnFeedPostPrepare,
    3,
    400,
    5060,
    [['community_feed_post_find_community_001'], ['community_feed_post_http_resp_001'], ['community_feed_post_debug_001']],
  ),
  mongoInNode('community_feed_post_find_community_001', 'Find community for post create', 'lk_communities', 710, 5020, 'community_feed_post_fn_apply_001'),
  functionNode(
    'community_feed_post_fn_apply_001',
    'Build feed post docs',
    fnFeedPostApply,
    5,
    1000,
    5020,
    [
      ['community_feed_post_insert_001'],
      ['community_feed_post_event_insert_001'],
      ['community_feed_post_update_community_001'],
      ['community_feed_post_http_resp_001'],
      ['community_feed_post_debug_001'],
    ],
  ),
  mongoOutNode('community_feed_post_insert_001', 'Insert feed post', 'lk_community_feed', 'insert', false, 1290, 4980),
  mongoOutNode('community_feed_post_event_insert_001', 'Insert feed post event', 'lk_community_events', 'insert', false, 1290, 5020),
  mongoOutNode('community_feed_post_update_community_001', 'Update community feed activity', 'lk_communities', 'update', false, 1290, 5060),
  httpResponseNode('community_feed_post_http_resp_001', 1290, 5100),
  debugNode('community_feed_post_debug_001', 'community feed post debug', 1290, 5140),

  httpInNode('community_feed_archive_in_001', 'LK community feed archive', '/lk/communities/:communityId/feed/:postId/archive', 'post', 150, 5220, 'community_feed_archive_fn_prepare_001'),
  functionNode(
    'community_feed_archive_fn_prepare_001',
    'Prepare archive feed post',
    fnFeedArchivePrepare,
    3,
    420,
    5220,
    [['community_feed_archive_find_community_001'], ['community_feed_archive_http_resp_001'], ['community_feed_archive_debug_001']],
  ),
  mongoInNode('community_feed_archive_find_community_001', 'Find community for archive', 'lk_communities', 760, 5180, 'community_feed_archive_fn_post_query_001'),
  functionNode(
    'community_feed_archive_fn_post_query_001',
    'Build archive feed post query',
    fnFeedArchivePostQuery,
    3,
    1050,
    5180,
    [['community_feed_archive_find_post_001'], ['community_feed_archive_http_resp_001'], ['community_feed_archive_debug_001']],
  ),
  mongoInNode('community_feed_archive_find_post_001', 'Find feed post for archive', 'lk_community_feed', 1370, 5180, 'community_feed_archive_fn_apply_001'),
  functionNode(
    'community_feed_archive_fn_apply_001',
    'Archive feed post',
    fnFeedArchiveApply,
    5,
    1660,
    5180,
    [
      ['community_feed_archive_post_update_001'],
      ['community_feed_archive_find_remaining_posts_001'],
      ['community_feed_archive_event_insert_001'],
      ['community_feed_archive_http_resp_001'],
      ['community_feed_archive_debug_001'],
    ],
  ),
  mongoOutNode('community_feed_archive_post_update_001', 'Archive feed post doc', 'lk_community_feed', 'update', false, 1950, 5100),
  mongoInNode('community_feed_archive_find_remaining_posts_001', 'Find remaining visible posts', 'lk_community_feed', 1980, 5180, 'community_feed_archive_fn_update_community_001'),
  functionNode(
    'community_feed_archive_fn_update_community_001',
    'Recalculate community feed activity',
    fnFeedArchiveCommunityUpdate,
    2,
    2270,
    5180,
    [['community_feed_archive_update_community_001'], ['community_feed_archive_debug_001']],
  ),
  mongoOutNode('community_feed_archive_update_community_001', 'Update community after archive', 'lk_communities', 'update', false, 2570, 5140),
  mongoOutNode('community_feed_archive_event_insert_001', 'Insert archive feed event', 'lk_community_events', 'insert', false, 1950, 5260),
  httpResponseNode('community_feed_archive_http_resp_001', 1950, 5300),
  debugNode('community_feed_archive_debug_001', 'community feed archive debug', 1950, 5340),

  httpInNode('community_feed_thread_in_001', 'LK community feed thread', '/lk/communities/:communityId/feed/:postId/thread', 'get', 150, 5680, 'community_feed_thread_fn_prepare_001'),
  functionNode(
    'community_feed_thread_fn_prepare_001',
    'Prepare feed thread request',
    fnFeedThreadPrepare,
    3,
    430,
    5680,
    [['community_feed_thread_find_community_001'], ['community_feed_thread_http_resp_001'], ['community_feed_thread_debug_001']],
  ),
  mongoInNode('community_feed_thread_find_community_001', 'Find community for thread access', 'lk_communities', 760, 5640, 'community_feed_thread_fn_post_query_001'),
  functionNode(
    'community_feed_thread_fn_post_query_001',
    'Build feed thread post query',
    fnFeedThreadPostQuery,
    3,
    1070,
    5640,
    [['community_feed_thread_find_post_001'], ['community_feed_thread_http_resp_001'], ['community_feed_thread_debug_001']],
  ),
  mongoInNode('community_feed_thread_find_post_001', 'Find feed post for thread', 'lk_community_feed', 1390, 5600, 'community_feed_thread_fn_comments_query_001'),
  functionNode(
    'community_feed_thread_fn_comments_query_001',
    'Build feed thread comments query',
    fnFeedThreadCommentsQuery,
    3,
    1690,
    5600,
    [['community_feed_thread_find_comments_001'], ['community_feed_thread_http_resp_001'], ['community_feed_thread_debug_001']],
  ),
  mongoInNode('community_feed_thread_find_comments_001', 'Find feed thread comments', 'lk_community_feed_comments', 2000, 5560, 'community_feed_thread_fn_reactions_query_001'),
  functionNode(
    'community_feed_thread_fn_reactions_query_001',
    'Build feed thread reactions query',
    fnFeedThreadReactionsQuery,
    3,
    2290,
    5560,
    [['community_feed_thread_find_reactions_001'], ['community_feed_thread_http_resp_001'], ['community_feed_thread_debug_001']],
  ),
  mongoInNode('community_feed_thread_find_reactions_001', 'Find feed thread reactions', 'lk_community_feed_reactions', 2600, 5560, 'community_feed_thread_fn_response_001'),
  functionNode(
    'community_feed_thread_fn_response_001',
    'Build feed thread response',
    fnFeedThreadResponse,
    2,
    2890,
    5600,
    [['community_feed_thread_http_resp_001'], ['community_feed_thread_debug_001']],
  ),
  httpResponseNode('community_feed_thread_http_resp_001', 3170, 5680),
  debugNode('community_feed_thread_debug_001', 'community feed thread debug', 3160, 5720),

  httpInNode('community_feed_comment_in_001', 'LK community feed comment create', '/lk/communities/:communityId/feed/:postId/comments', 'post', 150, 5840, 'community_feed_comment_fn_prepare_001'),
  functionNode(
    'community_feed_comment_fn_prepare_001',
    'Prepare feed comment',
    fnFeedCommentPrepare,
    3,
    430,
    5840,
    [['community_feed_comment_find_community_001'], ['community_feed_comment_http_resp_001'], ['community_feed_comment_debug_001']],
  ),
  mongoInNode('community_feed_comment_find_community_001', 'Find community for feed comment', 'lk_communities', 760, 5800, 'community_feed_comment_fn_post_query_001'),
  functionNode(
    'community_feed_comment_fn_post_query_001',
    'Build feed comment post query',
    fnFeedCommentPostQuery,
    3,
    1070,
    5800,
    [['community_feed_comment_find_post_001'], ['community_feed_comment_http_resp_001'], ['community_feed_comment_debug_001']],
  ),
  mongoInNode('community_feed_comment_find_post_001', 'Find feed post for comment', 'lk_community_feed', 1390, 5760, 'community_feed_comment_fn_apply_001'),
  functionNode(
    'community_feed_comment_fn_apply_001',
    'Build feed comment docs',
    fnFeedCommentApply,
    4,
    1700,
    5760,
    [
      ['community_feed_comment_insert_001'],
      ['community_feed_comment_event_insert_001'],
      ['community_feed_comment_http_resp_001'],
      ['community_feed_comment_debug_001'],
    ],
  ),
  mongoOutNode('community_feed_comment_insert_001', 'Insert feed comment', 'lk_community_feed_comments', 'insert', false, 2020, 5720),
  mongoOutNode('community_feed_comment_event_insert_001', 'Insert feed comment event', 'lk_community_events', 'insert', false, 2020, 5760),
  httpResponseNode('community_feed_comment_http_resp_001', 2020, 5840),
  debugNode('community_feed_comment_debug_001', 'community feed comment debug', 2020, 5880),

  httpInNode('community_feed_reaction_in_001', 'LK community feed reaction set', '/lk/communities/:communityId/feed/:postId/reaction', 'post', 150, 6000, 'community_feed_reaction_fn_prepare_001'),
  functionNode(
    'community_feed_reaction_fn_prepare_001',
    'Prepare feed reaction',
    fnFeedReactionPrepare,
    3,
    430,
    6000,
    [['community_feed_reaction_find_community_001'], ['community_feed_reaction_http_resp_001'], ['community_feed_reaction_debug_001']],
  ),
  mongoInNode('community_feed_reaction_find_community_001', 'Find community for feed reaction', 'lk_communities', 760, 5960, 'community_feed_reaction_fn_post_query_001'),
  functionNode(
    'community_feed_reaction_fn_post_query_001',
    'Build feed reaction post query',
    fnFeedReactionPostQuery,
    3,
    1070,
    5960,
    [['community_feed_reaction_find_post_001'], ['community_feed_reaction_http_resp_001'], ['community_feed_reaction_debug_001']],
  ),
  mongoInNode('community_feed_reaction_find_post_001', 'Find feed post for reaction', 'lk_community_feed', 1390, 5920, 'community_feed_reaction_fn_lookup_query_001'),
  functionNode(
    'community_feed_reaction_fn_lookup_query_001',
    'Build feed reaction lookup query',
    fnFeedReactionLookupQuery,
    3,
    1700,
    5920,
    [['community_feed_reaction_find_existing_001'], ['community_feed_reaction_http_resp_001'], ['community_feed_reaction_debug_001']],
  ),
  mongoInNode('community_feed_reaction_find_existing_001', 'Find existing feed reaction', 'lk_community_feed_reactions', 2010, 5880, 'community_feed_reaction_fn_apply_001'),
  functionNode(
    'community_feed_reaction_fn_apply_001',
    'Build feed reaction docs',
    fnFeedReactionApply,
    5,
    2310,
    5880,
    [
      ['community_feed_reaction_update_001'],
      ['community_feed_reaction_post_update_001'],
      ['community_feed_reaction_event_insert_001'],
      ['community_feed_reaction_http_resp_001'],
      ['community_feed_reaction_debug_001'],
    ],
  ),
  mongoOutNode('community_feed_reaction_update_001', 'Upsert feed reaction', 'lk_community_feed_reactions', 'update', true, 2620, 5840),
  mongoOutNode('community_feed_reaction_post_update_001', 'Update feed reaction counters', 'lk_community_feed', 'update', false, 2620, 5800),
  mongoOutNode('community_feed_reaction_event_insert_001', 'Insert feed reaction event', 'lk_community_events', 'insert', false, 2620, 5880),
  httpResponseNode('community_feed_reaction_http_resp_001', 2620, 5960),
  debugNode('community_feed_reaction_debug_001', 'community feed reaction debug', 2620, 6000),

  httpInNode('community_chat_get_in_001', 'LK community chat messages', '/lk/communities/:communityId/messages', 'get', 150, 5200, 'community_chat_get_fn_prepare_001'),
  functionNode(
    'community_chat_get_fn_prepare_001',
    'Prepare chat messages request',
    fnChatGetPrepare,
    3,
    430,
    5200,
    [['community_chat_get_find_community_001'], ['community_chat_get_http_resp_001'], ['community_chat_get_debug_001']],
  ),
  mongoInNode('community_chat_get_find_community_001', 'Find community for chat access', 'lk_communities', 760, 5160, 'community_chat_get_fn_query_001'),
  functionNode(
    'community_chat_get_fn_query_001',
    'Build community chat query',
    fnChatGetQuery,
    3,
    1070,
    5160,
    [['community_chat_get_find_messages_001'], ['community_chat_get_http_resp_001'], ['community_chat_get_debug_001']],
  ),
  mongoInNode('community_chat_get_find_messages_001', 'Find community chat messages', 'lk_community_chat_messages', 1410, 5160, 'community_chat_get_fn_response_001'),
  functionNode(
    'community_chat_get_fn_response_001',
    'Build community chat response',
    fnChatGetResponse,
    2,
    1710,
    5160,
    [['community_chat_get_http_resp_001'], ['community_chat_get_debug_001']],
  ),
  httpResponseNode('community_chat_get_http_resp_001', 1710, 5200),
  debugNode('community_chat_get_debug_001', 'community chat get debug', 1710, 5240),

  httpInNode('community_chat_post_in_001', 'LK community chat send', '/lk/communities/:communityId/messages', 'post', 150, 5360, 'community_chat_post_fn_prepare_001'),
  functionNode(
    'community_chat_post_fn_prepare_001',
    'Prepare community chat message',
    fnChatPostPrepare,
    3,
    430,
    5360,
    [['community_chat_post_find_community_001'], ['community_chat_post_http_resp_001'], ['community_chat_post_debug_001']],
  ),
  mongoInNode('community_chat_post_find_community_001', 'Find community for chat send', 'lk_communities', 760, 5320, 'community_chat_post_fn_apply_001'),
  functionNode(
    'community_chat_post_fn_apply_001',
    'Build community chat docs',
    fnChatPostApply,
    4,
    1070,
    5320,
    [
      ['community_chat_post_insert_001'],
      ['community_chat_post_event_insert_001'],
      ['community_chat_post_http_resp_001'],
      ['community_chat_post_debug_001'],
    ],
  ),
  mongoOutNode('community_chat_post_insert_001', 'Insert community chat message', 'lk_community_chat_messages', 'insert', false, 1390, 5280),
  mongoOutNode('community_chat_post_event_insert_001', 'Insert community chat event', 'lk_community_events', 'insert', false, 1390, 5320),
  httpResponseNode('community_chat_post_http_resp_001', 1390, 5360),
  debugNode('community_chat_post_debug_001', 'community chat post debug', 1390, 5400),

  httpInNode('community_ranking_in_001', 'LK community ranking', '/lk/communities/:communityId/ranking', 'get', 160, 5520, 'community_ranking_fn_prepare_001'),
  httpInNode('community_rating_in_001', 'LK community rating', '/lk/communities/:communityId/rating', 'get', 160, 5560, 'community_ranking_fn_prepare_001'),
  httpInNode('community_rating_in_002', 'community rating (public path)', '/communities/:communityId/rating', 'get', 160, 5600, 'community_ranking_fn_prepare_001'),
  functionNode(
    'community_ranking_fn_prepare_001',
    'Prepare ranking request',
    fnRankingPrepare,
    3,
    400,
    5520,
    [['community_ranking_find_community_001'], ['community_ranking_http_resp_001'], ['community_ranking_debug_001']],
  ),
  mongoInNode('community_ranking_find_community_001', 'Find community for ranking', 'lk_communities', 710, 5480, 'community_ranking_fn_query_001'),
  functionNode(
    'community_ranking_fn_query_001',
    'Build ranking query',
    fnRankingQuery,
    3,
    1000,
    5480,
    [['community_ranking_find_snapshot_001'], ['community_ranking_http_resp_001'], ['community_ranking_debug_001']],
  ),
  mongoInNode('community_ranking_find_snapshot_001', 'Find rating snapshot', 'community_rating_snapshots', 1290, 5480, 'community_ranking_fn_snapshot_response_001'),
  functionNode(
    'community_ranking_fn_snapshot_response_001',
    'Use rating snapshot or fallback',
    fnRankingSnapshotResponse,
    3,
    1570,
    5480,
    [['community_ranking_http_resp_001'], ['community_ranking_find_rows_001'], ['community_ranking_debug_001']],
  ),
  mongoInNode('community_ranking_find_rows_001', 'Find feed posts for rating', 'lk_community_feed', 1840, 5480, 'community_ranking_fn_feed_query_001'),
  functionNode(
    'community_ranking_fn_feed_query_001',
    'Build games query for rating',
    fnRankingFeedQuery,
    2,
    2120,
    5480,
    [['community_ranking_find_games_001'], ['community_ranking_debug_001']],
  ),
  mongoInNode('community_ranking_find_games_001', 'Find games for rating', 'lk_games', 2370, 5480, 'community_ranking_fn_tournaments_query_001'),
  functionNode(
    'community_ranking_fn_tournaments_query_001',
    'Build tournaments query for rating',
    fnRankingTournamentsQuery,
    2,
    2630,
    5480,
    [['community_ranking_find_tournaments_001'], ['community_ranking_debug_001']],
  ),
  mongoInNode('community_ranking_find_tournaments_001', 'Find tournaments for rating', 'tournaments', 2900, 5480, 'community_ranking_fn_response_001'),
  functionNode(
    'community_ranking_fn_response_001',
    'Build rating response',
    fnRankingResponse,
    2,
    3180,
    5480,
    [['community_ranking_http_resp_001'], ['community_ranking_debug_001']],
  ),
  httpResponseNode('community_ranking_http_resp_001', 3450, 5520),
  debugNode('community_ranking_debug_001', 'community ranking debug', 3450, 5560),
];

const newIds = new Set(nodes.map((node) => node.id));
const raw = fs.readFileSync(srcPath, 'utf8');
const flow = JSON.parse(raw);
const filteredFlow = flow.filter((node) => !newIds.has(node.id));

const mongo4ImportNodes = transformFlowToMongo4(nodes);
const mongo4Flow = transformFlowToMongo4([...filteredFlow, ...nodes]);

fs.writeFileSync(importPath, `${JSON.stringify(mongo4ImportNodes, null, 2)}\n`);
fs.writeFileSync(outPath, `${JSON.stringify(mongo4Flow, null, 2)}\n`);

console.log(`Wrote ${path.basename(importPath)} and ${path.basename(outPath)}`);
