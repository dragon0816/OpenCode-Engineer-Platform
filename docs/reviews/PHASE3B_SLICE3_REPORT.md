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

## Scope checkpoint

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

## Remaining

- Complete the pairing- and CSRF-protected `GET/POST /api/settings/channels` through account verification, creation, assignment, token rotation, confirmation, and conflict and busy-state reporting.
- Route additional verified accounts into the selected specialist’s scoped session and workspace. Add the binding admission lock for reconfiguration, drain pending work and sends, and exercise a full third specialist and busy-rebind test through the runtime. Use the planned UUID source keys for newly bound accounts that handle BI intake.
- Route direct and scheduled work through `agent_work_items` and verify direct → delegation → schedule priority without preempting active work. Add deduplicated cross-database handoff, lease recovery and queue expiry.
- Extend BI acceptance to use the authenticated HTTP review route within the synthetic Telegram scenario and assert the source label in the review view. The present Telegram scenario calls the same server review action and verifies the API projection.
- Later Web and delegation BI entry points, the settings GUI, and delegation itself retain their existing slice boundaries.

## Sequential verification

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
