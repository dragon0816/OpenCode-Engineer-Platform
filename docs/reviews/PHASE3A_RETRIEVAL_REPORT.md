# Phase 3a retrieval and Gateway follow-up

Base `00735ef`. All fixture and live benchmark inputs in this report are synthetic.

## 3a-R1 retrieval — VERIFIED

| Synthetic repository mirror | Recall@5 before | Recall@5 after |
|---|---:|---:|
| Gold v1 questions with v2 distractors | 24/24 | 24/24 |
| Noisy forecast mirror, Traditional Chinese and English | 0/2 | 2/2 |

Both columns use the product store and the same mirror generators. The first column ran against the base retrieval implementation. The forecast mirror adds 24 repeated excerpts, eight frontmatter lines and one numerical forecast. Both forecast questions produce a verified verbatim quote with the original source, locator and SHA-256 in the contract test. The unsupported warranty question abstains before inference. The live gold benchmark also covers conflicts, prompt injection and questions with missing evidence.

Retrieval groups candidates by NFC text with collapsed whitespace and retains original passage, card and source IDs, locators and hashes. The strongest FTS5 match represents each group. Ranking rewards matching numeric tokens and CJK bigrams and discounts metadata-shaped single lines unless the question strongly matches the key or value. The five-passage ceiling and 20,000 UTF-8 byte budget apply to the body of the evidence. The FTS5 index still contains individual rows, so duplicates can affect BM25 corpus statistics. Candidate grouping and ranking scan the active snapshot and its FTS matches per query. Performance beyond the existing 1,000-passage test is **UNVERIFIED**.

## Live synthetic repository benchmark — VERIFIED

`npm run knowledge:benchmark -- --repository` exited zero. The D03 thresholds are Recall@5 ≥85%, unanswerable abstention ≥95%, usable answers ≥90%, reproducible citations 100% and zero critical unsupported claims.

| Alias | Recall@5 | Usable answers | Unanswerable abstentions | Reproducible citations | Critical unsupported | Errors | Misses |
|---|---:|---:|---:|---:|---:|---:|---|
| `gpt-5.4-mini` | 24/24 | 22/24 | 24/24 | 22/22 | 0 | 0 | A12, A24 |
| `claude-haiku-4-5-20251001` | 24/24 | 24/24 | 24/24 | 24/24 | 0 | 0 | None |

GPT abstained on A12 and A24. Retrieval supplied each answer passage and a non-answering passage on the same topic. The previous Haiku D03 miss involved an irrelevant extra citation on A12. Retrieval still supplied the same-topic distractor alongside the correct passage, giving the model an irrelevant citation option. Haiku cited only the correct passage in this run. Whether the earlier error will recur is **UNVERIFIED**. [Prior result](PHASE3B_GATE_REPORT.md)

## 3a-R2 Gateway rejection — VERIFIED

A synthetic 400 went through the relay, Ask and Chromium. The Web displayed the fixed Traditional Chinese explanation and the Gateway mock counted one request. A contract test also checks a terminal 403, verifies the exact Ask result shape, and confirms two attempts for 429 and 502. The real Gateway filter trigger and the owner’s real repository after the change are **UNVERIFIED**.

## Required gates — VERIFIED

| Gate | Result |
|---|---|
| `npm run lint` | Passed, 129 files checked |
| `npm run typecheck` | Passed |
| `npm run test` | 49 passed |
| `npm run scan` | Zero hits |
| `npm run test:ingest` | 11 passed |
| `npm run test:knowledge` | 11 passed |
| `npm run test:e2e:knowledge` | 1 passed, Chromium and native OpenCode MCP |
