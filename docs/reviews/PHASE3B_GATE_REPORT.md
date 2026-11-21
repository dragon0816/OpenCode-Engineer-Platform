# Phase 3b gate report

Branch `phase-3b/ingest-review-publish`, based on `caf60b9`. Overall gate **UNVERIFIED** pending full GUI parity and Technical Lead review.

| Acceptance item | Status | Evidence |
|---|---|---|
| BI and Wiki source through staging, review, publish and Ask | Verified | `npm run test:ingest`, separate BI and Wiki tests with verified citations and a read-only consumer. |
| Reject unreviewed, rejected, stale schema and missing evidence | Verified | Integration tests cover both kinds and confirm that a legacy import cannot publish into a managed vault. |
| Crash recovery before blob, mid-commit and after commit before delivery | Verified | Six abrupt publisher process terminations. On-disk visibility, Ask, notification count and database integrity from a separate reader. |
| Concurrent retries | Verified | Ten independent processes for each of the six cases converge on one publication and intent. |
| Human edits and source provenance | Verified | Retry retains edited Markdown and its citation, original hash and saved edit sequence. |
| Version rollback and conflict | Verified | Old active revision and Ask restored for BI and Wiki. A stale predecessor blocks publish. |
| BI job claim, lease and effect | Verified | Shared claim used for immediate execution and Run Now. Expiry fences stale holders. One staging effect per completed job. |
| Schema compatibility and source isolation | Verified | Synthetic AEP versions 8, 9 and 14 normalize, unsupported 15 rejects. Phase 3a reader and immutable source tests pass. |
| Authenticated Web review, Chromium and MCP | Verified | `npm run test:e2e:knowledge` checks anonymous rejection, Wiki approval and rollback in Chromium, and Phase 3a Ask and native MCP regression. |
| Review and notification reconciliation | Verified | Integration checks match effect and intent counts. [Validation and version comparison](../validation/p3b-publish.md) |
| Backup restore and end-user operations on the target VM | UNVERIFIED | Recovery procedure documented. Repeat with the target VM and production backup before operational sign-off. |
| Live AEP source compatibility | UNVERIFIED | This phase used synthetic fixtures only. |
| Independent Technical Lead review and merge | UNVERIFIED | Work stays on the local feature branch for review. |

## Phase 2b parity rows assigned to 3b

| Row | Status | Coverage and gaps |
|---|---|---|
| Reviews | UNVERIFIED | Authenticated list, refresh, save, approve, reject, publish and rollback verified. Deferral, session navigation and knowledge-gap views remain open. |
| Business cards and organization | UNVERIFIED | Versioned cards and relationships accepted in reviewed snapshots. Recognition, deduplication by imported identity and interactive organization graph remain open. |
| Tasks and work panel | UNVERIFIED | Persistent job and review states appear in the BI review panel. Full work-panel integration remains open. |
| BI vault and source editing | UNVERIFIED | Text and Markdown source entry, original storage and editable draft available. Classification and broader conversion tools remain open. |
| Schema, skill and profile tools | UNVERIFIED | Versioned required-field schemas and stale candidate rejection verified. Skill, profile, schema assistant and program-management UI remain open. |
| Dataset and schema install | UNVERIFIED | A versioned schema and generated candidate template create a local vault. Separate JSON schema import and dataset management remain open. |
| BI batch ingest | UNVERIFIED | Shared immediate and Run Now claim, edit, preview and individual decisions covered. Batch controls and cancellation remain open. |
| Benchmark authoring | UNVERIFIED | The fixed 48-question regression runs on synthetic data. Editable benchmark authoring and per-question review UI remain open. |
| Publish and rollback | Verified | Immutable revisions, Ask isolation, rollback and competing base conflict tested. |
| Wiki sandbox lifecycle | UNVERIFIED | Independent candidates and discard isolation verified. Ownership and source/question folder management remain open. |
| Wiki Pull and conversion | UNVERIFIED | Local UTF-8 source loading available. Pull, classified upload, and conversion execution controls remain open. |
| Wiki skills and ingest selection | UNVERIFIED | Draft edits and original evidence preserved. Skill editor, assistant and selectable conversion queue remain open. |
| Wiki diff, trial and publish | UNVERIFIED | Base/candidate comparison and local draft excerpt search available. A full draft trial-answer flow and source refresh remain open. |

## Implementation limits

The review surfaces use the existing Web app's JavaScript modules. Candidates describe full vault revisions and the accepted source format is UTF-8 text or Markdown. The worker claims jobs synchronously from the review surface. An expired lease can be reclaimed with Run Now. Notification delivery and periodic job scheduling belong to Phase 4.

## Gate command results

| Command | Status | Output |
|---|---|---|
| `npm run lint` | Verified | 129 source and configuration files checked. |
| `npm run typecheck` and `npm run build` | Verified | Both exit 0. |
| `npm run test` | Verified | 46 passed, 0 failed. |
| `npm run scan` | Verified | 190 files, 0 hits. |
| `npm run test:ingest` | Verified | 11 passed, 0 failed. |
| `npm run test:knowledge` | Verified | 8 passed, 0 failed. |
| `npm run test:e2e:knowledge` | Verified | 1 passed, 0 failed. |
| `node scripts/phase0/knowledge-baseline.ts` | Verified | Recall@5 24/24, no misses. |
| `npm run knowledge:benchmark -- --repository` | UNVERIFIED | Exit 0 and Recall@5 24/24. GPT usable 22/24, abstained 24/24, reproducible 22/22, critical unsupported 0. Haiku usable 23/24, abstained 24/24, reproducible 25/25, critical unsupported 1. Both had zero transport errors. |

The live Haiku regression returned a reproducible but irrelevant extra citation for synthetic question A12. The D03 threshold of zero critical unsupported claims was missed. The Phase 3a Ask verifier remains unchanged.
