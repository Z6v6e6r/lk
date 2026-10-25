# Community media alias remediation — 2026-10-25

Status: source-only patch. No production read/write, regeneration/import, release or data repair.

Retained monitoring observed 35,458 legacy media404 (35,538 total media404); these are requests, not distinct missing images. Readbacks showed a public summary advertising a legacy alias that returned404. Synthetic reproduction proves the prefix-based guard bypass across proxy protocol/known public-host differences. The actual selected branch of every historical404 is not established.

Changes:
- In `scripts/patch_nodered_communities_flow.mjs`, `resolveCommunityLogoFields` checks self legacy aliases on the exact response-base authority or the fixed public hosts padlhub.ru/padlhub.su, allowing default http/https ports. Foreign hosts, userinfo, nonstandard ports, other-community aliases and modern assets retain their existing behavior. No image/proxy network requests are added.
- Summary query projection includes logoDataUrl/logoThumbLegacyDataUrl/logoThumbDataUrl, matching the legacy handlers' backing-field priority. These remain internal fields and are not returned to clients.
- Existing frontend candidate exhaustion already renders a placeholder. No UI code change is required for a null logo.

Acceptance: valid original/thumb sources continue working; missing/malformed self backing data yields null; summary does not expose backing data or advertise a proven missing self alias. Existing external images remain intact. Absent image bytes require a separately authorized restoration/upload; this patch does not invent or recover them.

Release boundary: start from fresh live function preimages and construct a narrow, exact candidate for community list query/response. Do not run a broad communities flow regeneration or reactivate unrelated typed-community workers/config. The retained runtime is a historical baseline only; source main includes changes not necessarily deployed. No generated full flow is included here.
