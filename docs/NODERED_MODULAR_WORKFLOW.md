# Node-RED live workspace audit

## Scope

This first stabilization cohort provides a read-only workflow for inspecting
the current Node-RED flow from production. It never patches, imports, deploys,
restarts, or exports a release payload.

The only accepted live origin is:

```text
root@lk-primary-147:/root/.node-red/flows.json (SSH port 22)
```

Raw flows, generated modular flows, validation reports, and origin metadata
must stay in a new absolute workspace outside the repository. The repository
ignores `node-red/modular/` defensively, but the commands also reject any
workspace inside the repository.

## One-command read-only audit

Choose exactly one enabled source tab by its exact label or ID:

```bash
npm run nodered:modular:audit-147 -- \
  /private/tmp/lk-nodered-audit-YYYYMMDD \
  --source-tab-label "LK Tournaments"
```

or:

```bash
npm run nodered:modular:audit-147 -- \
  /private/tmp/lk-nodered-audit-YYYYMMDD \
  --source-tab-id "<exact-tab-id>"
```

The workspace must not already exist. The command:

1. copies the exact live flow over SSH without changing the server;
2. records redacted origin metadata next to the source;
3. verifies origin, SHA256, JSON shape, unique IDs, private permissions, and
   pull freshness of at most 30 minutes;
4. extracts only nodes from the selected tab without changing their bodies;
5. excludes the source tab node, all other tabs, and all config nodes;
6. validates node IDs and bodies, wires, links, and HTTP inputs;
7. atomically publishes the local `build/` directory only after validation.

Successful output contains hashes and counts only. The workspace layout is:

```text
<workspace>/                 mode 0700
  input/                     mode 0700
    source.flow.json         mode 0600
    source.flow.meta.json    mode 0600
  build/                     mode 0700
    selected-tab.nodes.json mode 0600
    validation.json          mode 0600
```

Symlink and hardlink aliases are rejected. Existing or partial build outputs
are rejected rather than overwritten.

## Individual gates

```bash
npm run nodered:modular:pull-147 -- /absolute/new/external/workspace
npm run nodered:modular:verify -- --workspace /absolute/external/workspace
npm run nodered:modular:build -- \
  --workspace /absolute/external/workspace \
  --source-tab-label "LK Tournaments"
npm run nodered:modular:validate -- \
  --workspace /absolute/external/workspace \
  --source-tab-label "LK Tournaments"
```

## Deliberately not restored

The old wide `sync-games-source`, `prepare-147`, and `exports` commands remain
quarantined. Their patch chains and generated imports are not part of this
cohort and must not be run against a fresh live pull. A later recovery cohort
may add node-specific candidate construction after every patcher has relative
paths, exact preimage guards, focused tests, and a separate explicit deploy
approval.
