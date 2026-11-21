# Phase 3b publish and recovery

Use an OEP data directory with a writable knowledge database. Back it up before enabling review writes. The migrations create additive tables and retain the Phase 3a database and snapshot format.

## Local workflow

1. Open Knowledge, then BI Ingest and Review or Wiki Review. Install a schema with a vault ID and version. BI schemas require a list of fields. Wiki schemas use an empty list.
2. Load a UTF-8 text or Markdown file into the generated draft. Check the original, Markdown, card fields, relationships and evidence ranges. Ranges are half-open UTF-16 offsets in the Markdown. One or more valid excerpts are required for every BI field. Content and excerpts have separate SHA-256 digests. Model use defaults to off. An explicit `allowModel: true` in the draft enables Ask for the published version.
3. Submit, inspect the previous and candidate versions and save any edits. Approval and rejection use the saved edit number. A Wiki draft can be searched locally or discarded. BI immediate submission and Run Now use the same 30-second claim. After an interrupted claim expires, refresh and select Run Now.
4. Approve, then publish. Rolling back a current review revision restores its recorded predecessor. Rolling back the first revision removes the active pointer. Retained revisions stay readable by identifier in the store. Replaying a publish after rollback returns its earlier result without activating it.

The review candidate describes a full vault revision. Include all cards, relationships and source material intended for that revision. A competing publication changes the base and requires a new candidate. A schema update invalidates candidates carrying the previous digest.

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
