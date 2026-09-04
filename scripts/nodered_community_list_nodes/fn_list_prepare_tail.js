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
  id: 1,
  communityId: 1,
  name: 1,
  title: 1,
  slug: 1,
  logoUrl: 1,
  logoThumbUrl: 1,
  logoAssetId: 1,
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

msg.payload = {
  ...listQuery,
  $or: accessFilters,
};
msg.projection = summaryProjection;
return [msg, null, msg];
