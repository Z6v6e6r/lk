# Community SUMMARY MongoDB projection

`GET /lk/communities?view=summary` on the enabled `LK Communities` tab reads
`lk_communities` through these live nodes on `lk-primary-147`:

| Node ID | Function |
| --- | --- |
| `634ddb4d82d27e9f` | Prepare communities list query |
| `43a65858ca194292` | Find communities (`mongodb4`, `find`, `toArray`) |
| `9ec08e9a627fa3e2` | Build communities list response |

The installed `node-red-contrib-mongodb4` calls MongoDB's `find` with the
arguments in `msg.payload`. It ignores a separate `msg.projection`. SUMMARY
therefore sends `[filter, { projection }]` in `msg.payload`. FULL keeps its
original unprojected filter and response.

The projection retains the existing access filter and all possible viewer
matches from `members`/`pendingMembers`, complete counts calculated on the
database server, and fields needed by the list card. Retaining all candidates
preserves the response's ID-alias precedence for ambiguous legacy rows. It includes legacy logo
data when present because the existing response maps it to a media URL. The
`archived` field remains available to the response's legacy archive filter.
The projected count fields stay internal to the response function. If they are
missing, SUMMARY returns an error rather than incorrect membership totals.

In a bounded read-only comparison on the installed MongoDB driver 6.21.0,
90 public documents used 4,636,600 JSON bytes before projection and 683,314
after this compatible projection (6.79 times less). This is one workload
sample, not a measured reduction in process RSS. A synthetic database-side
check confirmed that both conflicting ID aliases and formatted phone matches
survive the projection and the response still selects the correct viewer role.
Neither check exported community documents.

The source tails are
`scripts/nodered_community_list_nodes/fn_list_prepare_tail.js` and
`fn_list_response_tail.js`. `scripts/patch_nodered_communities_flow.mjs`
consumes both for future canonical generation. The legacy
`scripts/patch_nodered_community_summary_runtime.mjs` rejects a stale
canonical import that still sets only `msg.projection`.

For the reviewed live origin SHA-256
`70b9350fedee6b0ab8555d0a47ebcbeb2c7d43ec7a241e3e7fafa8e40750cbf1`,
`scripts/patch_live_community_summary_projection.mjs` checks fresh verified
live provenance and the exact node preimages. It changes only the two
function bodies above and writes a private candidate and redacted report
outside the repository. It does not import or deploy the candidate. The
candidate SHA-256 from this check is
`c1d4448876d4d202e845f79c3f83578cacfa4c07e6e10dd2010ea8b8923f7dac`.

To reproduce from a fresh live pull:

```bash
npm run nodered:modular:audit-147 -- /private/tmp/new-community-workspace --source-tab-label 'LK Communities'
node scripts/patch_live_community_summary_projection.mjs \
  --workspace /private/tmp/new-community-workspace \
  --output /private/tmp/new-community-candidate/candidate.flow.json \
  --report /private/tmp/new-community-candidate/report.json
```

The audit reads `/root/.node-red/flows.json` into the external workspace;
the candidate is another external file. The tracked legacy import
`node-red/lk_communities_nodes_import.json` and the live flow were not edited.
If the live function bodies or graph have changed, prepare a new reviewed
candidate from a fresh pull. Deployment requires its separate release gates.
