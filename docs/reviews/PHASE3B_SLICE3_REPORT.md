# Phase 3B slice 3 channel and BI checkpoint

2026-11-22 · `phase-3b/slice-3-channels` · base `ea19011` · Windows 11, Node 24.14.1, PowerShell 7

## Delivered

- Telegram uses the shared `ChannelTransport` contract and durable channel spool for new receives, replies and conversation lookups. A single transaction admits each batch and advances its checkpoint. Rejected updates retain a reason and omit private content. Account and event keys deduplicate receives. Account and effect keys deduplicate sends. Replies keep the admitted account, conversation and binding revision. Confirmed rate limits hold delivery on that account until the retry time, and unknown sends require owner review.
- The central registry seeds `telegram-main → main` and `telegram-bi → bi`. Startup uses the existing credential names, checks the original bot and owner fingerprint, and verifies the canonical bot identity with `getMe` before starting a poller. SQLite prevents two accounts from using the same provider identity. Accounts with historical work require their original owner fingerprint. A Telegram poll conflict stops repeated receives and leaves confirmed destinations available for queued delivery.
- Main and BI replies and channel status messages use each assistant’s reply locale. Model turns on Telegram include the locale instruction. The default is Traditional Chinese and English is also supported. The send adapter bounds Telegram JSON and attachment reads.
- Telegram SQLite advances from version 1 to 2, central Web SQLite from 3 to 4, and Knowledge SQLite from 2 to 3. The Telegram session ledger uses version 3. Migration preserves the legacy tables, Telegram cursor values, historical topic mappings, Main turn IDs, and outbound effect keys. It copies pending, completed, failed, interrupted and sent records with their original ordering and timing fields. A normal startup converts interrupted sends to indeterminate. Offline migration operates on local SQLite rows.
- Separate BI services handle intake, UTF-8 supplements, source lookup, and proposals. The channel receives only proposal operations. Owner approval and publication still use the existing paired review routes. Telegram BI supports `/status`, `/status <id>` and `/supplement <id> <text>`. Status and supplement check the source’s original account, topic and binding revision.
- BI ownership covers sources, jobs, reviews and published BI versions. Proven legacy Telegram reviews link to their original source and destination. Unproven legacy reviews use the legacy origin with an empty source and destination. The owner review API projects the `BI 資料處理` source for Telegram proposals. Publication keeps the review ID and intent in the same Knowledge transaction. Telegram deduplicates delivery using the existing review effect key and checks the saved destination against source ownership.
- Offline reconciliation hashes the named additions against the backup, checks the original tables and files, and validates cross-database conversation and BI links. Rollback summaries account for the initial spool projection and report subsequent work changes.

## Scope at 6d409fa

- The runtime uses the two built-in account slots. The account and binding revision schema supports the next round of account creation, reassignment, credential rotation and confirmed rebind work.
- The owner still sees the existing review and job views. The source label is available in the existing review API. Displaying it in the review view is pending.
- Review intents without a provable Telegram destination retain the historical BI-bot notification at its default topic. Telegram intake keeps its existing positive update ID namespace for compatibility with historical effect keys.
- The existing model seat coordinates model calls. The next dispatch work covers durable `agent_work_items` handoff, leases, dequeue priority and cross-database work reconciliation.
- This is the partial operational checkpoint allowed in the brief. The outstanding work follows the existing design.

## Test changes

- `tests/integration/telegram.test.ts` points the existing spool queries at the new columns and retains their state, count, timing, order and deduplication expectations. It adds rejected-payload checks, canonical identity conflict, polling conflict, provider receipts, both reply locales and a synthetic additional account at the spool level. It asserts that a queued reply stays with its original binding revision. BI checks cover topic-scoped status and supplement, forbidden channel publication, the review API source projection, owner review actions, and one publication notification to the original bot and topic across restart.
- `tests/integration/telegram-worker.ts` moves the existing fault injection to the new checkpoint and delivery tables so process death still exercises the transaction and the uncertain-send recovery path.
- `tests/fixtures/upgrade/phase3b.ts` adds completed, failed and in-progress work, interruption and sent history, a saved BI supplement, and a published manual BI review. The original pending and uncertain cases remain.
- `tests/contract/upgrade-allowlist.test.ts` extends named verification for the accounts, spool, source ownership, review provenance, publication ownership and rollback summaries. Wrong owners, missing conversations, swapped source links, and invalid JSON reject. Version assertions follow the new versions. The original historical row, workspace, grant, publication, and file integrity checks remain.
- `tests/contract/agent-ledger.test.ts` checks the added STRICT tables and faults partway through Knowledge ownership migration, and checks the retried database version. The existing pending-review assertion is scoped to its original review since the shared fixture now includes a separate approved review. The approved review has its own assertion.
- `tests/fixtures/upgrade/historical-knowledge.ts` keeps the historical candidate at version 1 by removing the new migration block in the generated fixture, preserving the old reader and same-version repair tests.
- `tests/e2e/knowledge.test.ts` seeds its synthetic owner-visible source and uncertain send in the tables the application now uses. The browser expectations are unchanged.
- `tests/e2e/upgrade-rollback.test.ts` updates the expected candidate versions and records new post-upgrade work in the operational spool. It still verifies the same original rollback rows, and it checks that the rollback summary reports the single newly queued effect.

## Remaining at 6d409fa

- Complete the pairing- and CSRF-protected `GET/POST /api/settings/channels` through account verification, creation, assignment, token rotation, confirmation, and conflict and busy-state reporting.
- Route additional verified accounts into the selected specialist’s scoped session and workspace. Add the binding admission lock for reconfiguration, drain pending work and sends, and exercise a full third specialist and busy-rebind test through the runtime. Use the planned UUID source keys for newly bound accounts that handle BI intake.
- Route direct and scheduled work through `agent_work_items` and verify direct → delegation → schedule priority without preempting active work. Add deduplicated cross-database handoff, lease recovery and queue expiry.
- Extend BI acceptance to use the authenticated HTTP review route within the synthetic Telegram scenario and assert the source label in the review view. The present Telegram scenario calls the same server review action and verifies the API projection.
- Later Web and delegation BI entry points, the settings GUI, and delegation itself retain their existing slice boundaries.

## Sequential verification at 6d409fa

Each command ran with a fresh temporary `OEP_DATA_DIR` and process-local Python settings from `oep-verify-venv/Scripts`. Telegram used loopback synthetic APIs.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.93 s. Checked 246 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.55 s. |
| `npm test` | Exit 0 in 8.40 s. 85 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 36.53 s. The release scan passed. ZIP SHA-256 `8f94df9de3154c82c351d75937b7d87a67ba4a9a3acbd0b5ccbb68c12ada8259`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 68.99 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 72.49 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 72.09 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:knowledge` | Exit 0 in 24.12 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 4.29 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 2.11 s. 7 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 54.04 s. Isolated MCP probes passed with verified Job cleanup. |
| `npm run test:compliance` | Exit 0 in 0.42 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 32.83 s. 1 passed, 0 failed, 0 skipped. Both builds reproduced the release SHA-256 above. |
| `npm run test:contract:native:isolation` | Exit 0 in 18.93 s. 5 passed, 0 failed, 0 skipped. Both pinned Jobs reported supervisor and child exit 0, with 0 orphans. |
| `npm run scan` | Exit 0 in 1.17 s. 569 files, 0 hits. |

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`.

## Slice 3b reviewer findings

Follow-up branch `phase-3b/slice-3b-channels` starts at `6d409fa`.

1. `TelegramInbox` changed the SQLite journaling mode before migration checked the version. The migration then threw a string the launcher did not recognize. The opener now checks `user_version` with a read-only SQLite connection before opening the writable handle, and reports exactly `Telegram資料庫版本比程式新。` for a future schema. The preflight uses a private WAL index so a version committed only in the WAL can be checked without updating any of the three SQLite files. The launcher reports a separate error for a negative version. [SQLite WAL](https://www.sqlite.org/wal.html) · [SQLite VFS](https://www.sqlite.org/vfs.html)
2. The historical upgrade test seeded a managed BI vault with review history and then imported the extended test snapshot into that same vault. The historical store threw `This vault requires a reviewed publication` before it reached `store.close()`. The open SQLite handle prevented Windows from deleting the fixture, masking the import error with `EPERM`. The extended import now uses a separate vault, and the historical store closes in a `finally` block.

| Isolated Windows reproduction | Before | After |
| --- | --- | --- |
| Future-schema subtest | 1 failed. The exception used an unrecognized message. A separate version-99 probe confirmed the DB bytes changed. | 1 passed. The exact launcher-compatible message matched, DB bytes were identical, and neither SQLite sidecar existed. |
| Future schema committed only in a crash-left WAL | A writable open could reject the version but checkpoint it on close, changing the database and removing both sidecars. | 1 passed. The exact message matched, and the database, WAL and SHM were byte-for-byte identical. |
| Upgrade and rollback scenario | 1 failed after 45.79 s. The diagnostic captured the managed-vault import error, followed by cleanup `EPERM`. | 1 passed after 408.94 s. Both normal cycles and all interrupted-swap, rollback and repair assertions completed, including fixture cleanup. |

The upgrade scenario used the same baseline release package before and after the fixture repair to isolate the cause. It ran from a scratch source copy with synthetic install and data roots under the fresh `OEP_DATA_DIR`. Only that copy replaced the machine-wide running-service checks with assertions on the isolated roots. The production guards and the owner's running service were outside this experiment.

## Delivered in slice 3b

- `GET /api/settings/channels` lists account bindings, reply locales and poll status. `POST` verifies a named User-scope credential with `getMe` and handles confirmed bind, unbind and rebind with a revision check. Both methods require pairing and CSRF. A duplicate provider identity or credential reference returns `CHANNEL_ACCOUNT_IN_USE` with the existing account and assistant.
- Send `x-oep-csrf` on both methods. A new binding uses `action: 'bind'`, `agentId`, `credentialRef` and `confirmed: true`. Updating an existing binding also uses `accountId` and the listed `bindingRevision`. A rebind may select another reference for the same bot and allowlisted owner.
- A verified additional bot using the chat handler routes to the assigned assistant's default workspace. The Telegram conversation and session ownership record the account, conversation, assistant and binding revision. The assistant's approved model and reply locale apply to each conversation.
- Settings commits and received batches share a binding admission lock. A confirmed change returns a busy response while the old revision has active runs, inbound work or pending sends. The old connection drains under its existing binding. On a successful change, polling resumes after identity verification and a stale poll response cannot advance the cursor. Late outbound effects use their stored revision and destination with the same verified bot and owner. Provider HTTP 409 stops polling for that connection and appears in the settings API.
- Credentials are read from Windows User scope with the same stdin-based helper as custom MCP. Requests, stored settings and backup credential inventories use reference names. Legacy owner seals and cursor keys remain valid for the original two bots.
- Authenticated `GET /api/knowledge/reviews` returns the Telegram BI source label, and approval and publication are exercised through the authenticated POST route. The known-origin publication returns to the original bot and topic. Unknown-origin historical review intents retain the original BI account's default topic `topic:0` and stable review effect key.

## Slice 3b test changes

- `tests/e2e/upgrade-rollback.test.ts` uses a distinct vault for the extended historical import so it still exercises a large, genuine version-1 index alongside the managed BI fixture. The store closes on every exit path. The future-schema assertion now checks Telegram's exact message and the absence of both sidecars. The added interrupted-WAL fixture verifies that the opener reads the committed future version and leaves all three files byte-identical. The existing checksum and reconciliation assertions are retained.
- `tests/integration/telegram.test.ts` replaces the direct review-action calls with equivalent HTTP approval and idempotent publication. It adds assertions for pairing, CSRF, pending review provenance and label, publication requiring approval, candidate visibility after publication and default-topic deduplication for unknown-origin intents. Existing known-origin delivery, retry and restart assertions are retained.
- The new three-bot integration case uses loopback Telegram and a synthetic OpenCode client. It covers both methods' authentication and CSRF requirements, rejection of inline credentials, a concurrent duplicate-bot claim through two credential references, stale and busy rebinds, a late poll response across the admission lock, credential rotation, separate session ownership and workspaces on the same topic, both reply locales, a delayed old-revision outbound effect, backup reference export, poll conflict reporting, unbind and restart without duplicate prompts or sends.
- The first sequential run reached `npm test` and reported one catalog contract failure. The contract parses literal property names, so the conflict code now uses a quoted key. The gate sequence restarted from lint after that correction and the WAL preflight change.

## Open after slice 3b

- Implement the persistent `agent_work_items` dispatcher for Web direct turns, channel inbound, BI intake and supplement, existing BI scheduler occurrences, and existing BI run and recovery entry points. It still needs direct → delegation → schedule priority, per-agent write leases with `lease_id` completion checks, expiry, stable cross-database handoff and recovery that retains indeterminate leases without replay. Add the dispatcher contract tests and the schema migration and reconciliation fixtures in the same change.
- Extend BI intake beyond the legacy BI account using UUID public source keys, negative internal IDs and per-account event deduplication. Bindings accept the chat handler for additional accounts. The legacy BI intake handler continues to work on the original account.
- Extend the existing owner-confirmed resend action to additional account IDs. Their uncertain sends already remain recorded as indeterminate.
- Slice 4 owns the review-source UI label and settings screens. Web and delegation BI acceptance remain with their entry-point slices.

## Slice 3b sequential verification

The implementation at `645dc44` passed the following sequence on Windows 11 with Node 24.14.1. Each gate received a fresh temporary `OEP_DATA_DIR` and process-local Python from `oep-verify-venv`. Telegram exercised loopback APIs with synthetic credentials.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.92 s. Checked 247 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.91 s. |
| `npm test` | Exit 0 in 11.60 s. 85 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 17.48 s. The ZIP scan passed. SHA-256 `2aa708bff2db4ce95de29d53e5ee09f264f4715e9d2f000c046d60fd5855178c`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 69.97 s. Supervisor and child exited 0 with 0 orphans. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 73.37 s. Supervisor and child exited 0 with 0 orphans. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 73.21 s. Supervisor and child exited 0 with 0 orphans. |
| `npm run test:e2e:knowledge` | Exit 0 in 26.27 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 4.17 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 36.85 s. 8 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 53.63 s. |
| `npm run test:compliance` | Exit 0 in 0.40 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 38.71 s. 1 passed, 0 failed, 0 skipped. Both builds reproduced the release SHA-256 above. |
| `npm run test:contract:native:isolation` | Exit 0 in 18.60 s. 5 passed, 0 failed, 0 skipped. Both native Jobs reported supervisor and child exit 0 with 0 orphans. |
| `npm run scan` | Exit 0 in 1.09 s. 570 files, 0 hits. |

Reviewer gates are `test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`.
