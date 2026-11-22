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

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup` remain with the reviewer because their running-process guards can collide with the concurrent GUI slice.

Delegation production and the work-resolution GUI belong to later slices. The existing limits on additional BI intake accounts and resend confirmation for additional accounts remain open from slice 3b.
