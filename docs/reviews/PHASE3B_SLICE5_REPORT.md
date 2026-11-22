# Phase 3B Slice 5 delegation

The local `phase-3b/slice-5b-delegation` branch continues the admission checkpoint at `1a7bb52` with specialist execution, settlement, and paired owner controls. The implementation and synthetic lifecycle checks are recorded through `eaed9ba`.

## Specialist execution and owner controls

- Production Web and Telegram Main turns receive the broker-mediated directory and delegation tools. The dispatcher gives each child its own `delegation` session, run record, effective model, managed workspace, and specialist permissions. General children reuse the OpenCode submission and outcome checks. Handoff files are reverified and imported as independent, classified attachment copies.
- The BI proposal service receives the verified delegation source and meters proposal requests with the specialist model. A result says「已送審」only after verification of a review matched to the child run. Missing or insufficient input has its own result, and model responses cannot approve or publish a review.
- Requests are counted before the relay or controlled domain sends them. Tools are counted when the broker accepts a valid ticket. Elapsed time is bounded from the dispatcher claim. The lower existing turn limits apply. Queue expiry, child completion, and owner cancellation settle the reservation against measured use and save a completion notice intent in the same transaction as the terminal result. A verified landed effect survives cancellation. Unknown outcomes keep the write lease for reconciliation and are never replayed automatically.
- The paired delegation API returns receipts, results, and audit events, supports cancellation, and downloads verified export copies by manifest ID. The owner can save all seven budget values in Settings → Assistants and channels. Both catalogs cover the form and server errors.

## Follow-up checks and decisions

- A deliberately long specialist fixture reproduced the attachment failure before the fix. `GetFileAttributesW` failed on the upload directory before the source file was copied. The fix sends extended-length paths to `GetFileAttributesW` for each checked ancestor and preserves the canonical-path and reparse checks. The same test passed after the fix and verified distinct inodes and identical hashes for uploads and handoff copies above 260 characters.
- The checkpoint's native broker failure came from the same Windows attribute check. Its trace showed the workbook run failed in 1.35 s after two successful model steps. The probe waited for `verified` until its deadline. The persisted workbook manifest path was 269 characters. A direct attribute check on that file returned Windows error 3 without the prefix and identified a regular file with it. The first follow-up native run under a short root passed 5 of 5 in 19.14 s with zero orphans. The workbook probe now reports a terminal failure immediately, and named timings identify the failed phase. The existing deadlines and verified-workbook assertion were retained.
- The production lifecycle fixture checks concurrent specialist leases and serialized upstream calls on distinct model aliases, queued/running/landed cancellation, model and tool caps, queue and execution deadlines, restart reconciliation without replay, forged BI publication, verified exports, and cross-session file denial. Same-agent priority and non-preemption remain covered by the dispatcher contract. No existing assertions were removed or loosened.
- The first two development runs of the new lifecycle fixture exposed two test assumptions. Runtime model health checks also use JSON completions, so the fixture now counts BI proposals only when the expected synthetic source is present. The paired HTTP client now supplies the owner CSRF header for settings reads. The subsequent short-root delegation run passed 3 of 3 in 35.86 s with zero orphans.
- Wall time begins at claim and includes file preparation and any wait for the shared model seat. Verified exports in Slice 5 are UTF-8 files explicitly written through the existing controlled file tool. BI sources use separate intake IDs and retain delegation ownership in the channel ledger. The Knowledge database's existing `owner` provenance stores the delegation source key and child run ID. This preserves its existing schema and gives Slice 6 a durable link to the delegation's original destination.

## Admission checkpoint history

Local branch `phase-3b/slice-5-delegation` starts at `3f1cd4a` from `review/3c-4`. The checkpoint covers the ledger, broker authorization, and work admission. Production Web and Telegram turns will receive the two tool grants when the specialist executor is connected. The synthetic client injects the admission service into the same ChatService and broker used by the application.

## Implementation

- Central Web schema v6 adds five STRICT tables for delegations, events, request keys, file manifests, and notice intents. Upgrade reconciliation names the five empty additions, checks their SQL definitions and foreign keys, and includes their counts in rollback comparisons. The historical v5 fixture retains completed work and a saved queue-budget change. Earlier historical fixtures still reconcile.
- The OpenCode SSE broker registers `list_specialists` and `delegate_to_specialist` with closed input schemas and the existing run-bound ticket flow. The admission service verifies the persisted parent turn, request hash, session owner, origin, active Main role, and current direct work lease. The specialist directory returns only ID, name, introduction, and dispatcher status. The permission builder gives delegated specialist sessions the same classes of controlled tools available to direct specialist sessions.
- Admission verifies files from the parent's selected attachment IDs through AttachmentService. A Windows handle-pinned copy gives each accepted file and its workbook projection a fresh location. The manifest preserves the source ID, content hash, file identity, MIME, and the stricter source classification. Copies and their projections share the 40 MiB aggregate limit. Staging cleanup preserves directories with durable manifests.
- The central transaction adds the delegation reservation, dispatcher work, initial event, key, and inbound manifest. Repeated keys return the same receipt when their request hash matches. Identical content under an additional key adds a key and event to the existing work. Each invocation still uses the parent turn's existing tool-call allowance. Reservations use the owner budget row and the work item captures the queue deadline at acceptance.

## Test changes

- Existing version assertions now expect central schema v6 because the five new tables live in `web.sqlite`. Channel and knowledge versions are unchanged. The old assertions on migration restart, existing row contents, and missing or changed indexes remain in place. The v5 upgrade fixture adds checks for empty delegation tables, preserved work and budgets, and failure when the delegation index is removed.
- The standalone `test:e2e:delegation` client drives pinned OpenCode 2.3.2 with a synthetic SSE gateway. It checks catalog fields, scope, unknown fields, Main and archived target rejection, forged parent rejection, idempotency, the fourth delegation refusal, the parent tool cap, adjusted reservations, selected and foreign attachment ownership, distinct verified copies, tamper and cross-root rejection, orphan staging cleanup, and clean Job shutdown. The existing dispatcher contract continues to check same-agent priority and parallel claims.
- The first focused schema run passed 12 of 13 tests. Its new historical fixture reordered two values in a copied work-state CHECK. The named verifier caught the mismatch and the focused rerun passed after the fixture was corrected.

## Verification

Windows 11, Node 24.14.1, PowerShell 7.6.10. `npm ci` installed 14 packages and reported zero vulnerabilities. The worktree uses its own Phase 0 assets and source. The hook installer first rejected the inherited snapshot path. Setting this worktree to the checked-in `.githooks` let the installer activate hooks and `merge.ff=false`.

The focused delegation client passed in a short temporary root. A subsequent run under a deeper verification directory failed in 3.53 s while uploading the test specialist's file. The absolute fixture path was 265 characters, beyond the current Windows attribute probe's supported path length. The retry passed 1 of 1 tests in 9.16 s under a short root. Both runs stopped OpenCode with zero orphans. Each command used a fresh temporary data root and process-local Python from `oep-verify-venv`.

The implementation at `ea10c42` ran through the following sequence.

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 266 source and configuration files checked | 1.02 |
| `npm run typecheck` | 0 | TypeScript completed | 5.54 |
| `npm test` | 0 | 98 passed, 0 failed, 0 skipped | 14.94 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 42.35 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium checks completed | 82.84 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium checks completed | 83.37 |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium checks completed | 83.56 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 27.20 |
| `npm run test:ingest` | 0 | 16 passed | 4.40 |
| `npm run test:telegram` | 0 | 8 passed | 24.16 |
| `npm run test:e2e:mcp` | 0 | MCP, probe, remote, and browser commands completed | 54.73 |
| `npm run test:compliance` | 0 | 2 passed | 0.42 |
| `npm run test:release:determinism` | 0 | 1 passed | 39.11 |
| `npm run test:contract:native:isolation`, first run | 1 | 4 passed, 1 probe deadline in the existing broker case, 0 orphans | 36.96 |
| `npm run scan` | 0 | 679 files, 0 hits | 1.40 |

Native isolation passed 5 of 5 tests in 20.56 s on retry with a short temporary root and zero orphans. The probe assertions stayed in place. Both determinism builds reproduced the release ZIP SHA-256 `39411b3a139d80fa4b8bf1dd5f2dae42ebf09cfc8d5a4133b894c9ebd5ea3f4b`.

## Slice 5b verification

Windows 11, Node 24.14.1, pinned OpenCode 2.3.2 and process-local Python. `npm ci` installed 14 packages with zero reported vulnerabilities. Phase 0 assets and source were copied from the main checkout, and the worktree hooks were enabled. Each gate used a fresh temporary data root. Gateway and Telegram fixtures were synthetic.

| Ordered command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 266 source and configuration files checked | 0.99 |
| `npm run typecheck` | 0 | TypeScript completed | 5.40 |
| `npm test` | 0 | 98 passed, 0 failed, 0 skipped | 14.31 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 38.19 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium checks completed, 0 orphans | 81.76 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium checks completed, 0 orphans | 82.34 |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium checks completed, 0 orphans | 83.57 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 27.39 |
| `npm run test:ingest` | 0 | 16 passed | 4.15 |
| `npm run test:telegram` | 0 | 8 passed | 24.34 |
| `npm run test:e2e:mcp` | 0 | MCP, probe, remote, and browser commands completed | 55.35 |
| `npm run test:compliance` | 0 | 2 passed | 0.41 |
| `npm run test:release:determinism` | 0 | 1 passed, identical ZIPs | 38.78 |
| `npm run test:contract:native:isolation` | 0 | 5 passed, long workbook manifest, 0 orphans | 20.08 |
| `npm run test:e2e:delegation` | 0 | 3 passed, including long upload and lifecycle, 0 orphans | 36.84 |
| `npm run scan` | 0 | 680 files, 0 hits | 1.37 |

Both determinism builds reproduced the release ZIP SHA-256 `3e2180cbac396b5140a439d0cf1c5ded1cd63093248706710c283f9253c609de`.

The long-root native rerun completed workbook verification in 1.83 s against its existing 25 s deadline. Telegram admission took 182 ms and its verified reply wait took 1.50 s. This reproduced the checkpoint path depth with the Windows attribute fix active.

The native regression fixture was tightened before its place in the ordered run. Lint and TypeScript both passed again with that fixture in place.

## Remaining

Slice 6 owns chat result cards, the full run view, and delivery of completion and publication notices to the original conversation.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`, followed by review and merge. The installed OEP and its data directory were outside the test setup. The branch stays local.
