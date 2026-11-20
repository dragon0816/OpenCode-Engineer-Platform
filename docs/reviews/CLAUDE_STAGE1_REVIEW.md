# Claude Code — Stage 1 獨立架構審查（2026-11-21）

> 撰寫時 **未讀** Codex 的 `CODEX_STAGE1_REVIEW.md`。本報告為獨立結論。
> 範圍有限：我在 token 用盡前完成的是「AEP 唯讀檢視 + OpenCode 官方文件/GitHub/npm 查證」。
> 每一項標示 **[已驗證]**（有一手來源）、**[推論]**、**[未驗證]**。

## A. 查證紀錄

### A1. AEP（唯讀，淺層 clone 至 OS temp，未修改、未 push）
- `dragon0816/agentic-engineering-platform` HEAD `c9961b2`（2026-11-20）。**[已驗證]** 可存取。
- **[已驗證] repo 為 PUBLIC，且 `licenseInfo = null`（沒有 LICENSE）**。無授權 = 預設保留所有權利。
  OEP 要移植 AEP 程式碼，必須先由 owner 明確決定授權（同一 owner 可自行授權，但要落地成文件/LICENSE）。
- **[已驗證] gap analysis 內容已落後程式碼**：BI Knowledge / LLM Wiki 已經是 `feature_plugins/bi_knowledge/`、
  `feature_plugins/llm_wiki/`（`plugin.json`：`aep-plugin/1`、`core_api` 1.2.0 ≤ v < 2.0.0、in-process Python 套件 `aep_bi`）。
  但 `docs/phases/BI_INGEST.md` 標「Spec… Nothing below is implemented unless §12 says so」、`BI_VAULT.md` 標「Nothing below is implemented」，
  而程式已有 `vault.py`(3070 行)、`runs.py`、`staging.py`、`store.py`。→ **文件狀態不可信，必須逐功能以程式碼/測試驗證**。
- **[已驗證] 耦合面（bi_knowledge 對 AEP 核心的 import 次數）**：`knowledge.repo` 27、`models.contracts` 13、`common.execution` 11、
  `agent.gateway` 6、`agent.backend_contracts` 5、`host_runtime.features` 4、`knowledge.questions` 3、`common.assets` 3、
  `models.approved` 2、`capabilities.runtime` 2、`host_runtime.platform_publish` 2。
  被依賴的核心體量：`src/knowledge` ≈ 10.6k 行、`knowledge/repo` ≈ 2.9k、`models` ≈ 1.8k、`agent/gateway.py` ≈ 2.1k。
  **結論：Phase 3 不是「搬資料夾」，而是抽出 ~15k 行的 knowledge/models/common 依賴，或重寫其介面。**
- **[已驗證] UI 是 Python 內嵌 HTML**：`bi_page.py` 9.5k 行、`web_page.py` 9.1k 行、`wiki_page.py` 2.0k 行。不適合直接重用。
- **[已驗證] Telegram**：`channels/telegram_collect.py`(380 行) 每個收集 bot 獨立 polling、durable cursor
  (`telegram-collect.<name>`；`state.cursor` / `advance_cursor`)、僅 mapped sender、**內容不進模型**直送 feature 的 `telegram_item` hook。
  `host_runtime/telegram_loop.py`(68 行) 以獨立 thread + asyncio loop 跑在 Agent Web 內。依賴 `channels.telegram`、`models.wire`、`models.credentials`。
  → 設計（cursor、sender mapping、不進模型）可借用；程式碼需改寫。
- **[已驗證] Knowledge benchmark**：`benchmarks/knowledge_v1/README.md` 自述「harness check, **not** a gold-answer test」，1,100 題來自 owner 的 R&S 檔案
  （`RS_Knowledge_1100_Benchmark_Questions.md`），判官為公司 Gateway 模型。grader 會檢查「引用檔案存在於 Vault 且段落文字在其中」——
  **這個 citation 驗證邏輯可借用**；題庫與 R&S 內容不得進公開 OEP repo。
- **[已驗證]** AEP：Python ≥ 3.11，測試檔 612 個。AEP 另有合成假資料：`tests/fixtures/robotics_kb_sample/`、`bi_vault_example/`（可作 OEP fixture 的參考）。
- **[已驗證] 歷史 false-success 案例**：`FEATURE_PLUGIN_ASSESSMENT_20261113.md` 末段提到 legacy form「解說被當執行成功」。
  AEP 的對策是 per-turn、記憶體內的 `TurnEffects`（**重啟後不持久**，AEP 自己也承認）。

### A2. OpenCode
- **[已驗證]** npm `opencode-ai` latest = **1.19.6**（2026-11-17），MIT；GitHub repo 現為 `anomalyco/opencode`（sst/opencode 轉址），228k stars。
- **[已驗證] 兩條版本線並行**：GitHub releases 最新為 **v2.3.2（2026-11-18）**，同時仍發 v1.19.6。v1.19.6 release note：「OpenCode 1 now offers the upgrade to OpenCode 2.0… **Plugins made for OpenCode 1 need an update**」。
  官網文件有 `V2 (latest)` 與 `V1` 兩套，且有 `Migrate from V1`。**→ 「pin 哪個版本線」是 Phase 0 的第一個決策，計畫書完全沒提。**
- **[已驗證] V2 Server API 文件自稱「Experimental HttpApi surface」**，173 operations / 518 schemas，OpenAPI 3.1。
  有 `/api/pair`（一次性配對碼 → 瀏覽器 session cookie 或 token 作 password）、`/api/session`（建立、列表、`parentID` 子 session）、`/api/agent`、`/api/location/reload`、PTY、Worktree、Skill、MCP、Permission、Event 等路由群。
  → **API 穩定性風險高**；需契約測試，且所有呼叫須收斂在單一 client 介面後。
- **[已驗證] V2 附件**：prompt 附件以 `{uri, name, description}`；`file://` 絕對路徑或 `data:` URL；**不支援 HTTP(S) URL**；單檔解碼後 ≤ 20 MiB；
  模型可見：UTF-8 文字、目錄（非遞迴）、PNG/JPEG/GIF/WebP、PDF（需模型支援 PDF input，否則只送一段說明）；SVG 當文字；**音訊/影片/其他二進位不送模型**。
  → **Excel (.xlsx) 不在可見清單**，需先轉換（CSV/Markdown）。圖片預設自動縮到 2000px / base64 5 MiB。
- **[已驗證] Agent / Session**：agent 可由 `.opencode/agents/*.md` 或 `agents` JSONC 定義，`mode: primary|subagent|all`，含 model、permissions、system prompt；session 可有 parent。
- **[已驗證] 自訂 provider**：`providers.<id>.package = "@opencode/ai/providers/openai-compatible"` + `settings.baseURL` + `headers` + `body` + `compatibility`（處理 API quirks）+ `env` 取 credential。→ 接 LiteLLM **設定上可行**。
- **[已驗證（弱）] 無原生排程**：查 config / tools / skills / mcp-servers / plugins / permissions / network 文件，未見 scheduling/cron；僅 Code Mode runtime 說明「no timers」。
  這是「在這幾頁沒找到」，**不是窮盡證明**；Phase 0 要用 OpenAPI 全量 grep + 實測確認。→ 排程歸 adapter（與計畫一致）。
- **[未驗證]** SSE 事件端點的路徑/事件型別/重連語義；server 綁定位址、密碼/CORS/Origin 檢查；`opencode serve` 在 1.19.6 與 2.3.x 的實際差異；
  **LiteLLM tool-calling 實測**（含你們公司 gateway 後面的實際模型、串流 tool call、parallel tool calls）；Windows 上 server 生命週期。

## B. 架構評估
計畫方向正確（OpenCode 當 harness、adapter 薄、單人本機）。主要擔憂：

1. **「薄 adapter」會膨脹**：session 映射 + Telegram + 排程 + 檔案 workspace + BI ingest job + 事件轉發 + 密鑰管理，加起來就是一個小型 control plane。
   必須在 Phase 0 畫出「adapter 擁有什麼、絕不擁有什麼」，並以測試強制（例如 adapter 不得自行呼叫 LLM 做規劃）。
2. **OpenCode 版本線不確定**（見 A2）是最大的外部風險：V1 即將被取代、V2 API 標示 experimental。
3. **Phase 3 低估**：依賴 ~15k 行核心 + 59k 行 plugin + 9.5k 行 Python-in-HTML UI。建議把 BI 領域邏輯當「資料格式 + 純函式庫」抽出，UI 全新做。
4. **知識問答的「必須檢索並引用」不能靠 prompt**（見 E3）。
5. **Phase 順序**：知識品質基準（用 AEP 現行系統量 baseline）應在 Phase 0/1 就建立，否則 Phase 3 無法證明「不退化」。

## C. 風險（精簡）
| ID | 風險 | 可能性 | 影響 | 緩解 | Phase |
|---|---|---|---|---|---|
| R1 | OpenCode V1/V2 版本線與 API experimental 變動 | 高 | 高 | 精確 pin；OpenAPI 生成 client；契約測試；升級需過回歸 | 0–1 |
| R2 | LiteLLM tool-calling / 串流不相容 | 中 | 高 | Phase 0 spike：以真實 gateway 跑 tool call、並行 tool、錯誤碼 | 0 |
| R3 | AEP 無 LICENSE 且為 R&S 公司內容關聯 | 高 | 高 | owner 決定授權；只移植通用邏輯；R&S 題庫/真實資料不入 repo；用合成 fixture | 0 |
| R4 | Plugin 耦合（knowledge.repo 等） | 高 | 高 | 先做耦合清單 → 決定「抽 library」vs「重寫」；以 AEP 測試做 characterization | 3 |
| R5 | 檢索/引用無法強制 | 中 | 高 | 結構性強制（E3） | 3 |
| R6 | 排程不存在於 OpenCode | 高 | 中 | adapter 持久化 job table；冪等 key（沿用 AEP「commit key = run id」） | 4 |
| R7 | Telegram session 混線 / cursor 遺失 | 中 | 中 | `(bot, chat_id)→session_id` 映射表；cursor 先持久化再確認；BI bot 內容不進模型 | 4 |
| R8 | 附件：xlsx 不可見、20MiB、`file://` 路徑逃逸 | 高 | 中 | 上傳→per-session 目錄→驗證後產生 `file://`；xlsx 先轉換；拒絕 symlink/`..`/ADS | 2 |
| R9 | False-positive success（腳本假成功） | 中 | 高 | 驗收看產物：exit code + 以 openpyxl 開啟 + 與期望值比對 + 偵測 no-op；失敗須可追溯 | 1 |
| R10 | 本機 API 暴露（localhost 被其他網頁/DNS rebinding 攻擊） | 中 | 高 | 綁 127.0.0.1、隨機密碼/pairing、Origin 檢查、不信任 CORS `*` | 2 |
| R11 | Windows 程序生命週期（子程序殘留、路徑、`file:///C:/`） | 高 | 中 | Job Object / 明確 stop；路徑正規化測試 | 1–2 |
| R12 | 資料遷移 / provenance / 回滾 | 中 | 高 | 沿用 AEP 的「SQLite 是投影、repository units 是真相」；先 dry-run 匯入 + 比對卡片數與 evidence | 3,5 |

## D. 缺口（計畫與 gap analysis 未列）
- **OpenCode 版本線決策**、升級政策、契約測試。
- **授權/保密盤點**（AEP 無 LICENSE；R&S 題庫；`docs/` 內公司資訊）。
- **設定與密鑰管理**（LiteLLM key、Telegram token 存放；公開 repo 的 `.gitignore`/secret scan/pre-commit）。
- **可觀測性**：結構化 log、run id 貫穿 OpenCode session ↔ ingest run ↔ Telegram update。
- **測試策略**：合成資料、CI（Windows runner）、錄製式契約測試、需要真模型的 test 分層與預算。
- **備份/還原** 只在 Phase 5，應該在 Phase 3 資料落地時就設計。
- **持久化 effect ledger**：AEP 的 TurnEffects 重啟即失；OEP 若要「不重跑不確定的寫入」需持久化（這是 adapter 責任之一，要明確寫出）。
- Excel 輸入/輸出路徑（xlsx 不是 OpenCode 可見附件）。

## E. 建議
1. **Phase 0 新增 spike 清單**（各有明確產出與 pass/fail）：
   S1 版本線決策（V1 1.19.6 vs V2 2.3.x；建議預設 **V2 最新穩定 + 單一 client 介面**，因 V1 正被取代，但以 spike 結果為準）；
   S2 LiteLLM tool-calling；S3 附件（PNG、PDF、xlsx→轉換）；S4 SSE 事件與斷線重連；S5 server 安全（綁定/密碼/Origin）；S6 Windows 生命週期；S7 授權盤點。
2. **技術選型**：domain services（BI/Wiki/ingest/Telegram）用 **Python**（可沿用 AEP 概念與測試思路，避免跨語言重寫 59k 行）；
   OpenCode 以 HTTP/OpenAPI 存取，不綁 TS SDK。前端 **全新**（輕量 SPA 或 server-rendered），不重用 AEP 的 Python-in-HTML。
   **待 owner 決定**：聊天頁是否直接用 OpenCode 內建 web client + 自建 BI 審核頁，以大幅縮小 Phase 2。
3. **強制檢索與引用**：提供 `knowledge_ask` MCP tool，在 tool 內完成「檢索 → 組裝 → citation 驗證（引用段落必須存在於檢索結果）→ 不足則 abstain」；
   知識 agent 的 permission 只開此 tool；回覆經確定性 verifier 才回傳。借用 AEP `benchmarks/knowledge_v1` 的 citation 檢查概念，另補 gold-answer 小集（合成資料）。
4. **排程**：adapter 內 SQLite job table（`id, kind, run_at, status, attempts, idempotency_key`），啟動時 reconcile；Windows 用單一常駐 launcher，不依賴 Task Scheduler。
5. **Phase 3 拆分**：3a 唯讀（匯入既有 vault → 搜尋 + `knowledge_ask` + benchmark）；3b ingest/staging/review/publish。3a 先證明品質不退化。
6. **建議 repo 佈局**：`launcher/`、`adapter/`（sessions、jobs、telegram、workspace）、`services/bi/`、`services/wiki/`、`mcp/knowledge/`、`web/`、`tests/{unit,contract,e2e}`、`docs/`。
7. **Public repo 守則**：pre-commit secret scan、`fixtures/` 僅合成資料、AEP 程式碼僅在 LICENSE 決定後以「重寫 + 註明來源」方式移植。

## F. 各 Phase 驗收（可測）
- **P0**：七個 spike 各有報告；`ARCHITECTURE_DECISIONS.md` 含 pin 版本號 + 授權決議；LiteLLM tool-call spike 以真實 gateway 通過 ≥ 20 次連續呼叫（含並行 tool）；owner 簽核 v2。
- **P1**：SOP/PDF→程式→Excel 連續 **5/5** 次成功；每次輸出以 openpyxl 開啟並與期望值逐格比對；刻意注入失敗（錯誤程式、空輸出）**必須**被判失敗；每個 run 有可追溯 log（session id、exit code、artifact hash）。
- **P2**：一鍵啟動（無終端機）；上傳 PNG/PDF 成功分析；路徑逃逸測試（`..`、symlink、`file://` 任意路徑、ADS）全拒絕；server 僅綁 127.0.0.1，Origin 不符請求被拒；SSE 斷線重連不丟事件（測試）。
- **P3a**：既有 vault 匯入後卡片數、關係、evidence 與來源一致（比對報告）；`knowledge_ask`：有證據題 citation 驗證通過率 ≥ 約定門檻（owner 定）、無證據題 abstain 率 ≥ 門檻；未檢索即回答的路徑在測試中**無法**達成。
- **P3b**：ingest→staging→人工 review→publish 全流程；未經 review 無法 publish（測試）；同一 run 重複 commit 冪等；寫入失敗不留半套（交易測試）。
- **P4**：Main/BI bot session 隔離測試；殺掉程序後 cursor 不遺失、不重複處理；排程「立即/定時/Run Now」三者皆有測試；無法抓取的社群連結保留連結並回報，不編造內容。
- **P5**：全部關鍵情境腳本化可重跑；備份→還原後資料逐項比對一致；升級/回滾演練各一次。

## G. 給 owner 的問題
1. 是否授權在 AEP 加 LICENSE，或指定 OEP 可重用其程式碼的範圍？（AEP 內含 R&S 相關內容與題庫。）
2. OpenCode 版本線：同意以 spike 結果決定 V1/V2？
3. 聊天 UI 是否可直接使用 OpenCode 內建 web client？
4. 知識問答的通過門檻（citation 通過率、abstain 率）要多少？
5. Telegram 社群連結抓取：可接受的失敗處理與合規邊界？

## H. 預期與 Codex 可能分歧的 5 個立場
1. **V2 vs V1**：我傾向 V2（V1 在被取代），但 API experimental，需契約測試；Codex 可能主張 pin V1 求穩。
2. **Python 作 domain service**：Codex 可能主張 TypeScript 以貼近 OpenCode SDK/生態。
3. **前端全新**而非重用 AEP 前端（以及是否直接用 OpenCode web client）。
4. **Phase 3 拆 3a/3b** 並把 benchmark baseline 前移到 Phase 0/1。
5. **檢索強制用 `knowledge_ask` tool + permission 限制**，而非 prompt/hook 級別的約束。

## 未完成的查證（我 token 不足而停止）
OpenAPI 全量下載與 grep（SSE/排程/auth）、`opencode serve` 於 1.19.6 vs 2.3.2 的差異、LiteLLM 實測、`knowledge_query` 與 `bi__query` 的實際強制機制讀碼。這些請列入 Phase 0 spike。
