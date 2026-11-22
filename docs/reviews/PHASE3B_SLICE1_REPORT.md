# Phase 3B slice 1 assistant ledger and migration

2026-11-22 · `phase-3b/slice-1-agent-ledger` · Windows 11 x64, Node 24.14.1, PowerShell 7.6.10.

## Delivered

- `web.sqlite` has the STRICT assistant, workspace, grants, trigger settings, classification and delegation budget tables. Main is the sole active orchestrator. The built-in BI specialist has a fixed identity and a managed root at `web/agents/bi/`. An ordinary specialist can archive once its linked Web runs are terminal. SQLite preserves its session history and rejects deletions that would orphan references.
- Both session databases reach `user_version=3`. Existing sessions, including hidden and unbound sessions, keep their IDs and paths. Main inherits the saved profile and avatar. A null agent model follows the existing global default. The old preference, project-folder and MCP APIs also write their ledger counterparts. Telegram passes its existing topic to the ownership insert when it creates a session. Current routing and the two-project UI still use their original tables.
- `knowledge.sqlite` reaches `user_version=2` with empty vault classifications. Main receives grants for the installed, active publications at migration time even when the Web toolbox is off. An active configured BI target supplies BI's read and proposal-only grants. Legacy BI jobs, reviews, publications, notifications, blobs and Telegram spool entries keep their existing rows.
- Each schema and its seed rows commit in one transaction per database. The runner initializes a missing central Web database when an existing Telegram session database needs it. An empty maintenance root is a no-op and the runtime initializes fresh stores on first use.
- The candidate release verifies seeded rows against the backup using counts and hashes. It checks workspace and vault references, specified empty additions, historical column values, publication metadata, and the original file hashes. The historical fixture uses DDL captured from `6c511e6`, whose schema matches `db4ff99`.

## Slice boundaries and implementation choices

- Telegram chat ownership uses the reserved `telegram-main` identifier, binding revision 1 and `topic:<number>` from the old topic map. A historically unbound session uses `legacy-session:<session-id>` so it retains a stable owner without creating a routable topic.
- Built-in seed timestamps are 0 and the starting configuration revision is 1. The original API defaults supply Main's empty text fields when no preferences exist. SQLite checks avatar pairing, MIME and byte limits. The existing image parser also checks PNG/JPEG dimensions at migration and at the settings API.
- The stored delegation defaults are 3 delegations per message, 300,000 ms, 10 model requests and 30 tool calls per delegation, 30 model requests and 90 tool calls per message, and a 600,000 ms queue timeout.
- `telegram.sqlite` stays at version 1. Its cursor, binding, inbox, outbox, BI source and schedule tables remain the current operational records. Channel accounts and spool migration, BI source/job/review/publication ownership, provenance and enabled-channel archive checks require the slice 3 schemas. Session ownership can be verified against the central workspace ledger with the existing topic map.

The implementation follows the approved slice 1 boundaries.

## Remaining work

- Later slices cover execution isolation and routing, channel and BI ownership, the assistant API and UI, delegation execution and budget enforcement, classification enforcement, and results and notifications.

## Test changes

- `tests/contract/agent-ledger.test.ts` covers fresh schemas, built-in identity including SQLite replacement, specialist archival with and without open work, retained history, STRICT types, workspace ownership, classifications and editable budget storage. It also checks legacy writes, inactive vaults, startup ownership checks, and faults during Web, Telegram chat and knowledge migration. Each fault verifies rollback of its database and confirms that a retry resumes after earlier commits.
- `tests/contract/upgrade-allowlist.test.ts` retains the original Web table coverage and pre-model migration assertions. The coverage assertion now recognizes tables with independently hashed seed rows as well as empty additions. The new multi-database case checks twice-run migration, missing ownership, wrong Web workspace, wrong Telegram owner, an unknown nonempty table and a one-byte attachment change. Another case checks the exact path and seed expectations when migration creates a missing central store.
- `tests/fixtures/upgrade/phase3b*.sql` and `phase3b.ts` provide one historical fixture for contract and packaged upgrade tests. It includes both projects, a hidden session, runs, attachment and preview bytes, an artifact, original Telegram mapping and spool states, a pending BI review and an indexed publication.
- `tests/e2e/upgrade-rollback.test.ts` shares the multi-database fixture and retains the pre-model fixture at the historical root path. The candidate ZIP uses the real version 2 knowledge migration. The source-text assertion now checks the version guard and migration in the candidate store so the test can assemble a version 1 reader and writer for the previous ZIP. This preserves the old-reader rejection assertion and works with shallow checkouts. The exact restored Main outbox assertion is scoped to Main because the shared fixture adds another bot. A new assertion verifies the BI outbox entry and its uncertain delivery state. Backup hashes, repeated upgrade and rollback, failure recovery, interrupted swaps, stale targets and same-version repair retain their assertions.

## Sequential verification

Each command ran with a separate temporary `OEP_DATA_DIR` outside the owner data directory and process-local verification Python settings.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0. Checked 220 source and configuration files. |
| `npm run typecheck` | Exit 0. `tsc --noEmit` completed without diagnostics. |
| `npm test` | 75 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 46.0 s. Built `OEP-0.0.0-windows-x64.zip` with SHA-256 `69cff3b4743b571f32b9bb299b3d8b949ae7b4da3ebf41b9dec3e7ecb598d20c`. Release scan passed. |
| `npm run test:e2e:browser` (three runs) | Exit 0 in 61.53, 64.49 and 65.33 s. Every run reported `childExit: 0` and `orphans: 0`. |
| `npm run test:e2e:knowledge` | 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | 5 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 52.92 s. `Isolated MCP probes passed with verified Job cleanup.` |
| `npm run test:compliance` | 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | 1 passed, 0 failed, 0 skipped. Both builds matched the release SHA-256 above. |
| `npm run scan` | Exit 0. 537 files, 0 hits. |

Lint, typecheck and the 75-test suite passed again after the packaged test fixture adjustment.

## Same-version repair follow-up

`phase-3b/slice-1-fix` starts at `6583a0f` and merges `main` at `9e1db75`. The reviewer reproduced the failure in packaged `test:upgrade` at `Upgrade-OEP -AllowSameVersion` after the cross-version upgrade and rollback cases. The historical fixture ZIP deliberately uses the version 1 knowledge reader and writer. Repair ran that candidate's migration, which correctly left the restored `web/knowledge.sqlite` at version 1. The same ZIP carried the current reconciler with a hard-coded version 2 target, so it rejected the database and triggered automatic rollback.

Commit `67f2b5f` shares the candidate's migration definitions between the offline runner and reconciler. Each owned database's expected version comes from its store. Reconciliation reads the actual SQLite `user_version` and requires exact equality with that target. The reported migration result remains available in the journal for diagnostics. Slice-specific checks use the actual transition to verify seeded rows and new tables.

The packaged and isolated tests now share the historical knowledge store fixture. The source assertion checks the named version guard and the version 2 migration target because the guard now reads the candidate's version declaration. The packaged test still asserts that the historical reader rejects the migrated version 2 database. It also asserts that the repair commits with version 1 before and after, and that automatic rollback restores the previous installation and data when a candidate reports version 2 but leaves the live database at version 1.

In the isolated test, the same candidate migration and reconciliation commands used by `Upgrade-OEP` run against a temporary candidate, backup and data root. Before the fix, the test failed at the reconciliation command with `【web/knowledge.sqlite】升級比對失敗。SQLite user_version 與新版不符。` and exit code 1. After the fix, the version 1 repair case passes and rejects a live version 2. The cross-version contract also rejects a stale live version 1 against a version 2 candidate.

### Follow-up gates

The commands ran sequentially with a fresh temporary `OEP_DATA_DIR` per command and the verification Python configured for the test process.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.91 s. Checked 222 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.82 s. `tsc --noEmit` completed without diagnostics. |
| `npm test` | 76 passed, 0 failed, 0 skipped in 7.82 s. Includes fresh stores and per-database migration rollback. |
| `npm run build:release` | Exit 0 in 43.36 s. Built `OEP-0.0.0-windows-x64.zip` with SHA-256 `c67b3c70e370dfc7ea566b899c234cd98ec746bf7e2b949f020795f475fa390a`. Release scan passed. |
| `npm run test:e2e:browser` | One run, exit 0 in 66.36 s. `supervisorExit: 0`, `childExit: 0`, `orphans: 0`. |
| `npm run test:release:determinism` | 1 passed, 0 failed, 0 skipped in 36.63 s. Both builds matched the release SHA-256 above. |
| `npm run scan` | Exit 0 in 1.08 s. 540 files, 0 hits. |
| `node --disable-warning=ExperimentalWarning --test tests/contract/upgrade-allowlist.test.ts` | 5 passed, 0 failed, 0 skipped in 5.01 s. Includes the same-version reproduction and both wrong-version rejections. |

### Left for reviewer

The maintenance fixture uses separate install and data roots. `Stopped-OEP` checks processes machine-wide and uses the standard runtime mutex. Its process filter matched three live processes, so the isolated regression invoked the candidate's Node entry points directly. The browser gate used its own test runtime mutex.

Run `npm run test:upgrade` with the maintenance guard clear to verify the packaged install, cross-version upgrade, same-version repair, automatic rollback on migration and reconciliation failure, and interrupted swap recovery. `npm run test:install` covers the separate fresh-install suite. The reviewer's prior passes for `test:backup`, `test:e2e:web` and `test:e2e:excel` apply to the pre-fix merge.
