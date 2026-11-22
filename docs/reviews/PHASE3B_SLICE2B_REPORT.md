# Phase 3B slice 2b controlled files and knowledge

2026-11-22 · `phase-3b/slice-2b-files-knowledge` · base `3e4cb241be9506730a464198764be53f5a62d843` · Windows 11 x64, Node 24.14.1, PowerShell 7.

## Delivered

- The profiled launcher registers one OEP broker for status, file reads and writes, scoped knowledge, and eligible remote HTTPS tools. It uses Slice 2a's SSE relay, live scope checks, and one-time tickets. The profiled runtime always enables the broker, including in the packaged build. The former `OEP_SYNTHETIC_STATUS_TOOL` toggle is retired.
- Controlled reads resolve opaque IDs through the current session's attachment and artifact records. Relative output reads require the current run's manifest and verify the stored file identity and SHA-256. The model supplies a canonical lower-case filename for new UTF-8 output of up to 64 KiB. A failed publication without a verified manifest stays inaccessible to the broker.
- Node's path checks remain in use for file verification and project folder imports. The Windows helper opens each path component relative to a pinned directory handle, denies delete sharing on ancestors, creates staging files exclusively, verifies the file type, link count and final path by handle, and renames within the pinned directory without replacing an existing entry. The worker verifies an exclusive destination using the filesystem's case-insensitive name checks. [Windows file rename information](https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
- Workbook uses the broker to publish `workbook.json` and converts the verified bytes into the existing XLSX. The managed permission builder has no native write grant for any origin. The separate Phase 1 acceptance runner retains its pinned native Workbook probe so the reviewer can exercise its original contract.
- Web `/ask`, Telegram `/ask` and `oep_knowledge_ask` use the same scoped KnowledgeAsk path. It checks the agent's vault binding and workspace membership, selects the approved model for the session or Main channel, verifies citations against the active publication, and rechecks publication and model consent before releasing the answer. Owner Q&A and publication controls use their existing paths. New imports remain available on the owner page and require an agent binding before assistant queries.
- Local stdio and private-network MCP definitions retain their settings and explicit connection test. Their settings cards show a pause notice in both locales. Eligible HTTPS tools use the existing pinned transport and reject redirects. The broker verifies each advertised tool name and argument schema, intersects the launch catalog with current agent and workspace grants and project applicability, and enforces both launch-time and current per-tool denials. Assistant arguments cannot supply scope, credentials or local absolute paths. Remote tool schemas with unsupported validation features are excluded from the assistant catalog. The isolated connection probe remains available for diagnosis.

## Test changes

- The builder suite replaces the transitional managed Workbook native `edit` assertion because Workbook now uses a ticketed tool. It asserts denial of native `write` and `edit` for Web, channel, schedule and delegation. The separate Phase 1 native probe's assertions are intact.
- Workbook browser and HTTP fixtures emit the broker tool's closed schema. The browser keeps its original download hash, size, exact projected bytes, and tool-card checks. The native gate now rejects both the prior unrelated credential-like field and an absolute pathname as invalid broker inputs, and the browser additionally checks that the real ticket field and value are absent from the tool card. The pinned gate checks the broker-produced XLSX byte-for-byte against the deterministic writer and checks all 13 cells against the unchanged openpyxl oracle.
- Workspace tests cover traversal, UNC, ADS, short names, case collisions, reserved names, hardlinks and cross-run reads. The Windows race probe attempts to rename the live output root immediately before publication, then checks a swapped directory identity and a colliding destination. The native gate covers same-session and cross-session attachment and artifact reads.
- Knowledge tests preserve the existing owner Q&A, citation verifier, Telegram replies and BI coverage. They add denials for an unbound Web vault and revoked Telegram grant, and discard in-flight results after a binding or publication model consent changes. The Telegram integration fixture now uses a scoped ChatService and a synthetic knowledge relay. Its published but model-disabled BI vault still returns no answer with zero model calls.
- The custom MCP tests replace assertions that stdio launches and is advertised after restart because the owner approved pausing it. They assert continued settings tests, credential redaction in the explicit probe, no automatic process launch, and hidden tools after restart. Pinned OpenCode now exercises allowed remote tool calls and exact per-tool denial. The HTTPS transport suite still tests TLS, SSE, authentication and redirect refusal. The remote assistant fixture uses a synthetic transport and independently verifies the arguments that would leave the broker.

## Verification

Each gate ran with a fresh temporary `OEP_DATA_DIR` and process-local Python configuration from `oep-verify-venv/Scripts`.

The first sequence stopped at Telegram because its test fixture still injected the owner-only Ask service. The fixture was updated without changing its assertions. An initial restart also caught a TypeScript cast in that fixture. Verification restarted at lint after the correction.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.91 s. Checked 238 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.49 s. No diagnostics. |
| `npm test` | Exit 0 in 8.07 s. 84 passed, 0 failed, 0 skipped. The test account exercised an actual junction because it could not create a file symlink. |
| `npm run build:release` | Exit 0 in 14.97 s. Release scan passed. ZIP SHA-256 `902571333f1625e47e98a47d3b7498288fa1a139ace09198f1a0824c2600bfb7`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 69.05 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 72.52 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 72.16 s. Supervisor and child exited 0, with 0 orphans. |
| `npm run test:e2e:knowledge` | Exit 0 in 23.88 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 3.98 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 1.95 s. 5 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 54.80 s. Pinned broker calls, agent and workspace revocation, settings probes, HTTPS transport and Chromium passed. |
| `npm run test:compliance` | Exit 0 in 0.42 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 32.99 s. 1 passed, 0 failed, 0 skipped. Both ZIPs reproduced the release SHA-256. |
| `npm run test:contract:native:isolation` | Exit 0 in 18.99 s. 5 passed, 0 failed, 0 skipped. Both OpenCode 2.3.2 Jobs reported 0 supervisor exit, 0 child exit and 0 orphans. |
| `npm run scan` | Exit 0 in 1.13 s. 560 files scanned, 0 hits. |

The offline Excel checks ran after the sequence. `npm run test:e2e:excel:synthetic` exited 0 in 7.06 s with five verified workbooks and clean Job shutdown. `npm run test:e2e:excel:faults` exited 0 in 1.85 s with one verified control and nine expected failures.

## Benchmark smoke

`npm run benchmark:isolation -- --smoke` exited 0. The isolated runtime took 1,764.46 ms to start and 1,769.08 ms to stop and restart at idle. The Job had 4 members. Resident working sets were 95,227,904 bytes for the harness and 151,150,592 bytes for OpenCode.

The MCP list took 9.94 ms. Four passes through permission building and tool enumeration took 0.18, 0.04, 0.08 and 0.10 ms for 1, 2, 5 and 10 configured assistants. The synthetic FIFO model seat measured first replies at 12.94, 28.57 and 43.96 ms for Web, Telegram Main and BI, with waits of 0.22, 12.96 and 28.58 ms. Writing and verifying a 1 KiB file took 158.92 and 40.46 ms. The 256 KiB sample took 153.77 and 38.23 ms. SQLite claim and restart reconciliation took 0.40 and 2.50 ms.

These are single-host smoke observations. Priority scheduling and parallel model attribution are outside Slice 2b.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`. The owner installation and data directories were outside the test setup.

No Slice 2b implementation items remain. The report records the scope limits and test changes. There were no design deviations that required a decision-log entry.
