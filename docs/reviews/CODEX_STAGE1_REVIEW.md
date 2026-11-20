# OEP Stage 1 獨立架構審查

日期 2026-11-21（Asia/Taipei） · 審查對象 OEP Implementation Plan v1.0 · [報告檔案](C:/Users/OpenLab/Documents/claude/OpenCode-Engineer-Platform/docs/reviews/CODEX_STAGE1_REVIEW.md)

**結論**　OpenCode 可作為 OEP 的 agent runtime。建議修訂 v1.0 後再批准實作。v2 應鎖定 OpenCode 2.3.2 的 API，將公司 LiteLLM、Windows 程序與附件列為 Phase 1 的驗證門檻，並把「檢索後才能回答」與「產物驗收後才能報成功」寫入可測試的系統契約。OpenCode 2.3.2 已有原生實驗性排程。OEP 仍適合自己管理 BI ingest 工作，因為審核、來源保留、恢復與通知需要獨立於 agent 訊息的狀態。

## A. 查證紀錄

先讀 OEP `README.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/AEP_FEATURE_GAP_ANALYSIS.md`、`docs/T3_CODE_REVIEW_BRIEF.md`，基準 commit `7b76bfedea77cf4282035c2f93fd29a7aa72af78`。AEP 可公開讀取，已在 OS 暫存目錄唯讀檢查 `main@c9961b2d0d66eef3892375213ce305883ebde960`。OpenCode 亦以 repo 外的暫存 checkout 核對標籤、OpenAPI 與實作。以下的「已查證」指檔案、介面或原始碼行為。實際部署、執行結果與公司環境標為 **UNVERIFIED**。本階段未建置、未啟動服務、未跑測試、未呼叫公司 Gateway 或 Telegram，亦未讀其他 Stage 1 報告。 [AEP 固定快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)

### AEP 路徑與可證實範圍

| 路徑 | 已查證及其界線 |
|---|---|
| `docs/phases/BI_INGEST.md` | §4、§8、§12 記錄 staging、逐欄 evidence、schema 版本檢查、人工選擇及 commit。§12 的 AI 路徑驗收使用 scripted model。固定快照的 `feature_plugins/bi_knowledge/python/aep_bi/cards/staging.py` 與 `store.py` 有存取、`commit_run` 和 `undo_import` 實作。整批跨儲存媒介的故障恢復及真實 provider 結果 **UNVERIFIED**。 |
| `docs/phases/BI_VAULT.md` | 檔首保留設計狀態，§11 逐項記錄 V2–V5 已完成。上述 `cards/` 下的 `vault.py` 有 replay、衝突及發布快照路徑，`search_index.py` 有 card/chunk FTS5、重建與查詢，`quality.py` 存在。§6 記錄 `bi__query` passage 使用 index，card 查詢仍可走 substring。共享 vault 的實際併發與索引覆蓋 **UNVERIFIED**。 |
| `docs/phases/FEATURE_PLUGIN_ASSESSMENT_20261113.md` | 記錄早期 Host 耦合與拆分提案。現行 BI/Wiki manifest 和入口已搬移部分功能，仍掛接 AEP `Feature`。`feature_plugins/bi_overview/manifest.json` 另有唯讀 metadata worker，`docs/phases/FEATURE_PLUGIN_BI_ACCEPTANCE_20261115.md` 記錄其 Plugin API 1.1 驗收。該紀錄的部署結果 **UNVERIFIED**。 |
| `scripts/build_bi_knowledge_plugin.py`、`scripts/build_llm_wiki_plugin.py` | 兩者的 `package_bytes()` 都以 AEP `common.plugins.PluginManifest/PluginPackage` 打包 in-process feature。對應 `feature_plugins/{bi_knowledge,llm_wiki}/plugin.json` 指向 `aep_bi.feature`、`aep_wiki.feature`。前者有 capability、Web、answer 與 Telegram hooks，後者也依賴 AEP Host 與 Knowledge repository。單獨安裝到 OEP 的能力 **UNVERIFIED**。 |
| `src/channels/telegram_collect.py` | 有每 bot 各自的 cursor、sender mapping、文件下載及 `FeatureSet` hooks。L234–259 以記憶體 `_seen` 去重，處理後另寫 offset。L313–323 捕捉 hook 例外後回傳失敗，外層仍可前推 cursor。由此推論 crash 或 hook failure 可造成重複或遺失。端到端重現 **UNVERIFIED**。 |
| `src/host_runtime/telegram_loop.py` | `ResidentTelegram` 在 Agent Web 內用背景 thread 管理 `TelegramIngress`，並有停止路徑。主 bot 的 cursor、投遞及 turn ID 在 `src/channels/telegram.py`。跨 bot 或跨程序隔離的部署結果 **UNVERIFIED**。 |
| `src/host_runtime/web_page.py` | `page()` 組合 feature fragments。對話與排程直接使用 AEP Host API，如 `/api/conversations/turn` 與 `/api/schedules/create`。可參考互動流程，整頁移植的相容性 **UNVERIFIED**。 |
| `benchmarks/knowledge_v1/` | 已查 `README.md`、`run.py`、`evidence.py`、`judge.py`、`reference_grade.py` 與 question/reference/trace 目錄結構。含 chat/direct、離線 regrade、vault passage 檢查、reference grading 與 self-test。部分 fallback 會以來源路徑推定使用段落，不能據此證明逐 claim 引用。未重跑或採信既有分數。 |
| 補查 `feature_plugins/bi_knowledge/python/aep_bi/inbox/{api,bot,process,runtime,scheduler,store}.py`、`tests/test_bi_inbox.py` | 有 inbox SQLite、domain 路由、去重、collect/remind 時點、來源處理、候選等待人工審核，以及 commit 後測試／Dashboard 路徑。2026-11-19 的 `docs/phases/TELEGRAM_LINK_COLLECTION_ASSESSMENT_20261119.md` 是早期方案，不能當成 11-20 快照的實作狀態或 OEP bot 數量裁決。社群平台可取到的內容、真實通知及 crash recovery **UNVERIFIED**。 |

AEP GitHub metadata 的 `license` 為 `null`，固定快照未見根目錄通用 `LICENSE` 或 `COPYING`，部分 vendor 目錄另有授權檔。AEP 程式、schema、素材和資料的公開重用權均 **UNVERIFIED**。快照有追蹤 `.env` 檔名，本次未讀取其內容。使用自行撰寫的程式和合成 fixtures，逐項取得書面授權後才納入可重用項目。 [AEP repository metadata](https://api.github.com/repos/dragon0816/agentic-engineering-platform)

### OpenCode 發行基準與 API

**固定 OpenCode v2.3.2**，GitHub 正式非 prerelease 發布於 **2026-11-18 01:35:12 UTC**，tag commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`，有 Windows x64/arm64 release assets。GitHub `/releases/latest` 與舊 npm `opencode-ai`、`@opencode-ai/sdk` 指向 1.19.6，舊套件名查 2.3.2 回 404。按 GitHub release 列表及新版 `@opencode/cli`、`@opencode/client`、`@opencode/sdk` 的 npm metadata 交叉確認 2.3.2。以下以該 tag 的 `packages/protocol/openapi.json` 為準，其 schema `info.version` 是 `0.0.1`。OEP 應鎖 binary、client 及 spec hash。 [v2.3.2 發行頁](https://github.com/anomalyco/opencode/releases/tag/v2.3.2) · [GitHub release 列表](https://api.github.com/repos/anomalyco/opencode/releases?per_page=5) · [npm CLI](https://www.npmjs.com/package/@opencode/cli/v/2.3.2) · [npm client](https://www.npmjs.com/package/@opencode/client/v/2.3.2) · [固定 OpenAPI](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/openapi.json)

| 查證項 | v2.3.2 證據與限制 |
|---|---|
| a. Headless、HTTP、SDK | `opencode serve --hostname 127.0.0.1 --port <port>` 可啟動 API。核心介面有 `GET /api/info`、`POST /api/session`、`POST /api/session/{sessionID}/prompt`、message/inbox 查詢與 interrupt。prompt 成功表示輸入已被接納，之後的執行要另查。JS HTTP client 為 `@opencode/client@2.3.2` 的 `OpenCode.make`，host SDK 可另看 `@opencode/sdk`。舊版 `/session/{id}/prompt_async` 屬另一份契約。 [CLI handler](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/commands/handlers/serve.ts) · [JS client](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/client/src/promise/client.ts) |
| b. Tool 事件 SSE | `GET /api/event` 含 `session.tool.called/progress/success/failed`、execution 與 permission events。可依 types 篩選，官方契約明示斷線不重播、慢 consumer 會 overflow。adapter 須再以可信的 session ID 過濾並重讀 session、message、inbox 和待決權限。公司環境串流與斷線行為 **UNVERIFIED**。 [事件 schema](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/session-event.ts) · [SSE handler](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/handlers/event.ts) |
| c. 訊息附件 | `prompt` 帶 `files: [{uri,name?}]`。程式支援 blob ref、base64 data URI 與本機 file URI，後者及 inline 路徑有 20 MiB 單檔上限檢查。PNG/JPEG/GIF/WebP 及 PDF 有 media mapping，模型不支援的 modality 可被替換為文字錯誤提示。OpenAI-compatible Chat 路徑會把 PDF 編為 inline `file.file_data`、圖片編為 `image_url`。XLSX 須走 OEP 解析或受控工具讀取。公司 alias 的 image/PDF 解讀與掃描 PDF/OCR **UNVERIFIED**。 [附件讀取](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/prompt.ts) · [附件投影](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/runner/to-llm-message.ts) · [Chat wire 格式](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/ai/src/protocols/openai-chat.ts) |
| d. Agents、sessions、設定 | 建立 session 可指定 `agent`、`model`、`location`、`permissions`、`metadata`，也可切換後續 turn 的 agent/model。primary/subagent 是原生能力，`parentID` 子 session 與 parent 同 location，且會回報 parent inbox。providers、Skills、MCP 定義仍經設定與 location 解析。隔離程度取決於 OS 帳號、工作目錄、工具權限和實例；樣本並行驗證 **UNVERIFIED**。 [Session API](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/session.ts) · [Agents](https://opencode.ai/docs/agents) |
| e. Native scheduling | **有**。headless 啟動程式會啟動 Automation service。以 location 的 `experimental.automations` 啟用，`/api/experimental/automation` 支援建立、查詢、暫停、恢復與刪除，可指定單次時間、間隔或 cron，投遞 prompt 或執行 Code Mode。原始碼含 SQLite lease 及漏跑處理。固定 spec 沒有獨立 Run Now endpoint。Windows 睡眠、重啟、過期行為的實測 **UNVERIFIED**，且 API 明示可能破壞相容。 [Automation API](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/automation.ts) · [headless 啟動](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/process.ts) · [排程實作](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/automation.ts) |
| f. Skills、MCP | `.opencode/skills/<id>/SKILL.md`、agent skill permissions、local stdio MCP 與 remote Streamable HTTP MCP 均有正式介面。Skill 載入取決於設定或 agent 行為，發布與檢索約束應放在服務契約。OEP 自訂 MCP 整合 **UNVERIFIED**。 [Skills](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/skills.mdx) · [MCP](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/mcp-servers.mdx) |
| g. LiteLLM provider | v2 用 `providers.<id>.package = @opencode/ai/providers/openai-compatible`、`settings.baseURL = <gateway>/v1`、`env` 指定 key 的環境變數名稱，以 `models.<alias>.modelID` 指向 Gateway alias，指定已驗證的 model capabilities。此 package 用 Chat Completions。要逐 alias 確認 streamed tool call arguments、call ID/result round trip、`tool_choice`、parallel calls、結構化輸出、錯誤、fallback 與 modality，避免 Gateway 把參數悄悄移除。公司 gateway 版本、catalog、TLS/CA、資料政策及全部實際相容性 **UNVERIFIED**。 [OpenCode providers](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/providers.mdx) · [Chat adapter](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/ai/src/protocols/openai-compatible-chat.ts) · [LiteLLM tool calling](https://docs.litellm.ai/docs/completion/function_call) |
| h. Bind、auth、CORS | 預設 `127.0.0.1`。v2 server process 需要 password，CLI 可採用 `OPENCODE_PASSWORD`（兼容 `OPENCODE_SERVER_PASSWORD`）或產生 password。Basic 使用固定 username `opencode`。另有 browser pairing/session cookie 與特定 ticket 路徑。預設 CORS 包含 localhost/127.0.0.1 各 port 及部分官方 origins，`--cors` 用於增加 origins。可做有密碼的 loopback upstream，建議由 OEP server 代理。實際 listener、401、跨 origin 行為 **UNVERIFIED**。 [CLI env](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/env.ts) · [auth](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/auth.ts) · [CORS](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/cors.ts) |
| i. License | v2.3.2 根目錄 `LICENSE` 為 MIT，官方 CLI/client/SDK npm metadata 亦標 MIT。打包時另盤點實際分發的 runtime、第三方套件與 NOTICE。 [固定 LICENSE](https://github.com/anomalyco/opencode/blob/v2.3.2/LICENSE) |

## B. 架構評估

- **Agent runtime 與產品控制面。** OpenCode 擁有模型 turn、tool loop、subagent、權限請求及 transcript。OEP adapter 擁有 browser/Telegram 身分、OpenCode API 轉接、附件/產物登錄、工作狀態與通知。BI、Wiki 服務各自擁有資料和審核交易。thin adapter 的判準是只轉接 OpenCode 執行契約。若 OEP 開始重建 agent plan、代理工具結果回送、通用重試迴圈或複製 transcript/approval policy，就出現第二個 harness。固定的 ingest 工作步驟、業務驗證及不明結果對帳應由領域服務負責。
- **Session mapping 與權限。** SQLite 保存 OEP conversation ID、installation/profile、trust class、channel、conversation/chat/topic、OpenCode session ID、location/workspace ID 及所選政策版本。Web 與 Telegram 預設隔離，以 owner 明確操作才允許共用；BI 以 job ID 建立短生命週期 ingest session。OEP 對單一會話序列化送件，保存 OpenCode message ID 供斷線對帳，確認重送契約前先查狀態。不同 session 可以並行，訂閱事件只轉交已授權 session。拒絕或逾時的原生 permission request 要在 UI 顯示結果。Telegram 背景 job 採最小權限，BI ingest agent 只提交候選。
- **檔案與 egress。** UI/Telegram 上傳回 OEP attachment ID，由 server 生成儲存名、驗 MIME/大小與配額，持久化 hash，驗證 workspace ownership 後自行生成 URI。拒絕客戶指定絕對路徑、UNC、ADS、junction、symlink、reparse point 及越根路徑，處理檢查與開啟之間的競態。產物僅從該 run 的 manifest 下載，HTML 走下載或隔離預覽。檔案、網頁、Markdown 均按非可信資料處理。正式使用前按資料分類授權傳送到公司 Gateway，來源抓取限制目的地、redirect、流量與逾時。若須隔離任意 shell 對其他資料的存取，要用 OS 隔離或關閉 shell；workspace 目錄本身無法提供該保證。
- **Windows lifecycle。** Phase 1 用單一 per-user supervisor 管理自有 `opencode serve`，經 authenticated `/api/info` 檢查版本及 readiness，處理 port 佔用、暫停、子程序退出與有界 restart/backoff。關閉先停止收件及排程派送，再結束管控中的程序樹。驗證 Windows Job Object（kill-on-close）、MCP/shell 子程序與 launcher crash，特別注意 v2.3.1 起 shell foreground timeout 可轉背景。瀏覽器關頁只關 UI，常駐與登入自啟另定。 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [shell timeout 變更](https://github.com/anomalyco/opencode/releases/tag/v2.3.1)
- **Knowledge Asking 的強制點。** Web 與 Telegram 的明確 Ask 入口先在服務端對指定 vault 的已發布 revision 執行檢索，建立綁定 request、vault revision、passage ID、來源版本與 hash 的 evidence set。無證據、索引過期或檢索錯誤時回可辨識的 abstain/error。以該 evidence set 呼叫限定權限的 OpenCode 生成結構化 `claims[]`，每個 claim 附 passage IDs。OEP 在輸出前核對 IDs 屬於當次檢索、片段存在且 hash/offset/引文可重現，連結由 server 生成。再以規則核對數字、單位及引文，以獨立評估和人工 gold set 驗證語意支持與衝突處理。可緩衝正式答案並串流狀態；未通過驗證時 abstain。一般聊天可用唯讀 MCP。若範圍含自由文字的自動識別，需另訂路由召回率與未命中時的 UI 行為。
- **成功判定。** 將 accepted、running、awaiting permission、background、failed、indeterminate 與 verified success 分開。SOP→Excel 以該 run 的 exit code/完成收據、manifest、結束時間、檔案 hash 和 workbook schema／公式結果驗收。即使 OpenCode 正常結束，缺失、過期或錯誤的 workbook 都要判失敗。BI 的「待審」「已發布」以資料交易為準，Telegram 通知以 outbox 狀態為準。

## C. 風險排序

| ID | 風險 | 可能性 | 影響 | 證據 | 緩解 | 負責階段 |
|---|---|---|---|---|---|---|
| R01 | 公司資料或未授權 AEP 程式進 public repo／Gateway | 高 | 極高 | AEP 授權未確認，追蹤 `.env`，benchmark 含 traces | 技術與資料來源清冊、授權記錄、合成資料、發布前 secret scan，runtime 資料出 repo，實際 egress 按分類核准 | 0，5 複核 |
| R02 | LiteLLM 可聊天，但 tool call 或 fallback 行為不符 | 高 | 極高 | A-g，Chat wire 與 upstream alias 能力各自變動 | 貼近真實 Gateway 的逐 alias 契約測試，鎖 model/route/capability，無相容路徑時 Phase 1 失敗 | 1 |
| R03 | 知識回答跳過 retrieval 或引用不足以支持 claim | 高 | 極高 | AEP benchmark 的路徑推定與 OpenCode 可選工具 | 強制 Ask 入口、固定已發布 evidence set、逐 claim 驗證、可測 abstain | 3B，介面於 1 定義 |
| R04 | Plugin 可打包但仍依賴 Host，adapter 變第二 harness | 高 | 高 | AEP 兩入口都引用 `host_runtime.features`，且接 Host/tool/web hooks | 授權後依 import graph 盤點，領域 API 先行，OpenCode 只接最小 MCP；以無 AEP Host 測試鎖依賴邊界 | 0，3A |
| R05 | Loopback API 被同機或瀏覽器其他 origin 調用 | 中高 | 極高 | A-h，CORS 為附加 allowlist，API 有工具／檔案能力 | 雙層 loopback、upstream password 只給 adapter、app 固定 Host/Origin、CSRF、opaque UI session，受控權限與 egress | 1–2 |
| R06 | 工作顯示成功但程式背景仍跑、Excel 缺失或內容錯 | 高 | 高 | Phase 1 歷史案例、prompt admission 與 shell background 語意 | Run ID、exit receipt、manifest/hash、workbook oracle；中斷後對帳及明確失敗 | 1，5 |
| R07 | Telegram 串台、重複執行或 advance cursor 後丟件 | 高 | 高 | AEP collector 的 cursor 分步更新與 in-memory dedup | bot 身分和 chat/topic 隔離，入庫與 offset 同交易，durable outbox、單 poller、crash/replay 測試 | 4 |
| R08 | 遷移丟失快照、evidence、schema 歷史或 rollback 損壞 | 中高 | 極高 | AEP vault、staging、SQLite 與 Wiki 檔案跨儲存邊界 | 一致備份、checksum manifest、dry run、shadow import、重建索引、原資料唯讀及可驗證還原 | 0，3A，5 |
| R09 | 接受附件後模型沒收到可讀內容 | 高 | 高 | A-c，mime mapping、模型 capabilities、Gateway 再轉接 | 核對 fixture 中的唯一值與頁碼。PDF text/OCR fallback，XLSX 安全解析，清楚回報受限或失敗 | 1–2 |
| R10 | Windows crash、鎖檔或程序殘留阻擋重啟 | 中高 | 高 | OpenCode 子程序、SQLite WAL、Job Object 與非 ASCII 路徑 | 驗證 supervisor、以絕對 exe/argv 啟動、處理 junction/長路徑、檔案鎖及清理 | 1–2，5 |
| R11 | 原生實驗排程與 ingest 自有排程雙重派送，或休眠後漏跑 | 中 | 高 | A-e，OpenCode 已自帶 scheduler；AEP 亦有 ingress workflow 排程 | MVP 由同一 OEP job ledger 觸發三種模式。Phase 1 比對漏跑、重啟、inbox 語意。僅保留可對帳的 bridge 作為未來選項 | 1，4 |
| R12 | SSE 斷線或不同 location 的事件讓 UI 誤報／外洩 | 中高 | 高 | A-b，server-wide volatile stream | adapter 授權過濾及去重，重連先讀權威狀態，慢客戶端有界佇列 | 2 |

## D. 功能缺口

- **AEP BI 保留範圍。** 把 Session A schema 設計與 Session B extraction method 的草稿／試跑／版本比較、欄位變更與人編內容衝突、evidence 分級、撤回、coverage matrix、品質檢查、Atlas 入口、BI Overview worker 加入清單。MVP 保留 staged review、品質狀態和來源；可調整 extraction method、共享 vault create/join／change replay、Atlas 和完整 Dashboard 分期決策。依據 `BI_INGEST.md` §§5、9、12、`BI_VAULT.md` §§6、11–12 與 BI Overview manifest。
- **AEP Wiki 與 Telegram 運維。** Wiki 的 personal sandbox、Raw/來源、lint、apply plan、conflict/merge、publish/version 取捨要列明。BI Inbox 的 domain mapping、去重、withdraw、摘要來源標示、雙時點提醒、發布後測試與 Dashboard 更新應明列保留或延後。AEP 原本另有一般工作排程及人工核准紀錄，OEP MVP 可延後通用工作排程。依據 `feature_plugins/llm_wiki/python/aep_wiki/knowledge/pipeline.py`、`feature_plugins/bi_knowledge/python/aep_bi/inbox/`、`src/host_runtime/schedule_worker.py`。
- **產品控制面。** 增列本機登入、Telegram sender/chat allowlist、permission approve/deny、資料分類與 egress、設定 schema 與優先序、secret rotation、log redaction/retention、診斷與追蹤 ID、更新/降級與資料相容矩陣。可觀測性至少涵蓋 job lag、cursor lag、Gateway 429、SSE 重連、staging/publish 失敗與程序退出。
- **資料與測試。** 定義原始檔保存、索引更新後才可用的發布狀態、來源撤回後可見性、斷線復原、備份範圍和 restore drill。測試分成離線 deterministic fixtures、pinned API contract、Windows 故障注入、私下授權的 Gateway/Telegram smoke 以及獨立的人審 benchmark。公開 artifacts 只含合成輸入、清理過的指標及 fixture manifest。

## E. v2 修改建議

1. **Phase 0** 先完成 ADR、授權清冊和 OpenCode 2.3.2 pin。定義 BI/Wiki 誰擁有 source、revision、publication、rollback，選定兩 bot 的語意以及支援的 Windows profile。
2. **Phase 1** 分成 1A lifecycle/API/權限與 1B Gateway／附件／SOP 產物。加上原生 Automations 的直接比較，驗證 flag、重啟與過期。盡早做一個 mock evidence set 到 OpenCode 輸出驗證的 spike。若公司 alias 不支援某個必要 modality，須有 owner 核准的 fallback 和可重現的 fixture 結果。
3. **Phase 2** 先做同 origin 的精簡新 UI。用 OpenCode Web 當對照，借鑑 AEP 的上傳、審核及狀態呈現；以 OEP 自己的 API、UI 程式與授權資產交付。瀏覽器只連 OEP。Phase 2 加一條假的 BI job→待審流程以驗證 UI/API 邊界。
4. **Phase 3** 拆成 3A 領域資料、遷移、BI staged review 與 publication，3B 檢索、citation 及 benchmark，3C Wiki sandbox/version/publish。3A 完成後，Phase 4 可與 3C 平行。資料修訂需保留 source hash、來源 URL/文件、頁碼或穩定 locator、schema/revision 及每筆 idempotency key。
5. **Phase 4** 以 SQLite inbox/job/outbox 為主。Telegram long polling 每 bot 一個持久 cursor，`(bot_id, update_id)` unique，保存入件與 cursor 後才用新 offset 取件。Run Now、immediate 與 scheduled 都走相同 job claim。以 UTC instant 加 IANA timezone 保存使用者時點，寫明 DST、睡眠及漏跑政策。外部送件逾時記為結果未定，對帳後才重送。Telegram 最多保留 24 小時，跨日停機應顯示可能缺件。 [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)
6. **技術選擇與 Phase 5。** 建議 Windows launcher/supervisor 與 adapter 採 TypeScript / Node.js 24 LTS，UI 採 React/Vite 靜態資產，HTTP 使用固定版 `@opencode/client` 或小型 HTTP wrapper。SQLite 用於 adapter 與領域資料，各自管理 schema，以單 writer、foreign keys、短交易與可驗證 backup 運作。以 SQLite FTS5 和中文斷詞／trigram 基線先測，涵蓋中文短 query、料號與混合語句，再由 recall/latency 決定 embeddings；起步優先同機可重建索引。PDF、OCR、Excel 用窄介面 converter worker；只有工具或獲准共用的 Python 邏輯需要時才加 Python。Phase 5 驗證升級、回退與恢復，固定依賴及分發雜湊。 [Node.js 發行資料](https://nodejs.org/dist/index.json) · [SQLite FTS5](https://www.sqlite.org/fts5.html) · [SQLite Online Backup](https://www.sqlite.org/backup.html)

建議的 OEP 檔案配置如下，屬 v2 提案。

| 路徑 | 所有權 |
|---|---|
| `apps/adapter/src/main.ts`、`http/{auth,chat,events,files}.ts` | 本機 UI API、接單、串流及下載 |
| `apps/adapter/src/opencode/{client,supervisor,sessions}.ts` | 固定版契約、Windows 管理與 session mapping |
| `apps/adapter/src/telegram/{poller,router,outbox}.ts`、`jobs/{queue,worker}.ts` | 渠道投遞、持久排程與對帳 |
| `apps/web/src/{chat,review,knowledge}/` | 對話、BI 審核與查詢介面 |
| `packages/knowledge/src/{bi,wiki,evidence,conversion}/`、`packages/knowledge/migrations/` | 領域服務、資料移轉、索引、引用和發布邏輯 |
| `packages/contracts/src/`、`config/opencode.example.jsonc` | API/資料型別、設定 schema 與無 secrets 範例 |
| `tests/{contract,integration,e2e,fixtures}/`、`scripts/windows/` | 合成 fixtures、故障測試與安裝/還原工具 |

執行資料建議放在 `%LOCALAPPDATA%\OEP`，區分設定、OpenCode profile、SQLite、workspace 及 artifacts，使用者 secret 放 Windows Credential Manager 或 DPAPI 保護的儲存。備份以一致 SQLite 快照加引用檔版本清單復原，涵蓋已發布與待審內容。回復演練另測 secret 重新綁定。

## F. 各階段驗收條件

下列指令是擬議 test targets，門檻是 v2 的初始建議值。

| Phase | 驗收與證據 |
|---|---|
| 0 | 完成 owner 簽核的 `docs/IMPLEMENTATION_PLAN_V2.md` 與 ADR。附 OpenCode tag/commit、CLI asset SHA-256、client 版本、OpenAPI hash、AEP path 對應及 Keep/Adapt/Replace/Remove 清冊。每個 **UNVERIFIED** 項有明確負責階段。 |
| 1 | `npm run test:contract` 以 pinned Windows binary 驗證 `/api/info`、無 auth 為 401、兩個獨立 session 的 agent/model/permissions、permission deny 及 streamed tool result。用公司核准 alias 驗證 text→tool→result 回合、image/PDF 唯一內容值與可觀察的 unsupported 狀態，另測 429、timeout、tool 失敗與 Automation flag on/off、重啟或漏跑。SOP→XLSX 連續 5 次產物通過 workbook oracle。注入非零退出、舊檔、錯誤內容、斷線及 shell 轉背景，錯誤成功數為 0。 |
| 2 | `npm run test:e2e:windows` 在乾淨實機或 VM 一鍵啟動，以有空格與中文的使用者路徑完成拖放 PNG/PDF 和 XLSX 路徑測試。實測 LAN 無 listener、錯誤 Host/Origin/CSRF 拒絕、兩 session 附件/事件隔離、越根與 reparse point 拒絕。中斷 SSE 後 state 與 OpenCode 該 session 對帳，相同 launcher 重啟不形成重複 instance，關停後無其 MCP/shell 孤兒程序。 |
| 3A–C | `npm run test:knowledge` 與遷移 `--dry-run` 匯出 row/ID/hash 對帳。合成 vault 的來源、卡片、關係、schema、版本和 evidence 100% 可映射或明列拒收。注入 commit crash 並重跑，無重複發布、人工修改可保留，Wiki sandbox 寫入後須經核准才可查到。 benchmark 含至少 40 題中英、含不可答、矛盾與注入；初始目標 answerable Recall@5 ≥85%、不可答 abstain ≥95%，100% 已呈現 citations 可重現，每一項關鍵不受支持 claim 都應阻擋並由人工 gold set 檢查。 |
| 4 | `npm run test:telegram` 模擬兩 bot 同 update_id、重播、重啟、崩潰、429、不可讀社群連結、排程時區及睡眠後 Run Now 競態。20 筆已接單 fixture 在復原後均可對帳，重複 job 和跨 bot 事件為 0，結果未定可見。兩個受控真 bot 分別通過 Main 對話、BI file/link→待審及通知 smoke；受阻時保留來源與原因。 |
| 5 | `npm run test:release` 於乾淨 Windows VM 走安裝→五項 Phase 5 E2E→升級→回退/restore。以備份前後 manifest 比對資料筆數、狀態、revision/source hash 和引用。提案初始 RPO 為 24 小時、RTO 為 30 分鐘，待 owner 核准。發行物附 SBOM、NOTICE、checksums 及 secrets 掃描結果。 |

## G. 待 owner 決策

1. 哪些 AEP 程式、schema 概念、資料與測試素材允許公開重用？誰能核准授權與 Gateway egress 分類？
2. 公司 LiteLLM 的測試環境、核准 aliases、可用 modalities、預設 fallback 與 retention 是什麼？
3. Knowledge Asking 的強制範圍是否含自由文字、Telegram Main Bot、OpenCode 直接使用者？需支援哪些知識庫同時查詢？
4. MVP 保留哪些 BI/Wiki 資料來源、歷史版本及 Dashboard 分析？共享 vault 匯入採已發布快照或保留完整變更歷史？
5. Windows OEP 關瀏覽器、關 launcher、登出與睡眠時，服務各自應如何運作？錯過排程後補跑、跳過或等 Run Now？可接受的 RPO/RTO 為何？
6. 兩個 bot 的群組／私聊政策、通知對象、預設 domain 與可接收的檔案種類為何？目前允許哪種社群擷取及摘要補件流程？
7. SOP→Excel 的明確 workbook oracle、可用的合成 SOP、容許的公式或輸出差異，由誰簽核？

## H. 預期交叉審查會有分歧的五項立場

1. **鎖 v2.3.2 並使用 v2 client。** 1.19.6 仍由舊 npm 名稱與 GitHub latest 指標推薦，容易快速 PoC。OEP 是新案，應選有正式 binary 的 2.3.2，避免先承接已知的大版本 API 轉換。代價是用 Phase 1 吸收新 API 的契約風險。
2. **BI ingest 的時點及工作帳本由 OEP 持有。** OpenCode 已具備一般 timer 與 prompt admission。BI 還需用同一交易語意處理來源、去重、待審、通知與恢復。由領域工作持有這些狀態，可以保留 OpenCode 的執行邊界。
3. **明確的 Knowledge Asking 應在 OpenCode 呼叫前完成 retrieval。** 若依賴 agent 自選 tool，未檢索時通常已產生答案。先檢索、再生成並驗證逐 claim 的 reference，才有可重現的拒絕條件。這會為知識問答增加一條明確入口。
4. **首版以新 OEP Web 和獨立領域接口交付。** AEP 已拆出不少 feature，卻仍需要 Host 物件與 AEP Web routes。借用驗收行為與授權後的純資料邏輯，能以較少依賴建立上傳、審核與發布的完整流程。
5. **FTS5、中文詞法與合成 gold set 先於 vector store。** AEP 已有可比較的詞法基線，工程查詢常含精確料號或規格。先量測同義、繁中短 query、混合語句與延遲，再用數據決定是否加入向量與 embedding egress。
