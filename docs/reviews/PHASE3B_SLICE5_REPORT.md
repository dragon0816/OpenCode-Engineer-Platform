# Phase 3B Slice 5 admission checkpoint

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

## Remaining

- Register a specialist worker with the production dispatcher and activate the tools for Main's eligible Web and Telegram turns. Add independent child sessions and runs, revalidate and import handoff copies, and route BI delegation through the proposal service with a verified review ID.
- Meter specialist model requests and tool calls at the relay and broker, apply execution deadlines, and settle reservations. Add settings routes and the bilingual field group.
- Commit verified results, export copies and notice intents, and handle queued and running cancellation, completion races, indeterminate work and restart reconciliation. Add paired delegation reads and extend the synthetic client to cover these lifecycles.
- Slice 6 owns chat result cards, the full run view, and Telegram completion delivery.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`, followed by review and merge. The installed OEP and its data directory were outside the test setup. The branch stays local.
