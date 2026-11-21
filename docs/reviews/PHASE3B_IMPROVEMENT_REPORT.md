# Phase 3b improvement report

2026-11-21, feature branch `phase-3b/usable-review`, base `99e860b`. All fixtures and live proposal inputs were synthetic.

| Item | Status | Evidence |
|---|---|---|
| 3b-R1 | VERIFIED | A 500-card parent exceeding the JSON limit, one source over 128 KiB, add/update/remove, extra evidence, a relationship, stale-parent rejection and missing evidence rejection. Each fault point uses a process exit and 10 independent publishers. The final database has one new revision and one new intent, with the seed intact. Existing BI job and Wiki full-candidate tests remain in the suite. |
| 3b-R2 | VERIFIED | Exit before rollback commit preserves the live pointer. A committed first rollback survives reopen, returns `vault-unavailable`, keeps the revision and review, and permits reactivation. Replay does not reactivate or duplicate the intent. |
| 3b-R3 | VERIFIED | Chromium uses the BI form on an existing imported vault, sees a one-card addition in the diff, approves, publishes, verifies the new quote and source through Ask, and rolls back to the imported tag. Existing Wiki and OpenCode MCP scenarios run in the same test. |
| 3b-R4 | VERIFIED | Chromium test attempts a write via the launcher Ask service's SQLite connection and receives SQLite's read-only error. Native MCP exercises the same Ask service. The review connection publishes independently. |
| 3b-R5 | VERIFIED | A fake model's fabricated quote produces no review even though proposals are available independently of the Ask permission. The exact quote control produces a pending change set and direct publication fails before approval. One synthetic run per alias returned HTTP 200 and a pending proposal with the original head still active. Aliases were `gpt-5.4-mini` and `claude-haiku-4-5-20251001`. |

The fixed text baseline returned Recall@5 24/24 with no misses. The knowledge contracts cover full Recall@5 on the imported gold mirror and the bilingual forecast and original citation regression.

**Limits.** Uploads are capped at 1 MiB each, proposals at 24,000 UTF-8 bytes and one card, and evidence passages at 4,000 UTF-16 code units. Metadata JSON stays capped at 128 KiB. The proposal check verifies literal quote occurrence. Reviewers still judge whether the quote supports the proposed value. Uploaded blobs have no automatic expiry. Relationship editing and evidence-only amendments are available through the advanced change-set JSON.

**UNVERIFIED.** Owner data, target VM performance, aggregate upload disk growth, and broader keyboard and assistive-technology coverage were outside this synthetic gate. The live model runs exercised proposal generation and validation on the shared Gateway path. Chromium used a synthetic Gateway and verified the manual review workflow. Technical Lead merge acceptance is pending.
