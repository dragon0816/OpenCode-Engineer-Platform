# Phase 3G BI document extraction

The workbench converts a text-layer PDF, approved public HTTPS page, text file, Markdown file, or HTML file into cited BI cards. The owner chooses a schema and destination, follows the extraction progress, reviews the validated batch, approves it, and publishes it. Assistants with `agent_knowledge_reads` access and model consent can answer from the published evidence.

## Owner demo

1. In a candidate build with an approved Gateway model configured, open **知識庫 → 建置 → 從文件建立卡片**. English uses **Knowledge Base → Build → Build cards from a document**.
2. Select a short PDF with a text layer. For the simplest demo, use a document with a clearly named product or process and one exact factual statement. To demo a page, go to **排程與工作 → 更多 → Telegram 收件 → 進階**. Add its origin under **核准的 HTTPS 來源（每行一個）**, select **儲存收件設定**, then enter the public page URL in the extraction panel.
3. Choose **文件筆記** or a schema and destination with fields the document can support. **匯入卡片結構** reads the `schemas/` directory of a local BI repository export. The list includes existing OEP BI destinations and one choice per supported imported entity type.
4. Enable **允許助理使用首次發布版本的證據** if you will demonstrate Q&A on a new destination. Select **擷取卡片**. Conversion and chunk counts appear as the run progresses. The panel lists candidates and any field-level validation findings.
5. Select **開啟審核**. Check the card title, field values, source, exact quote, and page, paragraph, or anchor. Approve the draft and publish it as a separate action.
6. In the assistant's settings, grant read access to the published knowledge base. With knowledge queries enabled for new sessions, open a session and ask a question that the quoted sentence answers. The citation shows the source reference and locator. The knowledge base's Q&A tab can also verify the publication.

## Source and worker integration

The owner authorized reuse from AEP HEAD `861d0c0ca0813073f3944d4aff88818980beff2a`. The temporary, shallow Git clone used a checkout with no working files and was removed from the temp directory through the Windows Recycle Bin. The port used source code only. The owner's market-intel export was outside this verification run.

| OEP file | AEP source and adaptation |
| --- | --- |
| `workers/bi/convert.py` | `cards/convert.py` text decoding, PDF page extraction, and whitespace normalization. OEP emits immutable page or paragraph segments. |
| `workers/bi/html_markdown.py` | `cards/html_markdown.py` standard-library visible HTML parser and charset detection. OEP prefers main content and retains anchors. |
| `workers/bi/extract.py` | `cards/extract.py` block splitting and evidence prompt. OEP adds bounded input and exact segment IDs. |
| `workers/bi/catalog.py` | `cards/catalog.py` schema file layout and structural identifiers. OEP projects names into its existing review schema. |
| `workers/bi/staging.py` | `cards/staging.py`, `cards/store.py`, and `cards/schema.py` content SHA-256 and stable normalized entity identity. OEP stores and stages records in its own ledgers. |
| `apps/adapter/src/bi/document-validation.ts` | `cards/extract.py` candidate shape and merge checks. OEP verifies the exact quote and its segment with the existing citation verifier. |
| `packages/knowledge/src/bi/link-intake.ts` | `inbox/fetch.py` page media negotiation and bounded response reading, adapted to OEP's existing approved-origin HTTPS and pinned DNS transport. |

AEP paths are relative to `feature_plugins/bi_knowledge/python/aep_bi/`. The ported files retain upstream attribution. The reused OEP file-references worker supplies process memory and CPU limits. The Python process receives bytes through stdin and has a wall-clock and output cap. The host sends model requests through its Gateway relay and uses the existing proposal staging and publication transactions. [AEP source revision](https://github.com/dragon0816/agentic-engineering-platform/tree/861d0c0ca0813073f3944d4aff88818980beff2a/feature_plugins/bi_knowledge)

## Service and limits

- Authenticated routes live under `/api/knowledge/bi-documents`. `GET /schemas` lists choices, `POST /schemas` imports structures, `POST /file/{schema}/{0|1}` accepts file bytes using the standard filename header, and `POST /link` accepts `url`, `schema`, and `allowModel`. (The route prefix applies to each path.) `GET /runs` shows the latest runs and `GET /runs/{id}` shows one run. The service also exposes the same operations directly for the future plugin page.
- `bi-documents.sqlite` under the adapter data root stores normalized content, schema projections, and run receipts. Conversion reuses a content hash and interpretation. Once staged, the review carries immutable segment references and the existing publish path carries verified excerpts. Repeating an unchanged input for the same destination reuses its valid review. A pending draft tied to an older publication base requires a fresh submission.
- The limits are 10 MiB per local file, 512,000 bytes and eight seconds per HTTPS fetch, 120 PDF pages, 160,000 normalized UTF-8 bytes and 1,500 segments, and 48 chunks per document. Each chunk carries up to 6,000 source bytes and requests up to 4,096 response tokens. The service runs one document at a time, tries up to three requests per chunk, and marks interrupted runs for resubmission. The source bar reports **需要 OCR，暫不支援** for image-only PDFs. In a mixed PDF, citations retain the original page numbers for the pages with a text layer.
- For imported AEP schemas, each entity type projects to a flat OEP schema of named, required text fields. A candidate enters review when every required field has direct evidence. The extraction report holds candidates with absent evidence, conflicting values, invalid quotes, or duplicates. The demo slice covers additive cards and uses normalized name and exact field matching for published duplicates.
- The web source must be directly readable over approved public HTTPS. HTML is parsed without scripts. The adapter retains the fetched title, URL, and timestamp. Published citations reference the source and locator alongside a verified quote.
- The bundled build installs the pinned `pypdf` wheel and emits its BSD-3-Clause notice and SBOM entry. For a regular build, run `& $env:OEP_PYTHON -m pip install --require-hashes -r tests/oracles/requirements.txt` in the candidate environment. The verification venv already had the pinned version. [Dependency decision](../DECISIONS.md)

## Verification

The Windows tests use fresh temporary `OEP_DATA_DIR` directories, the requested Python verification venv, synthetic Gateway replies, an in-test PDF, and a loopback HTTPS fixture with test-only TLS trust. The extraction suite covers PDF page citations, HTML anchors, strict quote matching at the cited segment, empty evidence, a forged value, long-document chunking and merge, retry and idempotency, duplicate detection, OCR status, the bilingual panel, manual review and publish, and agent Q&A with the published citation. Existing assertions were retained. Release determinism also checks the worker and pypdf license entry.

The first full `npm test` run reported 106 passes and one failure. The i18n contract could not resolve dynamically assembled status keys. Explicit message mappings fixed it, and the ordered rerun reported 107 passes. The first development-only extraction test also exposed a Windows fixture bug where the return value of recursive directory creation used a namespaced path. Passing the ordinary joined path preserved the test assertions and let the isolated runtime start.

The following gates ran sequentially on Windows with Node 24.14.1, npm 11.11.0, and Python 3.12.7. Setup used `npm ci`, the main checkout's `.phase0/assets` and `.phase0/source`, and the Phase 0 hooks configured for this worktree.

| Gate | Final ordered run |
| --- | --- |
| `npm run lint` | Passed, 299 source and configuration files checked |
| `npm run typecheck` | Passed |
| `npm test` | 107 passed, 0 failed |
| `npm run build:release` | Passed, `OEP-0.0.0-windows-x64.zip` built and scanned |
| `npm run test:e2e:browser` #1 | Passed, Chromium finished with 0 orphan processes |
| `npm run test:e2e:browser` #2 | Passed, Chromium finished with 0 orphan processes |
| `npm run test:e2e:knowledge` | 1 passed, 0 failed |
| `npm run test:ingest` | 16 passed, 0 failed |
| `npm run test:telegram` | 8 passed, 0 failed, synthetic credentials |
| `npm run test:release:determinism` | 1 passed, two ZIPs matched byte for byte |
| `npm run scan` | Passed, 0 hits across 773 files |
| `npm run test:bi-extraction` | 1 passed, 0 failed |

The standard release SHA-256 was `04c48beca793743884918227d782c4c463be008c6de13ef5b1657069966b0761`, matching both builds in the determinism test. Both earlier browser runs also passed. There were no observed load-related flakes.

The additional bundled determinism test passed with `OEP_TEST_BUNDLED=1`. Both ZIPs matched SHA-256 `e0bfa2aa44b155869152f61ca13a2ea51e2a7d82bae33e8a68f9609a63475833`. The unpacked Windows Python runtime imported `pypdf` 6.21.4.

## Remaining scope

Plugin packaging and the dedicated BI page are in the separate plugin slice. OCR, spreadsheet conversion in this panel, typed AEP fields and relationships, and partial chunk resume are outside this demo boundary. The optional owner-sample run and live Gateway validation were deferred. Reviewer-owned gates are Web HTTP, Excel, install, upgrade, and backup. The extraction staging database's backup and restore behavior needs that follow-up.
