# LK1 Mongo read optimization

## Read-only evidence (30 September 2026)

The active Node-RED source was copied from `lk-primary-147` to a private external
workspace and checked without importing it. It contained 4,804 nodes. The
installed `node-red-contrib-mongodb4` version is 3.4.0: `find` takes operation
arguments from `msg.payload` (an array becomes positional arguments). Setting
`msg.sort` or `msg.limit` does not configure its cursor.

The `games` database index catalog and bounded `executionStats` probes showed:

| Collection/read | Documents | Existing plan | Source change |
| --- | ---: | --- | --- |
| `lk_games` public date/station | 19,007 at the prior audit | `lk_games_public_date_station_v1` already exists | None |
| `chat_messages` by game/time | 4,697 | `COLLSCAN` + `SORT`, 4,697 examined for 9 returned | `find` sort/limit + 1 |
| `support_messages` by dialog/time | 26,570 | Existing `dialogId_1_createdAt_1` gave `IXSCAN`, 4 examined for 4 returned | Use stored `createdAt`, sort/limit + 1 |
| `support_messages` daily | 26,570 | `COLLSCAN`, 26,570 examined for 83 returned | Use stored `createdAt` |
| `lk_community_feed` by community/time | 25,959 | `COLLSCAN` + `SORT`, 25,959 examined for 1 returned | Index proposal only |

All 26,570 support messages had ISO UTC `createdAt`; none had `createdTs`.
The old daily analytics filter on `createdTs` therefore missed those records.
The proposed query uses ISO `createdAt` bounds for the requested Moscow day.

The `lk_community_feed` collection had 2,262 documents without `createdTs`.
The community feed response derives their time from `createdAt`, so pushing
`limit` into MongoDB before normalizing legacy data would change pagination.
The feed index can narrow the community query, but this change deliberately
keeps its existing response sorting and limit. The `lk_community_chat_messages`
collection had only 191 documents; an extra index there was not justified by
the observed size and request evidence.

## Prepared changes

The guarded candidate builder updates exactly these existing function nodes:

- `LK Games`: `Build chat messages query` (`1dbd5de98e73a04c`).
- `LK Support`: `Support dialog messages prepare` (`5a9da5699137937c`).
- `LK Support`: `Support analytics daily prepare` (`f435ae81f62cdc4f`).

It requires a fresh verified external live-flow workspace, checks each node's
preimage, tab, wires, output count and Mongo binding, and writes the full
candidate only to a new private directory under `/private/tmp`. It never imports
or restarts Node-RED. With the 30 September source SHA
`d9764f7b6a883a644ee319a6fed44c1b087e701d030aef2c7d7c718751840087`,
the local candidate changed only those three `func` fields.
Its SHA-256 was
`4e6c2aba580cb22a4e4b556cdc193f4c1c4e903ad3800fb30714903b1cf335a3`.

```bash
node scripts/prepare_lk1_mongo_read_candidate.mjs \
  --workspace /private/tmp/<fresh-verified-live-workspace> \
  --output-dir /private/tmp/<new-private-candidate-directory>
```

The index manager proposes only these indexes, after comparing exact keys and
names with the current catalog:

- `chat_messages`: `{ gameId: 1, createdTs: -1 }`.
- `support_messages`: `{ createdAt: 1 }`.
- `lk_community_feed`: `{ communityId: 1, createdTs: -1 }`.

```bash
node scripts/manage_lk1_read_indexes.mjs plan \
  --workspace /private/tmp/<fresh-verified-live-workspace>
```

The script checks the exact MongoDB config, URI host and three read-node
bindings. `apply` additionally requires a verified live-origin workspace no
older than 30 minutes. A matching or equivalent index is not recreated. A name/key/options conflict
stops the plan. Apply requires a fresh exact `planDigest`, a new private receipt
path and `LK1_READ_INDEX_APPLY=APPLY_LK1_READ_INDEXES_V1`. It journals each
pending index operation and catalog readback; an interrupted or failed apply
requires manual catalog reconciliation before retry. No production index apply
was authorized or run for this change.

## Activation and recovery

1. Review the task branch and CI. Re-pull the live flow and rebuild the guarded
   candidate; stop on preimage or binding drift.
2. Run the index plan against that same current binding. Review the exact
   catalog, plan digest, collection sizes and bounded `explain` for each query.
3. Obtain separate authorization for the exact production indexes and Node-RED
   import. Create the indexes first, read back their exact definitions and
   require `IXSCAN` with materially fewer examined documents.
4. Import the reviewed candidate through the normal Node-RED release process.
   Check chat pagination, support history, analytics, API error rate, Node-RED
   RSS/event-loop lag and Mongo query plans before and after under comparable
   traffic.
5. If the flow causes a regression, restore the exact preimage flow through the
   authorized rollback process. Indexes need no immediate drop for a flow
   rollback; any index drop must be separately authorized and must verify the
   managed name/key and current catalog before removal.

The public game index already present on the server and the index proposal here
do not address date-less game scans, polling frequency, or the legacy feed
timestamp migration. Those need separate measurements and changes.
