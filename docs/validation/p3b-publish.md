# Phase 3b publish and recovery

Use an OEP data directory with a writable knowledge database. Back it up before enabling review writes. The migrations create additive tables and retain the Phase 3a database and snapshot format.

## Local workflow

1. Open Knowledge, then BI Ingest and Review or Wiki Review. Select a visible vault by ID and load it. To start a new vault, install a schema with an ID and version. BI schemas require field names. Wiki schemas use an empty list.
2. Select a UTF-8 text or Markdown file, or paste text, and load the source preview. Add a card or change or remove an existing card. For each field of an added or updated card, enter the value and select or paste its exact source quote. The form computes the half-open UTF-16 offsets. Wiki form drafts support one source excerpt of up to 4,000 UTF-16 code units.
3. Submit the changes, compare the card and field counts, read the old and new values and inspect changed evidence. Approve the saved draft before publishing. The advanced fold provides JSON submission and draft edits. Wiki drafts can be searched and discarded. Legacy full BI submissions use the existing 30-second job claim and Run Now recovery.
4. Rollback restores the recorded predecessor. Rolling back a first publication deactivates the vault, preserving its pointer, revisions, blobs, and review record. Ask reports `vault-unavailable`. Publish another approved revision or choose 重新啟用 on the deactivated review. Replaying the first publish keeps its original result and leaves the vault inactive.

### Source upload and changes

- `POST /api/knowledge/review-sources` accepts a raw `application/octet-stream` body of 1 byte to 1 MiB, with `Content-Length` and `X-OEP-SHA256` (lowercase hexadecimal). The adapter requires the local session and CSRF token. The server checks the digest and valid UTF-8, then stores the blob by digest. Identical uploads reuse the blob. Uploads are retained in the local database and count toward its size.
- Send `action: stage-change` to the existing review endpoint with a unique review ID and a draft containing `vault`, `parent` (active revision or null), `schema` (review schema SHA-256), `addCards`, `updateCards`, `removeCards`, `sources`, `evidence`, and `relationships`. Source entries reference uploads by `id`, `ref`, and `sha256`. Evidence supplies `sourceId`, `cardId`, `field`, `start`, and `end`. Each passage remains limited to 4,000 UTF-16 code units.
- The server applies the change set to the recorded parent. Updated cards replace their fields and evidence. Added evidence can also extend a retained card. Removing a card removes its passages and incident relationships. An untouched card retains its existing verified metadata and evidence exactly as published. New and replaced cards must supply evidence for every required field. Relationships in the change set add edges.
- The 128 KiB JSON request limit still applies to metadata. The legacy full-revision `stage` API still accepts inline sources and retains its 100,000-code-unit per-source limit. A competing publication invalidates the staged parent. Installing another review schema invalidates drafts carrying the prior digest.
- Imported BI vaults without a review schema use the source schema field list when present, or the union of published card field names. Install a review schema if the imported vault lacks usable field names or needs a different set. Published Ask model permission is independent of proposal availability.

### Model proposals

Choose 產生模型提案 explicitly on an active BI vault after loading a source up to 24,000 UTF-8 bytes. The source text leaves this machine through the LAN HTTP Gateway. The model proposes one card with an exact quote per required field. If any required quote fails exact matching, the server lists the affected fields and creates no review. A valid proposal creates a pending change set and follows the regular approval and publication process.

## Reconciliation

The authenticated review endpoint lists edit numbers, decisions, recorded publications, BI jobs and effects, and notification intents. SQLite keeps the original draft and each saved edit. Confirm one effect for each completed BI job and one durable intent for each published review. The intent is an outbox row committed with the publication. Delivery is outside this phase.

| Injection | Active after process death | Revision rows after replay | Intents after replay |
|---|---|---|---|
| Before blob write | Previous pointer or empty | One new revision | One |
| After indexing and before pointer update | Previous pointer or empty | One new revision | One |
| After commit and before delivery | New pointer | One new revision | One |

`npm run test:ingest` exits each publisher subprocess at the selected point, reopens the database read-only, verifies Ask visibility, then starts ten independent publisher processes. It checks publication row counts and SQLite integrity. A separate lease test forces expiry and verifies that a stale claim cannot complete.

## Synthetic version comparison

| Attribute | First revision | Second revision | After rollback |
|---|---|---|---|
| Approved Markdown excerpt | Synthetic calibration uses amber. | Synthetic calibration uses violet. | Amber excerpt |
| Source hash | Original amber source | Original green source retained | First source hash |
| Markdown revision | Hash of amber Markdown | Hash of edited violet Markdown | First Markdown hash |
| Active pointer | First review revision | Second revision with first as parent | First review revision |
| Intent count | 1 | 2 | 2 |

To recover a database backup, stop the OEP runtime and any ingress first. Preserve a consistent SQLite backup with the staging and job tables. Restore in the OEP data directory, restart with the matching application version, then check the transaction and ledger counts before resuming intake.

AEP SQLite 8, 9 and 14 are normalized in memory through the existing source reader. Version 8 may omit `evidence.assessment`. Empty optional tables are valid. Unknown SQLite schema versions reject. OEP writes reviewed snapshots to its own data directory.
