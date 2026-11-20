# AEP Feature Gap Analysis (Preliminary)

Source: https://github.com/dragon0816/agentic-engineering-platform

This is a targeted review of code/documents, **not** a complete audit or proof of deployed behavior. The implementation team must verify status in the current repository.

| Area | AEP evidence | OEP decision / remaining verification |
|---|---|---|
| Agent harness / sessions | AEP custom runtime | Replace with OpenCode; compare reliability |
| Skills / MCP / Tools | Existing registries | Use native OpenCode where possible |
| SOP→workflow→Excel | Historical false-success case | Critical runtime benchmark |
| BI Plugin | `scripts/build_bi_knowledge_plugin.py` | AEP-specific Plugin API; extract services, build adapter |
| BI Ingest | `docs/phases/BI_INGEST.md` | Preserve staging, schema, evidence, review, atomic commit |
| BI Vault / Search | `docs/phases/BI_VAULT.md` | Design contains unimplemented proposals; verify current indexing |
| BI Knowledge Asking | `bi__query` referenced in BI docs | Enforce retrieval and citation verification |
| LLM Wiki | `scripts/build_llm_wiki_plugin.py` | Adapt existing wiki pipeline and provenance |
| Telegram Collection Bots | `src/channels/telegram_collect.py` | Reuse bot mapping, durable cursors, hooks where appropriate |
| Telegram Main Bot | `src/host_runtime/telegram_loop.py` | Adapt to OpenCode agent/session routing |
| Ingest scheduling | User requirement | Immediate, scheduled and Run Now; verify native scheduling |
| Web GUI | `src/host_runtime/web_page.py` | Decide reuse vs fresh frontend |
| Image/file upload | Not yet verified end-to-end | Safe workspace, attachments and analysis |
| Plugin boundaries | `docs/phases/FEATURE_PLUGIN_ASSESSMENT_20261113.md` | Host coupling is significant; dependency audit needed |
| Knowledge benchmark | `benchmarks/knowledge_v1/` and proposals | Add gold-answer retrieval/grounding tests |
| Windows Bridge | Existing AEP extensions | Optional MCP/Tool integration; defer initial PoC |

## Gaps and risks to resolve
1. OpenCode ↔ LiteLLM compatibility and model tool calls.
2. Plugin portability and Host Runtime dependency graph.
3. Retrieval enforcement, evidence ranking and source citations.
4. Telegram Bot → Agent/Session isolation and durable scheduling.
5. Browser attachment upload and event streaming.
6. Data migration, provenance, backup, rollback and confidentiality.
7. Distinguish implemented Dashboard/Benchmark from draft specs.

## Evidence references
- https://github.com/dragon0816/agentic-engineering-platform/blob/main/docs/phases/BI_INGEST.md
- https://github.com/dragon0816/agentic-engineering-platform/blob/main/docs/phases/BI_VAULT.md
- https://github.com/dragon0816/agentic-engineering-platform/blob/main/docs/phases/FEATURE_PLUGIN_ASSESSMENT_20261113.md
- https://github.com/dragon0816/agentic-engineering-platform/blob/main/src/channels/telegram_collect.py
- https://github.com/dragon0816/agentic-engineering-platform/blob/main/scripts/build_bi_knowledge_plugin.py
