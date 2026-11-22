# Phase 3B slice 3c dispatcher

## Implementation

- Central `web.sqlite` schema v5 adds the STRICT `agent_work_items` table. SQLite enforces a unique source key and one unreleased write lease per agent, including indeterminate work. The upgrade compares the named table and indexes, checks that the table starts empty, and includes it in rollback intent comparisons. The fixture covers upgrades from a historical v2 Web ledger and from v4 with existing channel settings.
- The dispatcher claims ready work under `BEGIN IMMEDIATE` in direct, delegation, and schedule order, then by enqueue time and ID. Claims leave active leases in place. Completion compares the lease ID. Different agents and verified reads can enter the dispatcher independently. Model steps share the runtime's existing model seat.
- Web admission commits the accepted run and work item together. Telegram uses the account and update ID to commit central intent, then records the same work ID in its spool. A reply and inbound receipt commit together before the work lease is released. The spool orders one conversation across its work and command lanes. The existing two-minute Telegram deadline and pre-submission retry interval still apply.
- BI intake, supplement, review staging, scheduler occurrences, Run Now, and unfinished BI jobs go through the dispatcher. BI proposals release the lease when staging finishes. A schedule's wall-time key, IANA zone, and UTC catch-up window are preserved. A due occurrence is recorded as missed when the previous occurrence of that schedule still holds a lease.
- A durable execution marker separates claims that can return to the queue from work that needs reconciliation. Startup checks OpenCode inbox, messages, permissions, and active state for claimed turns. BI jobs use their transactional review effects and Telegram uses its inbound and outbox receipts. Uncertain work retains the agent lease. When OpenCode may still be active, the runtime model seat stays held until the session can be checked and shown to be idle.
- A paired owner can list indeterminate work at `GET /api/work-items`. `POST /api/work-items` requires the current lease ID, CSRF token, and a `succeeded`, `failed`, or `cancelled` decision. The API exposes work and lease metadata. A successful resolution of a turn requires evidence, including the verified run for a workbook. Delegation placeholders use the saved owner queue budget, seeded at ten minutes.

## Test changes

The central version expectations in the agent-ledger contract, upgrade allowlist contract, and installer upgrade fixture now require v5 because the queue schema changes only `web.sqlite`. New migration assertions verify that the queue begins empty and that reconciliation rejects a removed write-lease index.

The native isolation gate still asserts the exact model-call sequence. BI now enters the model seat before a Telegram Main turn that is queued behind the active Web turn for the same agent. The test also checks that the Telegram turn is durably queued while Web owns the agent lease.

The synthetic dispatcher contracts cover direct/delegation/schedule ordering, non-preemption, stale leases, the partial unique index, parallel claim admission and model serialization, restart recovery and owner authorization, queue expiry, DST-fold scheduler idempotency, and same-conversation Telegram ordering.

## Verification

Commands ran sequentially with fresh temporary `OEP_DATA_DIR` roots. Each test process used the existing verification venv. The worktree used its own npm dependencies, Phase 0 assets, source, and hooks.

Worktree setup passed with `npm ci` and `node scripts/phase0/install-hooks.mjs`. The hook installer initially rejected the inherited snapshot path. I set this worktree's hook path to the checked-in `.githooks` and reran the installer successfully.

The first `npm test` attempt passed 92 of 95 tests. It exposed two central schema-version expectations and a missing adapter catalog entry. The next attempt passed 94 of 95 and exposed the remaining v4 expectation in the migration retry assertion. The assertions now require v5, and both catalogs include the two resolution errors.

The first native isolation run passed four of five tests. Its broker case timed out because two standalone ChatService instances each recovered the same central ledger. The services now share a dispatcher for that ledger. The focused rerun passed five of five with zero OpenCode orphans.

Final sequential run at `97a85b1`

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 253 source and configuration files checked | 0.93 |
| `npm run typecheck` | 0 | TypeScript completed | 5.30 |
| `npm test` | 0 | 95 passed | 13.06 |
| `npm run build:release` | 0 | Windows x64 release ZIP built and scanned | 18.98 |
| `npm run test:e2e:browser`, run 1 | 0 | Supervisor and child exited cleanly with 0 orphans | 74.74 |
| `npm run test:e2e:browser`, run 2 | 0 | Supervisor and child exited cleanly with 0 orphans | 75.86 |
| `npm run test:e2e:browser`, run 3 | 0 | Supervisor and child exited cleanly with 0 orphans | 75.34 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 27.54 |
| `npm run test:ingest` | 0 | 16 passed | 4.49 |
| `npm run test:telegram` | 0 | 8 passed | 23.95 |
| `npm run test:e2e:mcp` | 0 | MCP, probe, remote, and browser commands passed | 57.57 |
| `npm run test:compliance` | 0 | 2 passed | 0.43 |
| `npm run test:release:determinism` | 0 | 1 passed | 39.69 |
| `npm run test:contract:native:isolation` | 0 | 5 passed | 21.83 |
| `npm run scan` | 0 | 577 files scanned, 0 hits | 1.27 |

The release ZIP SHA-256 was `025c8faed506a59b7490a168a77a48d557c9c46340767877c5d72033797d9062`.

## Design decisions

The existing channel deadline starts at the first intake attempt. A failed attempt can return to the dispatcher only before the durable execution marker. An indeterminate write remains leased until owner resolution. For OpenCode turns, the resolution API also requires an idle upstream session. The API keeps its payload and upstream messages private.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup` remain with the reviewer because their running-process guards can collide with the concurrent GUI slice.

Delegation production and the work-resolution GUI belong to later slices. The existing limits on additional BI intake accounts and resend confirmation for additional accounts remain open from slice 3b.
