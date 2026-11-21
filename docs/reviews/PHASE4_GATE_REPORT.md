# Phase 4 gate report

Local branch `phase-4/telegram-jobs` from `38520a3`. Overall gate **UNVERIFIED** pending live bot smoke and independent Technical Lead review.

| Item | Status | Evidence |
|---|---|---|
| Dual bot inbox, atomic cursor and replay | VERIFIED | Fake API delivered overlapping IDs and repeated batches. 48 admitted updates finished, 24 per bot. Foreign sender and group updates produced no intake. |
| Crash/restart and outbox | VERIFIED | Child exits before admission commit, after commit before the next offset request, after staging before reply, and in sending state. Retry-after observed. Fake acceptance followed by timeout and the restart sending state remained indeterminate. No duplicate send in the fake run. |
| BI intake and publication | VERIFIED | Synthetic Telegram text and file, blocked link with original reference, manual supplement, 24 distinct effects, one reviewed publication and one notification after replay. |
| Main conversation and Ask | VERIFIED in synthetic runtime | Two independent native OpenCode sessions and a verified citation through the Telegram router. Model-disabled test makes zero model calls. |
| Immediate, scheduled and Run Now | VERIFIED in simulation | Same lease/claim/effect path. Run Now and scheduled reconciliation for one occurrence converge across process exit/reopen. DST fall-back, multi-day clock jump and pause covered. |
| Web | VERIFIED in part | Chromium opens the jobs surface and returns to Knowledge. The authenticated work surface includes inbox filtering, source selection, supplement, configurable daily schedule and history, and review/job/delivery status. Full interaction and accessibility coverage remain UNVERIFIED. |
| Remaining GUI parity | UNVERIFIED | Generic installed workflow forms and credential-reference pairs, automated case review and retention controls remain open. Current work profiles are BI candidate JSON. |
| Source policies | VERIFIED in part | Unapproved public link retained for manual fallback, synthetic UTF-8 file reaches review. Approved external HTTPS fetch and binary attachment round trips through real Telegram remain UNVERIFIED. |
| Real Telegram smoke | UNVERIFIED | Optional Main smoke skipped. BI token pending owner setup. |
| Real Windows sleep/wake, logout/login, RPO/RTO | UNVERIFIED | O-3b waived. Synthetic restart and clock jumps only. |
| Independent review and merge | UNVERIFIED | The Technical Lead owns the merge. |
| Review follow-up, stalled and poison updates | VERIFIED | Persistent attempt survives process exit. Transient work succeeds. Throwing and unresponsive handlers terminate with one failure reply each. Commands and later updates complete while originals remain available for reconciliation. |
| Review follow-up, long polling and resend | VERIFIED | Fake server receives a single 25-second poll, while status and delivery proceed. Shutdown aborts the poll. An ambiguous send stays unresolved until a manual action. Repeated clicks cannot queue the same pending resend. |
| Review follow-up, BI target | VERIFIED | Fake model stages a pending change set on the active target. Fabricated quotes and unavailable model block intake. A supplement succeeds after recovery. Replay avoids a repeated proposal. |
| Source-byte retention | OPEN | `bi_sources` has no retention limit. Tracked in TASKS.md. |

| Command | Result |
|---|---|
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test` | 49 passed |
| `npm run scan` | 0 hits |
| `npm run test:telegram` | 5 passed |
| `npm run test:ingest` | 16 passed |
| `npm run test:knowledge` | 11 passed |
| `npm run test:e2e:knowledge` | 1 passed |
| `node scripts/phase0/knowledge-baseline.ts` | Recall@5 24/24 |

[Validation and operations](../validation/p4-telegram.md)
