export const FENCE_RELEASE_CONFIRMATION = "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1";

export function isAuthorizedFenceGuardianRelease({ release, validPrivateFile, fenceTokenSha256, nowMs = Date.now() }) {
  const authorizedAt = Date.parse(release?.authorizedAt);
  return validPrivateFile === true && release?.formatVersion === 1
    && release?.kind === "viva-game-projection-fence-release-request"
    && release?.state === "RELEASE_AUTHORIZED" && release?.confirmation === FENCE_RELEASE_CONFIRMATION
    && release?.fenceTokenSha256 === fenceTokenSha256 && Number.isFinite(authorizedAt)
    && authorizedAt <= nowMs + 60_000 && nowMs - authorizedAt <= 5 * 60_000;
}
