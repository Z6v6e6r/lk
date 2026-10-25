# Remaining fallback media aliases — 2026-10-25

Status: source fix prepared; no production data change, import, restart or deploy.

Read-only investigation resolved the three previously unknown fields to one
community's original/thumb legacy aliases on the configured LK fallback origin.
The origin matched tracked topology and the installed public SERV2_FALLBACK by
hash comparison, without exporting record identifiers or URLs. Both original
and thumb endpoints return 404 / `Legacy logo not found` on the primary and the
approved fallback. The aliases match the same record ID; image backing data is
missing, rather than the community itself being absent.

The installed resolver recognized the response authority and two public hosts,
but treated the known fallback as an arbitrary external origin. That bypassed
its existing backing-data guard. Add only the exact configured fallback host to
that guard; no general external-host trust or network probing is added. A self
alias with absent/malformed backing resolves to null, allowing the existing UI
placeholder. Valid backing, modern assets, unrelated record IDs and arbitrary
foreign hosts retain their behavior. This does not recover missing image bytes.

The canonical helper is shared by source-generated community responses. Future
release preparation must read fresh live hashes and replace only the reviewed
helper in the community-list response (`9ec08e9a627fa3e2`) for the observed public
summary case. Do not regenerate/import a broad flow or modify stored records.
Other live response helpers require their own preimage/endpoint acceptance.

Regression checks cover the exact fallback authority, original/thumb priority,
malformed data, lookalikes, userinfo, ports, foreign records and modern assets.
Evidence is aggregate only; no raw logs, IDs, body, credentials or flow exported.
