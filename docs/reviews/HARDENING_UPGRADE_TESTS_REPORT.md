# Upgrade and test hardening

2026-11-22 · `hardening/upgrade-and-tests` · Windows 11 x64, Node 24.14.1, PowerShell 7.6.10.

## Delivered and root causes

| Item | Root cause | Change and evidence |
| --- | --- | --- |
| A | The upgrade test created WebStore data from the candidate schema, so the reconciler never encountered the model tables as additions. | The fixture uses the SQLite DDL produced by opening WebStore from `6c280d49da1a646523e08e33e1a87f1e2c25912f` and adds one synthetic run, event, and session. The full upgrade test seeds its database from that fixture, then requires `資料比對通過` and confirms the two migrated tables were absent before and empty after. Building a second historical release would add another build and upstream dependency acquisition to the gate. The candidate build alone took 44.4 seconds here. The fixture replaces the existing seed step, and the standalone copy, describe, migrate, and reconcile test took 323 ms. |
| B | Recovering the data and current pointer left the failed release directory behind. The next package reused the version string, so verification treated its changed file contents as corruption. | A prepared journal records whether the destination was absent. Rollback restores the previous data, version pointer, and launch entries, then removes only a newly staged version whose manifest and files match the journal. A verified directory is atomically moved to a journal-specific name before recursive removal, so interrupted cleanup resumes safely. A mismatching existing version is refused before backup or stopping the launcher, with directions for the owner to check shortcuts and scheduled tasks and move it aside. This also covers folders left by older maintenance scripts. |
| C | Snapshot code classified arbitrary files by their SQLite header. PowerShell discarded Node diagnostics and emitted a generic error. | Snapshot and restore compare SQLite metadata for fixed OEP paths. Other files, including foreign SQLite sidecars, are copied and hashed as bytes. Older backup manifests can carry metadata for additional files, whose integrity remains covered by the file inventory. Snapshot, migration, verification, and rollback surface the failing check and relative path. The same diagnostic is written to the maintenance log and, when present and writable, the upgrade journal. Raw Node and PowerShell exception text stays out of these logs. |
| D | Direct tests used the production `dataDirectory()` fallback when `OEP_DATA_DIR` was absent. | A preloader guards every npm `test:*` script, and direct e2e entry points share the same guard before allocating data. The guard checks existing ancestors to resolve junctions even for a new child directory. The plain `npm test` suite uses deliberate scratch paths and is exempt. |
| E | The probe could publish its result before the supervisor validated Job membership. The caller then requested stop, which let the worker or probe exit before that validation. PID handle acquisition could also race with short-lived descendants. | With supervisor stderr temporarily enabled, 1 of 5 baseline probe runs failed on the missing-executable case. PowerShell reported `OpenCode Job membership failed.` and the test received `無法確認測試程序已結束。`. The probe now waits for readiness, and the supervisor uses Windows Job accounting to confirm that the terminated Job has zero active members. The existing reason and cleanup checks remain in force. Instrumentation was removed before committing. |

The operations guide now includes failed-upgrade recovery and test isolation. The task list records implementation and reviewer gates, and the dated decisions entry records the alternatives considered. [Operations](../OPERATIONS.md) · [Tasks](../TASKS.md) · [Decisions](../DECISIONS.md#2026-11-22-升級與測試的隔離及復原)

## Regression verification

Temporarily removed the two model-table names added by `2ba79ba` and ran only the new cross-schema test. It failed at the actual reconciliation command with exit 1 and `【web/web.sqlite】升級比對失敗。新增的資料表含有資料或未列入允許清單。`. Both the new cross-schema test and the original allowlist contract passed after restoring the entries.

## Test changes

- `upgrade-allowlist.test.ts` invokes backup snapshot, migration and upgrade reconciliation against the pre-model schema. It checks all three seeded row counts and the absence and creation of the two model tables.
- `upgrade-rollback.test.ts` seeds the Web database from the same SQL fixture, replacing the candidate WebStore constructor and retaining the same three seed rows. It requires the upgrade success text, verifies journal migration counts, exercises refusal for a stale target, checks the current pointer and version file, and asserts that failed staged versions are removed on rollback.
- `upgrade-version-folders.test.ts` exercises maintenance functions with tiny synthetic releases, isolated install and data roots, and a private maintenance mutex. It checks stale-target refusal, preservation of the current version, restoration of prior data, and removal of the newly staged failed release.
- `data-snapshot.test.ts` verifies byte-for-byte copying and inventory hashes for an unreadable-as-SQLite file in an unknown directory and its sidecar. It covers older inventories and invalid manifest structure. It checks relative-path diagnostics for a corrupt OEP database and a locked temporary file in the console and applicable journals.
- `backup-restore.test.ts` moves the existing synthetic WAL fixture from `synthetic.sqlite` to the owned `runs.sqlite` path. The count, concurrent write, tamper, and restore assertions remain identical in intent. Foreign database behavior is exercised in the snapshot contract.
- `test-data-guard.test.ts` verifies missing, relative, default, nested default and junction-redirected paths, checks that all npm `test:*` commands have the preloader, and checks an early abort for a direct e2e command. The custom MCP, knowledge, native contract, SOP-to-Excel, SSE recovery, web HTTP, web browser, and Windows launcher entry points now use a guarded data-directory allocator. The maintenance fixture and launch bridge validate the same root before allocating or accessing test data.
- The five existing custom MCP probe outcomes and all e2e MCP assertions were retained. All existing assertions remain in force.

## Verification results

The required commands ran sequentially with a fresh `OEP_DATA_DIR` for each. Python used the provided verification venv through process-local environment settings.

| Command | Result |
| --- | --- |
| `npm run lint` | Exit 0. `Checked 213 source and configuration files.` |
| `npm run typecheck` | Exit 0. `tsc --noEmit` completed without diagnostics. |
| `npm test` | Exit 0. 68 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0. Produced `OEP-0.0.0-windows-x64.zip` and reported `敏感資料掃描通過。` The final rebuild took 16.9 s and matched the determinism hash. |
| `npm run test:e2e:browser` | 3/3 passed. Child exit 0 and 0 orphans on every run. Wall times 57.7, 60.9, and 61.1 s. |
| `npm run test:e2e:knowledge` | 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | 5 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | 10/10 passed in sequence. Every run printed `Isolated MCP probes passed with verified Job cleanup.` Wall times 52.4, 51.0, 50.8, 50.7, 50.7, 51.2, 51.0, 51.7, 50.6, and 50.9 s. |
| `npm run test:compliance` | 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | 1 passed, 0 failed, 0 skipped. Both ZIP builds had SHA-256 `53c2c50a7192ee9ec223b224ad84b61e7c3f435c957563aa072275c9bb153964`. |
| `npm run scan` | Exit 0. 527 files, 0 hits. |

Lint, typecheck, `npm test`, and the release build passed again after the final maintenance diagnostics and the packaged operations guide were updated.

## Left for reviewer

- Run `test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup` after stopping OEP on the review machine. These commands were left for review while the owner's OEP 0.2.1 was running. The full packaged upgrade gate and its duration remain unverified here.
- The historical release build and install were omitted in favor of the pinned, generated SQL fixture.
- A journal write requires a validated writable root. When that is unavailable or under `-WhatIf`, diagnostics are shown on the console.
