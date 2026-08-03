export const REQUIRED_BUILD_ENV_KEYS = [
  "VITE_API_BASE",
  "VITE_KEYCLOAK_BASE",
  "VITE_TENANT_KEY",
  "VITE_SERV2",
  "VITE_SERV2_FALLBACK",
  "VITE_SUPPORT_API_BASE",
  "VITE_SUCCESS_URL",
  "VITE_FAIL_URL",
  "VITE_GAMES_BUNDLE_URL",
  "VITE_TOURNAMENTS_BUNDLE_URL",
  "VITE_ONBOARDING_BUNDLE_URL",
  "VITE_LEVELS_INFO_BUNDLE_URL",
  "VITE_COMMUNITIES_BUNDLE_URL",
  "VITE_CABINET_URL",
  "VITE_LK_ASSET_FALLBACK_BASE_URLS",
  "VITE_PUSH_REGISTRATION_URL",
  "VITE_PUSH_UNREGISTRATION_URL",
];

const PROD_RELEASE_ARTIFACTS = [
  "bundle.js",
  "games.js",
  "tournaments.js",
  "tournament-signup.js",
  "group-schedule.js",
  "padel-day-schedule.js",
  "tournament-subscription.js",
  "tournament-subscription-referral.js",
  "onboarding.js",
  "levels-info.js",
  "communities.js",
];

const DEV_RELEASE_ARTIFACTS = PROD_RELEASE_ARTIFACTS.map((fileName) =>
  fileName.replace(/\.js$/, "-dev.js"),
);

const URL_BUILD_ENV_KEYS = REQUIRED_BUILD_ENV_KEYS.filter(
  (key) => key !== "VITE_TENANT_KEY",
);

const ROOT_BUNDLE_RUNTIME_AUDIT_FIELDS = [
  "communitiesBundleUrl",
  "levelsInfoBundleUrl",
  "onboardingBundleUrl",
  "pushRegistrationUrl",
  "keycloakBase",
  "serv2Fallback",
];

const ROOT_BUNDLE_RUNTIME_MARKERS = {
  "bundle.js": ["lk-runtime-config-v1:prod", ...ROOT_BUNDLE_RUNTIME_AUDIT_FIELDS],
  "bundle-dev.js": ["lk-runtime-config-v1:dev", ...ROOT_BUNDLE_RUNTIME_AUDIT_FIELDS],
};

export function validateBuildEnv(env) {
  const errors = [];

  for (const key of REQUIRED_BUILD_ENV_KEYS) {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    if (!value || value === "undefined" || value === "null") {
      errors.push(`${key} is missing`);
    }
  }

  for (const key of URL_BUILD_ENV_KEYS) {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    if (!value || value === "undefined" || value === "null") continue;

    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.push(`${key} must use http or https`);
      }
    } catch {
      errors.push(`${key} must be an absolute URL`);
    }
  }

  return errors;
}

export function validateBundleRuntimeConfig(source, artifactName = "") {
  const errors = [];
  const invalidPatterns = [
    ["undefined/end-user", "contains an undefined API base or tenant path"],
    ["undefinedundefined/end-user", "contains concatenated undefined API configuration"],
    ["/api/v1/undefined/", "contains an undefined v1 tenant path"],
    ["/api/v2/undefined/", "contains an undefined v2 tenant path"],
  ];

  for (const [pattern, message] of invalidPatterns) {
    if (source.includes(pattern)) errors.push(message);
  }

  const requiredMarkers = ROOT_BUNDLE_RUNTIME_MARKERS[artifactName] ?? [];
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) {
      errors.push(`${artifactName} is missing required runtime marker ${marker}`);
    }
  }

  return [...new Set(errors)];
}

export function releaseArtifactNames(manifestFileName) {
  switch (manifestFileName) {
    case "release.json":
      return PROD_RELEASE_ARTIFACTS;
    case "release-dev.json":
      return DEV_RELEASE_ARTIFACTS;
    case "release-ffc-academy.json":
      return ["ffc-academy-lk.js"];
    case "release-ffc-academy-dev.json":
      return ["ffc-academy-lk-dev.js"];
    default:
      return [];
  }
}
