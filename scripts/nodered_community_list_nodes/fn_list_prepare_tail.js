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
  const normalizedPhone = msg._communityList.phone;
  const phoneVariants = [normalizedPhone];
  if (normalizedPhone.length === 11 && normalizedPhone.startsWith('7')) {
    phoneVariants.push(normalizedPhone.slice(1));
    phoneVariants.push('8' + normalizedPhone.slice(1));
  }
  const uniquePhoneVariants = Array.from(new Set(phoneVariants));
  ['phone', 'phoneNorm', 'phoneNumber', 'mobile'].forEach((field) => {
    uniquePhoneVariants.forEach((variant) => {
      viewerIdentityFilters.push({
        [field]: new RegExp('^\\D*' + variant.split('').join('\\D*') + '\\D*$', 'i'),
      });
      const numericVariant = Number(variant);
      if (Number.isSafeInteger(numericVariant)) {
        viewerIdentityFilters.push({ [field]: numericVariant });
      }
    });
  });
}

const accessFilters = [
  { visibility: { $not: /^\s*CLOSED\s*$/i } },
];
if (viewerIdentityFilters.length > 0) {
  const viewerMatch = { $or: viewerIdentityFilters };
  accessFilters.push({ members: { $elemMatch: viewerMatch } });
  accessFilters.push({ pendingMembers: { $elemMatch: viewerMatch } });
}

const summaryProjection = {
  _id: 0,
  archived: 1,
  id: 1,
  communityId: 1,
  name: 1,
  title: 1,
  slug: 1,
  logo: 1,
  logoUrl: 1,
  logoThumbUrl: 1,
  logoThumb: 1,
  thumbnailUrl: 1,
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
  _summaryMemberCount: { $size: { $cond: [{ $isArray: '$members' }, '$members', []] } },
  _summaryPendingCount: { $size: { $cond: [{ $isArray: '$pendingMembers' }, '$pendingMembers', []] } },
  _summaryBannedCount: { $size: { $cond: [{ $isArray: '$bannedMembers' }, '$bannedMembers', []] } },
};
if (viewerIdentityFilters.length > 0) {
  // $elemMatch returns the first raw match, which may not be the member chosen by
  // buildMember/matchesIdentity when older rows contain conflicting ID aliases.
  const unsupported = '__community_identity_conversion_error__';
  const asString = (field) => ({
    $convert: { input: field, to: 'string', onError: unsupported, onNull: '' },
  });
  const matchesPattern = (field, pattern) => ({
    $let: {
      vars: { value: asString(field) },
      in: {
        $or: [
          { $eq: ['$$value', unsupported] },
          { $regexMatch: { input: '$$value', regex: pattern } },
        ],
      },
    },
  });
  const idPattern = msg._communityList.clientId
    ? new RegExp('^\\s*' + msg._communityList.clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')
    : null;
  const phoneVariants = msg._communityList.phone
    ? [
      msg._communityList.phone,
      ...(msg._communityList.phone.length === 11 && msg._communityList.phone.startsWith('7')
        ? [msg._communityList.phone.slice(1), '8' + msg._communityList.phone.slice(1)]
        : []),
    ]
    : [];
  const phonePattern = phoneVariants.length
    ? new RegExp('^\\D*(?:' + Array.from(new Set(phoneVariants))
      .map((variant) => variant.split('').join('\\D*')).join('|') + ')\\D*$')
    : null;
  const memberMatches = [
    ...(idPattern ? ['id', 'clientId', 'userId', 'uuid']
      .map((field) => matchesPattern('$$candidate.' + field, idPattern)) : []),
    ...(phonePattern ? ['phone', 'phoneNorm', 'phoneNumber', 'mobile']
      .map((field) => matchesPattern('$$candidate.' + field, phonePattern)) : []),
  ];
  const matchingRoster = (field) => ({
    $filter: {
      input: { $cond: [{ $isArray: '$' + field }, '$' + field, []] },
      as: 'candidate',
      cond: { $or: memberMatches },
    },
  });
  summaryProjection.members = matchingRoster('members');
  summaryProjection.pendingMembers = matchingRoster('pendingMembers');
}

const summaryQuery = {
  ...listQuery,
  $or: accessFilters,
};
msg.payload = [summaryQuery, { projection: summaryProjection }];
return [msg, null, msg];
