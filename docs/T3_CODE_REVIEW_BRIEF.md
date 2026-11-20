# T3 Code — Codex + Claude Code Review Handoff

## Mission
Independently review OEP's architecture and AEP migration, reconcile findings, then implement only after owner approval.

## Sequence
1. Codex reads all three OEP docs and inspects AEP as read-only reference; verifies OpenCode's current pinned API. Produce independent report with source paths, risk, scope, tests.
2. Claude Code independently does the same, without copying Codex's conclusions.
3. Cross-review: challenge mismatches on Plugin portability, OpenCode scheduling, attachment API, LiteLLM, retrieval and session isolation.
4. Reconcile into `docs/REVIEW_COMPARISON.md`, `docs/ARCHITECTURE_DECISIONS.md`, `docs/IMPLEMENTATION_PLAN_V2.md`.
5. Obtain owner approval of v2 **before application code changes**.
6. Implement on OEP feature branches with tests, actual artifacts and PR reviews.

## Non-negotiable constraints
- Never modify `dragon0816/agentic-engineering-platform`.
- Do not copy proprietary company code/data/secrets into public OEP.
- OpenCode owns harness, execution and sessions.
- Single-user local deployment, two Telegram bots initially.
- Ingest: immediate, scheduled and Run Now; no CPU/idle monitoring.
- BI knowledge publishing requires human review; Knowledge Asking must retrieve and cite evidence.
- Verify rather than assume OpenCode API and scheduling capabilities.

## Initial prompt to paste into T3 Code
Read README.md, docs/IMPLEMENTATION_PLAN.md, docs/AEP_FEATURE_GAP_ANALYSIS.md and docs/T3_CODE_REVIEW_BRIEF.md. Ask Codex and Claude Code to independently audit the current AEP repository (read-only) and a pinned OpenCode version. Compare findings, reconcile disagreements and produce a detailed implementation plan v2 with exact file-level tasks, acceptance tests, dependencies, migration/rollback and risk assessment. Do not modify AEP or start application implementation until I approve v2.
