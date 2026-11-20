# OEP Implementation Plan (Draft v1.0, 2026-11-21)

## Objective
Build a local-first, single-user OpenCode Engineer Platform (OEP), retaining useful AEP knowledge functionality without reimplementing an agent harness. **Do not modify AEP.**

## Architecture
- Local launcher starts a headless OpenCode server and browser-based GUI.
- Web GUI: chat, agent/session selection, image/PDF/Excel upload, live tool events, artifact download, BI card review.
- Lightweight adapter: file workspace, Telegram routing, session mapping and scheduling; not a planning/execution harness.
- OpenCode: agent execution, sessions, tools, Skills and MCP.
- Company LiteLLM Gateway: model access (compatibility to verify).
- BI Knowledge and LLM Wiki services: schema, conversion, ingest, staging, evidence, review, publish, search and benchmark.
- Knowledge asking: retrieval-first for explicit knowledge queries, evidence-based answers with citations and abstention when unsupported.
- Telegram Main Bot: general agent tasks; BI Bot: social link/file collection, dedicated ingest sessions.
- Ingest execution: immediate, user-selected scheduled time or manual Run Now. No CPU/idle resource monitoring.

## Phase 0 — Architecture audit and approval gate
1. Inspect AEP and current OpenCode release; pin API versions.
2. Map AEP features as Keep / Adapt / Replace / Remove with exact source paths.
3. Check plugin dependencies, data migration, knowledge evidence and versioning.
4. Verify OpenCode server/SDK, LiteLLM, attachments, multi-agent sessions, event streaming, scheduling claims.
5. Have Codex and Claude Code independently review, then reconcile differences.
**Exit:** approved implementation plan v2 and architecture decision record. No application coding before this gate.

## Phase 1 — Runtime proof of concept
- Start OpenCode as a background service and connect to LiteLLM.
- Reproduce the historical SOP/PDF → generated program → Excel workflow.
- Check actual output, exit codes, retries, errors and false-positive success.
- Verify independent sessions and agent configurations.
**Exit:** repeatable end-to-end success and traceable failures.

## Phase 2 — Browser GUI and launcher
- One-click launch opens localhost browser; no terminal or native OpenCode GUI required.
- Drag/drop images and documents into per-session workspace; pass verified attachment references to OpenCode.
- Stream progress, tool events, errors and artifacts.
- Restrict local API exposure and uploaded file paths.
**Exit:** nontechnical user can upload screenshot/PDF and receive analyzed results without entering paths.

## Phase 3 — BI Knowledge and Wiki
- Extract domain services from AEP-specific Plugin/Host contracts; expose minimal tools/MCP.
- Preserve vault → source → Markdown conversion → schema → ingest → evidence-backed candidates → validation → human review → publish.
- Preserve card identity, relationships, versions, source provenance and safe SQLite writes.
- Add enforced retrieval for Knowledge Asking, hybrid search as justified, citations and evidence validation.
- Benchmark retrieval, grounded answers, ingest and migration.
**Exit:** create, review, publish and ask knowledge questions without AEP harness.

## Phase 4 — Telegram
- Route Main Bot to general agent and BI Bot to dedicated ingest pipeline.
- Separate bot credentials, sessions, durable message cursor and queued items.
- Support immediate/scheduled/Run Now; persist failures and notify for review.
- Social media retrieval may be blocked; preserve link and report inability instead of fabricating.
**Exit:** shared link becomes a staged knowledge card ready for approval.

## Phase 5 — Packaging and regression
- End-to-end: SOP→Excel; screenshot analysis; Telegram→card→review; knowledge question→evidence/citations; schema updates; backup/restore.
- Install/upgrade/rollback instructions and local packaging.
**Exit:** all critical scenarios reproducible and verified.

## Exclusions
No multi-user central service, RBAC, CPU monitoring, autonomous publication, or parallel replacement harness.

## Public repository restriction
Do not commit private company source, tokens, credentials, internal customer data or proprietary datasets. Review reuse licensing and authorization before porting AEP code.
