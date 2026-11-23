# Phase 3G BI Knowledge plugin

## 擁有者展示流程

1. 啟動這次的候選版 OEP，確認 Gateway 模型可用。開啟 **能力 → 外掛 → 從檔案安裝**，選擇 `dist/plugins/BI-Knowledge.oepplugin`，確認權限後安裝。
2. 開啟 **主功能 → BI 知識庫**。輸入新知識庫名稱，選一份可選取文字的 PDF。也可以改填一個公開 HTTPS 網址，或選文字檔。
3. 選擇 **文件筆記**。若要使用既有的卡片結構，先選 BI 匯出資料夾，再按 **匯入卡片結構**，從清單選擇。勾選 **允許助理使用首次發布版本的證據**，按 **轉換並擷取**，查看處理進度。
4. 在 **驗證** 檢查卡片、引文、頁碼或網頁定位。若有缺證據或重複卡片，報告會列出原因。確認後按 **送審**。
5. 按 **開啟審核與發布**。核對卡片與引用，先按 **核准**，再按 **發布**。回到 **BI 知識庫**，查看版本及卡片、來源、證據數量。要加入第二個來源時，沿用同一個名稱與卡片結構，發布下一版。
6. 若要示範完整的 BI 匯出，在 **BI 知識庫** 選擇包含 `repo.json`、`tags/`、`publish/` 與 `published/` 的資料夾。勾選助理使用證據的選項，按 **從 BI 匯出資料夾建置**，確認上游標籤、驗證結果和數量，再依上一步送審並發布。
7. 在助理設定勾選剛發布的知識庫並儲存。開啟該助理的會話，輸入 `/ask`，選取這個知識庫並問一個有明確證據的問題。打開引用查看來源。到 **能力 → 外掛** 移除 BI 知識庫外掛，再問同一題，確認原來的知識庫和引用仍可使用。

## Package and integration

- `npm run build:plugin:bi` produces the unsigned `dist/plugins/BI-Knowledge.oepplugin`. The release build emits the same standalone asset, includes it under `plugins/` in the Windows ZIP, and lists it in the release manifest. Windows CI uploads the standalone asset alongside the ZIP. Install the ZIP as a candidate on a separate data root. The standard release needs OEP's configured Python 3.12 with the pinned `pypdf` dependency. The bundled release supplies it.
- The worktree branch starts from `main` at `6a65ae4`. It merges `review/bi-extraction` at `5fbd89d` first and `phase-3g/slice-1b-plugin-runtime` at `4ff3132` second. The Web store retains the v9 model-source migration, the v10 local-reference migration, the v11 references-only reconciliation, and the v12 plugin registry. Snapshot reconciliation verifies all three groups of tables and requires the new tables to be empty on first addition. The upgrade fixture adds an integrated v11 input to the existing v8, v9 and two v10 inputs. The standalone plugin spike's development database jumped from v8 to v12 and its report calls for a fresh data root when testing the combined branch. The knowledge and Telegram store versions stay at their prior values. The BI staging ledger uses its existing JSON status column for validated drafts. [Plugin migration contract](PHASE3G_SLICE1_REPORT.md)
- Installed workers read explicit bytes through the plugin runtime and run in the Windows Job and AppContainer. The host fetches public HTTPS through its pinned-address broker, uses the configured Gateway to extract candidates, and verifies evidence against the normalized segments. The page separates validation from submission. The central review service owns approval and publication. The original knowledge-panel entry stays available for upgrades and use without the plugin. The workbench hides that entry whenever the BI plugin is installed.
- Repository import reuses the existing immutable, read-only repository reader and its publication and snapshot checks. It preserves upstream card, relationship and evidence structures. The validated report counts cards without a citable passage. The central owner review publishes the normalized snapshot into a separate local knowledge base and builds its search index. The imported review draft is read-only. Assistants use the same core knowledge reader and `agent_knowledge_reads` after the plugin is removed.
- The assertion changes update the integrated Web target from 11 to 12 while preserving the historical starting versions, row and rollback checks, and exact assertions for other stores. The original BI PDF generator moved to a shared synthetic fixture. Existing extraction, duplicate, citation and authorization assertions remain in place.

## Extraction regression

An archive of `review/bi-extraction` at `5fbd89d` reproduced the Traditional Chinese validation-status timeout. The test exited 1 after 37.5 seconds.

The 0.8 attachment work changed the shared Web request helper to read `file.content`. BI extraction still passed a raw browser `File`. The helper received no request body, selected GET and omitted the CSRF header. The adapter never started conversion. The panel now passes the selected file's name, media type and bytes in the shared upload format. The Chromium test checks POST, CSRF, exact byte count and HTTP 202 before waiting for the original validation and review assertions.

The first run on the combined branch exposed a separate startup failure. The merged Windows Job source needed the `System.Security.Principal` import for the retained restricted-token code. The source compiled in both PowerShell 7 and Windows PowerShell after the import was restored.

With both fixes in place at `833235d`, three consecutive `npm run test:bi-extraction` commands passed in 12.35 s, 10.06 s and 10.07 s. Each ran with a fresh temporary data root and reported one pass, zero failures and zero skips.

## BI acceptance coverage

`npm run test:e2e:bi-plugin` installs the release artifact using the Chromium consent dialog. It imports a synthetic card schema, processes a two-page PDF in Traditional Chinese and a TLS-served HTML fixture in narrow English, and stages and publishes two revisions of the same knowledge base. It also builds a separate knowledge base from a synthetic repository export with upstream tags, commits, cards, schemas and published SQLite. The test checks pending reviews cannot publish, approved reviews await a separate publish action, and assistants cannot bind before publication. It binds both bases through the assistant settings API, verifies the PDF page, HTML anchor and repository passage citations, and asks again after uninstall and after restarting the adapter.

Set `OEP_MARKET_INTEL_DIR` for the opt-in owner-export test. The test uses an isolated temporary data root, opens the export read-only, and reports only the stage on failure. It skips when the folder is unavailable. The default model reply is synthetic. To use the configured Gateway, also set `OEP_LIVE_GATEWAY=1`. That sends the question and its retrieved evidence to the Gateway. Screenshots are generated only by the synthetic flow.

An additional run pointed the optional test at a freshly generated synthetic export. Installation, approval, publication, assistant citations and the query after uninstall passed in 6.68 s.

## 雙語流程截圖

| 步驟 | 繁體中文 | English, 390 px |
| --- | --- | --- |
| 1 來源 | [選 PDF](../validation/bi-plugin/zh-TW-1.png) | [Select HTTPS source](../validation/bi-plugin/en-1.png) |
| 2 轉換 | [轉換進度](../validation/bi-plugin/zh-TW-2.png) | [Conversion progress](../validation/bi-plugin/en-2.png) |
| 3 擷取 | [擷取進度](../validation/bi-plugin/zh-TW-3.png) | [Extraction progress](../validation/bi-plugin/en-3.png) |
| 4 驗證 | [PDF 引文及頁碼](../validation/bi-plugin/zh-TW-4.png) | [HTML quotation and anchor](../validation/bi-plugin/en-4.png) |
| 5 送審 | [已送審](../validation/bi-plugin/zh-TW-5.png) | [Submitted for review](../validation/bi-plugin/en-5.png) |
| 6 發布 | [知識庫發布摘要](../validation/bi-plugin/zh-TW-6.png) | [Published knowledge base summary](../validation/bi-plugin/en-6.png) |

## Ordered verification

Windows x64 verification used Node 24.14.1, npm 11.11.0, and Python 3.12.7. Setup ran `npm ci`, copied the main checkout's `.phase0/assets` and `.phase0/source`, and activated the Phase 0 hooks for this worktree. Each gate received a fresh temporary `OEP_DATA_DIR`. The test process used the verification Python venv first on PATH and set `OEP_PYTHON` to that interpreter. Logs are in `.phase0/bi-plugin-gates/`.

The preliminary plugin test timed out importing its synthetic schema because the fixture filename omitted the required `@1.0.0` suffix. The corrected fixture and unchanged check passed on the next run. The final ordered BI plugin gate also passed. The owner sample and live Gateway were skipped because the sample environment variable was unset.

The first determinism gate exited 1 in 44.4 s after both ZIPs matched the release hash. The new payload assertion compared a `Uint8Array` from the release reader with a `Buffer` from the plugin reader. The retry compares both as buffers and retains the exact-byte assertion. No release code changed for this retry.

| Gate | Exit | Time | Observed output |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.31 s | 378 source and configuration files checked |
| `npm run typecheck` | 0 | 6.12 s | TypeScript completed |
| `npm test` | 0 | 28.96 s | 122 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 50.18 s | Built and scanned the Windows x64 ZIP and packaged the plugin |
| `npm run build:plugin:bi` | 0 | 1.09 s | Built `dist/plugins/BI-Knowledge.oepplugin` |
| `npm run test:e2e:browser` run 1 | 0 | 147.85 s | Chromium passed, 0 orphans |
| `npm run test:e2e:browser` run 2 | 0 | 150.46 s | Chromium passed, 0 orphans |
| `npm run test:e2e:knowledge` | 0 | 28.61 s | 1 passed, 0 failed |
| `npm run test:ingest` | 0 | 4.33 s | 16 passed, 0 failed |
| `npm run test:telegram` | 0 | 37.30 s | 8 passed, 0 failed |
| `npm run test:bi-extraction` | 0 | 10.36 s | 1 passed, 0 failed |
| `npm run test:e2e:bi-plugin` | 0 | 28.93 s | 1 passed, 0 failed, 1 opt-in test skipped |
| `npm run test:plugins` | 0 | 42.05 s | 9 passed, 0 failed |
| `npm run test:contract:native:isolation` | 0 | 23.82 s | 5 passed, 0 failed. Both supervisor receipts reported 0 orphans |
| `npm run test:release:determinism` retry | 0 | 46.36 s | 1 passed, 0 failed. Both ZIPs and the plugin payload matched |
| `npm run scan` | 0 | 1.62 s | 875 files, 0 hits |

The Windows ZIP SHA-256 is `1b15fe9bc4d7dffdce8fc343ade0e7bf241e59602648587402be4e2a67163a36`. The BI plugin SHA-256 is `179d44fc2210d4bf895c8f4a213a63903324ca71f18a76c5c94accd6b91e3aae`.

## Reviewer follow-up

- Dedicated Web HTTP, Excel, install, upgrade and backup gates.
- Owner validation with the market-intel export and a configured Gateway.
