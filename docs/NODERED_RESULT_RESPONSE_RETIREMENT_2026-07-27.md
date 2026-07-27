# Result-response orphan retirement — 2026-07-27

## Evidence

Fresh production workspace from `lk-primary-147`:

- flow SHA256: `d9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c`;
- node count: `4617`;
- nodes named `Write result response`: `0`;
- nodes containing the retired source body: `0`;
- nodes containing `fn_write_result_response`: `0`.

The former tracked source body SHA was
`0fc907fe169a73302aea9d6910fa5d63b61f34638b887ec2c954645b29707933`.
Repository search found no runtime or patcher reference; only stale
documentation listed the file.

## Decision

`scripts/nodered_games_nodes/fn_write_result_response.js` is removed from Git
and from the Node-RED source catalog. This is a source retirement only: no
flow import, deployment, restart, or data mutation is performed.

If a result-response change is needed later, first locate the active live
result route and derive a new node-specific source/guard from its fresh flow.
