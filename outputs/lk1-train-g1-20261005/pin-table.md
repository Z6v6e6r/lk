# LK1 train 147 — G1/G2 pin derivation (2026-10-05)

Snapshot: `lk-primary-147:/root/.node-red/flows.json`,
sha256 `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1`, 4815 nodes, 9 872 180 bytes.
Re-verified read-only on 2026-10-05 13:0x MSK (`ssh -o BatchMode=yes root@lk-primary-147 'sha256sum …'`):
remote sha equals the local copy. Full derivation: `pin-derivation.json`; reviewable candidate
evidence: `candidate-evidence.json`.

Legend: **derived** — recomputed from the snapshot bytes or from the current reviewed sources;
**unchanged** — the pin already equals the derived value; **not-derivable** — the generation that
owns the pin refuses on this snapshot, so re-pinning it without re-authoring the generation would
leave a fail-closed but misleading patcher (preparation-branch finding, unchanged).

## A. G1 — `scripts/patch_live_lk1_train_g1_20261005.mjs`

| Pin | Old | New | State |
| --- | --- | --- | --- |
| `LK1_TRAIN_G1_UPSTREAM_SHA256` | — (new) | `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1` | derived |
| `LK1_TRAIN_G1_SOURCE_NODE_COUNT` | — (new) | `4815` | derived |
| `LK1_TRAIN_G1_TARGET.liveFuncSha256` | — (new) | `21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2` | derived |
| `LK1_TRAIN_G1_TARGET.liveInitializeSha256` | — (new) | `d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5` | derived |
| `LK1_TRAIN_G1_TARGET.patchedFuncSha256` | `PENDING_COMPOSITION` | `7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4` | derived |
| `LK1_TRAIN_G1_TARGET.patchedInitializeSha256` | `PENDING_COMPOSITION` | `283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3` | derived — **equals `PATRIOTS_POSTIMAGE.gatewayInitialize`** |
| `LK1_TRAIN_G1_PREIMAGE_NODE_SHA256` | — (new) | `f3e1b807a13b1d404a8ecf5119c9cb03c63217f64986201c4e52440d4a0f107b` | derived |
| `LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256` | — (new) | `d4d84655a24c6dd79c64501ff7359c4a56f86f88d28d80f60d9ccf61d022aea0` | derived |
| `LK1_TRAIN_G1_POSTIMAGE_SHA256` (candidate) | — (new) | `99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3` | derived |
| `LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256` | — (new) | `0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f` | derived |
| `LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256` | — (new) | `2c2c0c89e3562fff985c388d7bbd0f55f9deaf5cc002ae86974ce59f43c6caf1` | derived |
| gateway `func` | `21c50a8d…` | `7f1539bf…` | derived |
| gateway `initialize` | `d7aec140…` | `283f9e8a…` | derived |
| shared allowance block (`lk1_usage_operations … lk1_policy_decision`) | `a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1` | `2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813` | derived |

Reviewed fragments G1 embeds (all verified against their own sha before use):

| Fragment | Pin |
| --- | --- |
| `scripts/nodered_lk1_hub_nodes/gateway.js` | `430dbb09b3df1379c1100a0af784720abfdb9687b89662999d982db4aedeef8a` |
| `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` | `2225ca5234313613e1e5ede2d767dcbfacddc03bb0976a45ae4a970c7bf9dfef` |
| court helpers (`lk1CourtMasterServices … lk1CourtWindowTotal`) | `dea0323fb7535e821d74af271339ef5d3c4db65622ec865384637fbbad6d86dd` |
| court dispatch (`// The club co-pay needs one more server-owned number …`) | `bd02267fe48e9646db1e13eaf09c9e834850aa657c78ab85a8c89586ea91ab0e` |
| court steps (`lk1CourtWindowEndTime … lk1CourtWindowStoreProof`) | `1e8684b49d52022e4c8c19e1ec686e6c03b9366caa4a40c36291cf4a106112c1` |
| `lk1Quote` court block | `bb0959709507c07d5a77123a4cbb18f9140b5f11ae200f3c7bee656854101ec9` |
| allowance `courtMinutes` accumulator | `5b179145ca50cd9e2f19422fe7e9e898027b9a419d88bf5a2efdba3008e9ed3a` |
| allowance club-game free-visit ceiling | `e363c97b76ec48d955673fb8bcba303bc7563b578d0e9e4f9674f1ab0de9387a` |
| club gate (#174 `open_game` + reviewed refusal text) | `520e3486922e735ff0d82cf5503ae39a18ad00068b6806069b26c9f5e30c5e1c` |
| Patriots money-only identity guard | `9a417b05213e1fe3e891f2063aa69a14699854790016a1196ae18f97fafda8e2` |
| focused court-window continuation block | `b3342f91b20d64c7bdf6e9fc53e27ba8f40b5011088bf68364b6517cb3c02f9e` |
| club money mandate `COURT_HOURLY_COPAY` branch (F1) | `d239076989eca25526f0c51865c36e976baf6ed533add7485f6d782976a76d50` |

Plan-rules: installed prior **9 rules** (`LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS`, planKeys
`ra, friendship, academy, sport, promo_academy, promo_friendship, promo_ra, topocraty,
friendship_two_hours`) → G1 desired **10 rules** (`+ patriots`,
product `37ab3713-4431-4815-96ba-d7ece76a9241`). Writer replaced, not appended.

## B. G2 — `scripts/patch_live_lk1_train_g2_20261005.mjs`

| Pin | Old | New | State |
| --- | --- | --- | --- |
| `LK1_TRAIN_G2_UPSTREAM_SHA256` | — (new) | `99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3` (G1 postimage) | derived |
| `LK1_TRAIN_G2_TARGET.gatewayFuncSha256` | — (new) | `7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4` | derived |
| `LK1_TRAIN_G2_TARGET.usageBlockSha256` | — (new) | `2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813` | derived |
| `LK1_TRAIN_G2_TARGET.pricingFuncSha256` | — (new) | `d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b` | unchanged |
| `LK1_TRAIN_G2_TARGET.joinFuncSha256` | — (new) | `8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074` | unchanged |
| `liveEvaluatorFuncSha256` | — (new) | `2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602` | derived |
| `liveEvaluatorEmbeddedSha256` | — (new) | `ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3` | derived |
| `livePreviewEvaluateFuncSha256` | — (new) | `2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602` | derived |
| `livePreviewEvaluateEmbeddedSha256` | — (new) | `ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3` | derived |
| `livePreviewRouterFuncSha256` | — (new) | `43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70` | derived |
| `patchedEvaluatorFuncSha256` | — (new) | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` | derived |
| `patchedPreviewEvaluateFuncSha256` | — (new) | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` | derived |
| `patchedPreviewRouterFuncSha256` | `PENDING_COMPOSITION` | `0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221` | derived — **recomposed over the F1/F2 gateway body and byte-identical**: the changed club-binding/dispatch code does not enter the preview helper closure, only the (unchanged) allowance block does |
| `LK1_TRAIN_G2_POSTIMAGE_SHA256` (candidate) | — (new) | `0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192` | derived |

## C. Cross-generation pins the new body moves

| Owner | Pin | Old (2026-10-05 prep) | New | State |
| --- | --- | --- | --- | --- |
| `scripts/patch_nodered_subscription_price_preview.mjs` | `PREVIEW_CANONICAL_SOURCE_SHA256.booking` | `8848722f…` | `7f1539bf…` (after G1; G2 passes it through `pins.booking`) | derived |
| `…` | `.evaluator` | `6f4e7aa5…` | `e876ba07…` (G2) | derived |
| `…` | `.pricing` | `53c4f6ab…` | `d93de261…` | derived |
| `…` | `.join` | `70ec2bdf…` | `8b312b97…` | derived |
| `scripts/patch_live_lk1_patriots_friendship.mjs` | `reviewedGatewaySource` | `9ca40575…` | `430dbb09b3df1379c1100a0af784720abfdb9687b89662999d982db4aedeef8a` | **derived + committed (owner decision)** |
| `…` | `reviewedGatewayHooksSource` | `636e005f…` | `2225ca5234313613e1e5ede2d767dcbfacddc03bb0976a45ae4a970c7bf9dfef` | **derived + committed** |
| `…` | `reviewedEvaluatorSource` | `45b7ef57…` | `ac05d7cd876523d19ec380cd3f7d68c78ea48320cf5586160b19e6cb3e613d9d` | **derived + committed** |
| `…` | `PATRIOTS_POSTIMAGE.gatewayInitialize` | `283f9e8a…` | unchanged `283f9e8a…` | derived — proven applicable to the 2026-10-05 initialize |
| `scripts/patch_live_lk1_hub.mjs` | `HUB_PREIMAGES.split` | `c6ecc73d…` | `d93de261…` | derived (composition still refuses) |
| `…` | `HUB_PREIMAGES.gateway` | `818817e0…` | `7f1539bf…` after G1 / `21c50a8d…` before | derived |
| `…` | `HUB_PREIMAGES.finalize` | `37b05b0a…` | `2b115412…` | derived |
| `…` | `HUB_PREIMAGES.evaluator` | `47c5e8b7…` | `e876ba07…` after G2 | derived |
| `scripts/nodered_lk1_hub_nodes/preimages.json` | `nodes` | 7 of 20 drifted | 7 drifted (unchanged set) + no new node moved | derived |
| `scripts/patch_live_lk1_topokraty_copay_hotfix.mjs` | `TOPOKRATY_COPAY_APPLIED_SHA256` | `70b9350f…` | — | not-derivable: the co-pay generation refuses on this snapshot |
| `scripts/patch_live_lk1_plan_rules.mjs` | `PLAN_RULES_TARGETS.*.patched*` | see file | — | not-derivable: the plan-rules gateway body is already patched |
| `scripts/patch_live_lk1_event_quotes_hotfix.mjs` | `EVENT_QUOTES_TARGETS.previewFinal.patchedFuncSha256` | `7c822e2b…` | `e7c174ea…` | derived — equals the reviewed `final.js`, so the `final` delta is a no-op |
| `scripts/patch_live_subscription_calculation_repair.mjs` | `SOURCE_SHA256` / inline node count | `0dacc3d0…` / 4804 | `7e8a9570…` / 4815 | derived (composition still refuses on the node-identity check) |

Unchanged reviewed pins (still correct): `TOPOKRATY_DIRECTION_HELPER_SHA256`,
`TOPOKRATY_PERCENT_HELPER_SHA256`, `TOPOKRATY_COURT_HELPERS_SHA256`,
`TOPOKRATY_COURT_DISPATCH_SHA256`, `TOPOKRATY_COURT_STEPS_SHA256`,
`TOPOKRATY_REVIEWED_EVALUATOR_SHA256`, `PLAN_RULES_MODULE_SHA256`,
`PLAN_RULES_REVIEWED_EVALUATOR_SHA256`, `TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256`, the
split/join/`final`/`error` reviewed sources.
