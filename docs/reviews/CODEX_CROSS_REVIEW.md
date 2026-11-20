# OEP Stage 2 交叉審查

日期 2026-11-21（Asia/Taipei）。Codex 完整讀取 `CLAUDE_STAGE1_REVIEW.md` 與 `CLAUDE_CROSS_REVIEW.md`。Claude Code 因 token 限制，只讀取 `CODEX_STAGE1_REVIEW.md` 的 §A、§G、§H。§B–§F 未讀，尤其未審查 Codex 的風險、選型細節與分期驗收。

以 AEP `c9961b2d0d66eef3892375213ce305883ebde960`、OpenCode `v2.3.2`（`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`）為準。裁定為「同意」「不同意」或 **UNVERIFIED（無法查證）**。原始碼與提交樹可證實實作存在，文件可證實曾描述的狀態，部署與第三方相容性須另實測。以下路徑均相對於所列固定版本。本輪未啟動應用、未重跑 AEP 測試、未呼叫公司 Gateway 或 Telegram。 [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960) · [OpenCode 快照](https://github.com/anomalyco/opencode/tree/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1)

## AEP 主張（Claude Stage 1 §A1、§B–E，Stage 2 §1、§3）

| 主張 | 裁定及證據 |
|---|---|
| AEP 公開，且無通用 LICENSE。 | **同意**。GitHub metadata 為 `visibility=public`、`license=null`，固定提交根目錄無通用 LICENSE／COPYING。部分 `packages/hermes-skill-pack/` vendor 內容有個別授權，授權範圍須逐項盤點。OEP 對 AEP 程式、資料及測試素材的重用權 **UNVERIFIED**。兩人只核對 `.env/` 路徑含 `README.md`、`example.yaml`，內容及是否含敏感值 **UNVERIFIED**。 [GitHub metadata](https://api.github.com/repos/dragon0816/agentic-engineering-platform) |
| BI/Wiki 是 in-process Python plugin，仍依賴 Host。 | **同意**。兩個 `feature_plugins/{bi_knowledge,llm_wiki}/plugin.json` 均為 `aep-plugin/1`、Core API `[1.2.0, 2.0.0)`，入口分別為 `aep_bi.feature`、`aep_wiki.feature`。兩個入口皆使用 `host_runtime.features`，有 AEP 專屬 hook。`scripts/build_bi_knowledge_plugin.py`、`scripts/build_llm_wiki_plugin.py` 產出 AEP 套件。獨立可執行性 **UNVERIFIED**。 |
| 耦合 27/13/11/6/5/4/3/3/2/2/2。 | **同意，須註明計數單位**。以 Git 列出 `feature_plugins/bi_knowledge/python/` 追蹤的 Python 檔，Python AST 計數絕對 import 語句，按 module 聚合且包含函式內 import。同一 `from` 內多個名稱算一次。依序重現 `knowledge.repo*` 27（`knowledge.repo` 13，`knowledge.repo.repository` 14）、`models.contracts` 13、`common.execution` 11、`agent.gateway` 6、`agent.backend_contracts` 5、`host_runtime.features` 4、`knowledge.questions` 3、`common.assets` 3、`models.approved` 2、`capabilities.runtime` 2、`host_runtime.platform_publish` 2。這個計數涵蓋直接靜態引用。 |
| 核心體量 10.6k／2.9k／1.8k／2.1k，故 Phase 3 需抽出約 15k 行與約 59k plugin 行數。 | **同意**所報四組體量，以追蹤 Python 檔的實體行（含註解與空行）算得 `src/knowledge/` 10,603、其子目錄 `src/knowledge/repo/` 2,936、`src/models/` 1,832、`src/agent/gateway.py` 2,137。`src/common/` 另有 7,200 行。BI plugin 49,774 行，Wiki 8,726 行，合計 58,500 行 Python。**不同意**把「約 15k」當必要抽取量或把整個 plugin 行數當重寫量，子目錄已含在父目錄，直接引用也無法推出最小移植閉包。建議以 OEP 自有資料契約重建必要行為。 |
| `web_page.py`／`bi_page.py` 是 Python 內嵌 HTML，UI 重用性差。 | **同意**。實體行為 `src/host_runtime/web_page.py` 9,110、`feature_plugins/bi_knowledge/python/aep_bi/host/bi_page.py` 9,502、`feature_plugins/llm_wiki/python/aep_wiki/host/wiki_page.py` 2,042。Web `page()` 組合 feature fragments，內嵌 CSS/JS，聊天與排程直接呼叫 AEP 的 `/api/conversations/turn`、`/api/schedules/create`，BI 則呼叫多個 `/api/bi/*`。移植成本偏高是根據路由、狀態與 Host 耦合的工程判斷，實際工時 **UNVERIFIED**。 |
| AEP phase 文件落後程式碼。 | **不同意**將兩份文件一概視為失準，**同意** Claude Stage 2 的限縮。`docs/phases/BI_INGEST.md` 檔首本來就指向 §12，§12 記載已交付及 scripted model／PDF 的當時限制。`BI_VAULT.md` 檔首與 §11 的 V1–V5 及部分 V6 紀錄矛盾。BI `cards/{staging,runs,store,vault,search_index,quality}.py` 可證實 staging、commit、發布及索引路徑，`vault.py` 3,070 行。以逐功能查驗裁決，跨檔案和 SQLite 故障原子性、共享 vault 併發與真模型皆 **UNVERIFIED**。 |
| Telegram collector 有分 bot polling/cursor、sender mapping，內容直入 feature hook。 | **同意**。`src/channels/telegram_collect.py` 380 行，`src/host_runtime/telegram_loop.py` 68 行，分別有 collector 與主 bot 執行緒。collector 的收件路徑未直接進模型，後續 feature 仍可處理或交給 ingest。**不同意**等同端到端 durable delivery。`telegram_collect.py` L234–259 先寫記憶體 `_seen`，逐件處理後更新 offset，L313–323 的 hook 錯誤可回傳 failed 而外層仍前推。重複／漏件是讀碼推論，端到端 **UNVERIFIED**。 |
| AEP BI Inbox 和 bi_overview 是實作缺口清單遺漏項。 | **同意**。BI `inbox/{api,bot,fetch,process,runtime,scheduler,store}.py` 有收件／來源、SQLite 去重與 claim、collect/remind、待審流程，`tests/test_bi_inbox.py` 有 fixture 驗證路徑。`feature_plugins/bi_overview/manifest.json` 和 `worker/aep_plugin_bi_overview/{reader,worker}.py` 提供唯讀 metadata，與 BI 分析 Dashboard 功能不同。實際部署／社群取得內容／crash 恢復 **UNVERIFIED**。 |
| Benchmark 1,100 題、以公司模型判定，檢查 Vault 內引用。 | **同意，有界線**。`benchmarks/knowledge_v1/{README.md,judge.py,evidence.py,reference_grade.py}` 支持題庫、判官與檢查路徑。直接路徑對應編號，一般路徑可憑來源檔名推定，文字檢查採分段比對門檻，無法證實逐 claim 語意。既有分數、題庫授權及公司環境重現 **UNVERIFIED**。保留概念並另造合成 gold set。 |
| Python ≥ 3.11、612 個測試檔、兩個合成 fixture。 | **同意** `pyproject.toml` 的 `requires-python`。**不同意**未註明口徑的 612，在固定提交下重算 `tests/` 中 `test_*.py` 為 601、全部 Python 檔為 622。`tests/fixtures/{robotics_kb_sample,bi_vault_example}/` 存在，但整批皆為合成且可公開重用 **UNVERIFIED**。 |
| R9 歷史假成功，AEP TurnEffects 是對策。 | **同意**歷史案例由 `docs/phases/FEATURE_PLUGIN_ASSESSMENT_20261113.md` L252 起記載，屬文件證據。**同意** `src/agent/turn_effects.py` 與 `src/host_runtime/web.py` 的 per-turn 記憶體記錄支持非持久去重。**不同意**把 TurnEffects 視為這宗假成功的修正，原文列為另案，去重也未驗證 workbook。AEP 歷史案例的重現／後續修復狀態 **UNVERIFIED**。 |

## OpenCode 主張（Claude Stage 1 §A2、§C，Stage 2 §1–2）

| 主張 | 裁定及證據 |
|---|---|
| 舊 npm 為 1.19.6，V2 已正式發布且應精確鎖定。 | **同意**。固定發行為 2026-11-18 01:35:12 UTC、非 prerelease，Windows x64、x64 baseline、arm64 有 ZIP。另核對 `packages/{cli,client,sdk}/package.json` 及 npm registry，V2 套件三者皆為 2.3.2。舊 `opencode-ai/latest` 回傳 1.19.6。新版採 binary、`@opencode/client`、OpenAPI 三重鎖定。星數為變動資料，原報告的時間點 **UNVERIFIED**，不影響選型。 [正式發行 metadata](https://api.github.com/repos/anomalyco/opencode/releases/tags/v2.3.2) · [舊 npm metadata](https://registry.npmjs.org/opencode-ai/latest) |
| V2 Server API experimental，OpenAPI 3.1 共 173 operations／518 schemas。 | **同意**。固定 `packages/protocol/openapi.json` 為 3.1.0，`info.version=0.0.1`，重算數字相符，列舉的 pairing/session/agent/location/PTY/worktree/skill/MCP/permission/event 路徑屬 API 契約。以 Git LF blob 計算 SHA-256 `bc152825b9b65224bfc56bddefcdd8f44b50e7f1d1541f741ae017aa791478ba`，排除 Windows checkout CRLF 影響。 [固定規格](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/openapi.json) |
| 只支援 `file:`／`data:` 附件，xlsx 不可見。 | **同意** xlsx 無原生模型投影，**不同意** URI 清單完整。`packages/schema/src/prompt-input.ts` 定義 `files` schema，`packages/core/src/session/prompt.ts` 另接受已存的 `media:` 參照。新 `file:`／`data:` 內容有 20 MiB 上限，HTTP(S) 拒絕，目錄非遞迴。 `session/runner/to-llm-message.ts` 投影文字、目錄、PNG/JPEG/GIF/WebP、PDF，`session/model-request.ts` 處理 modality 不支援。 `packages/core/src/image.ts` 預設尺寸 2,000×2,000 限制及 base64 5 MiB。公司模型看得到的內容 **UNVERIFIED**。 |
| Agent／Session 可設定 model、permissions、parent。 | **同意**。`packages/protocol/src/groups/session.ts` 與 `services/site/src/docs/content/agents.mdx` 支持相關宣告。隔離效果仍依賴 OEP mapping、location、工具權限和 OS，並行實測 **UNVERIFIED**。 |
| OpenAI-compatible provider 配置可接 LiteLLM。 | **同意**配置面。`services/site/src/docs/content/providers.mdx` 及 `packages/ai/src/protocols/openai-compatible-chat.ts` 支持 provider、baseURL、header/body、compatibility 與環境憑證。實際 aliases、tool 與媒體串流、fallback 行為 **UNVERIFIED**。 |
| OpenCode 無原生排程。Claude Stage 2 撤回。 | **不同意**原斷言，**同意**撤回。`packages/server/src/process.ts` L118–119 啟動 Automation service。`packages/core/src/automation.ts` 有 SQLite lease、單次／間隔／cron 與漏跑邏輯。`packages/protocol/src/groups/automation.ts` 與 OpenAPI 有 create/list/get/pause/resume/delete，無獨立 Run Now，且需 `experimental.automations`。OpenCode 的 prompt 或 Code Mode 排程可用於與 BI 無關的通用需求，建議 MVP 關閉。Windows 實測 **UNVERIFIED**。 [固定 Automation API](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/automation.ts) |
| SSE、serve 安全及版本差異。 | **同意** Stage 2 所補的 V2 行為。`packages/protocol/src/groups/event.ts` 說明 `GET /api/event` 跨 location、斷線期間事件會錯過、慢 consumer overflow。 `packages/server/src/{process,auth,cors}.ts` 支持預設 loopback、password／固定 Basic 帳號、pairing 及 localhost 跨 port 預設 allowlist，CLI 可加 origin。完整 V1/V2 CLI 行為對照及 V2 實測 **UNVERIFIED**。**不同意** Stage 1 P2 的「SSE 不丟事件」驗收，改測重連後權威狀態收斂與隔離。 |

## 架構與驗收主張（Claude Stage 1 §B–H、Stage 2 §2–4）

| 主張 | 裁定及理由 |
|---|---|
| 薄 adapter 可能長出第二套 harness，應限制擁有範圍。 | **同意**。OpenCode 固定 `groups/session.ts` 有 durable admission 與執行狀態，OEP 只做轉接、會話映射、附件、狀態對帳。產品端的 job ledger、Telegram 與知識審核各自有領域所有權。 |
| 原案以 MCP tool + agent permission 強制檢索。改採 hybrid。 | **不同意**原案能強制模型呼叫 tool，**同意** hybrid 及作用域限定。AEP `src/capabilities/knowledge_query/handlers.py` 有服務內檢索，BI `host/{bi_cards_tools,bi_bench}.py` 提供工具與受限 harness 路徑，兩者有不同邊界。OEP Ask 先檢索已發布 evidence，再經 OpenCode 生成及共用 verifier 才能發出答案。一般聊天由模型自選唯讀 MCP，tool 自身結果經同一 verifier，整段聊天仍屬 best-effort。固定命令、範圍與門檻由 owner 裁決。 |
| OEP 擁有 BI job ledger、冪等 key，OpenCode Automation 對通用 prompt 可選。 | **同意**。AEP `cards/store.py` 的 `committed_run`／`commit_run` 及 `inbox/{store,scheduler}.py` 有業務語意。OEP 要自行定義來源、審核、重啟對帳和通知，且讓 immediate、scheduled、Run Now 同走 OEP claim。Automation 即使開啟也不得成為 BI 第二個寫入者。 |
| Python 領域服務可避免跨語言重寫 59k 行。 | **不同意**行數推論及預設選型。Python 有成熟文件處理工具及較低的 AEP 概念轉譯成本，但套件受 Host 耦合與授權限制，仍要定義 OEP 契約。Codex 建議 TypeScript/Node 領域及 adapter，Python 僅做必要受控 converter 和 openpyxl oracle。實作速度差異 **UNVERIFIED**。 |
| 前端全新，曾考慮 OpenCode Web 作聊天。先 FTS5 與中文基線，再看向量。 | **同意** Stage 2 選新 OEP Web，配置同 origin 上傳、審核及代理，讓 OpenCode 密碼只在 server。**同意**先用 AEP `cards/search_index.py` 已實作的詞法概念，另測繁中與精確料號，向量需求與 egress **UNVERIFIED**。 |
| Phase 0 七個 spike、Phase 3 分兩段、品質 baseline 提前。 | **同意**方向。採 Claude 的 3a 唯讀、3b 寫入順序，保留 Codex 的 migration/revision 及 Wiki 核准測試。v2 owner gate 先完成，之後才開跑需執行的 Phase 0 spike。先做獨立合成 baseline，只有授權與可比條件俱備才另外量 AEP 現況。 |
| P1 連續 5/5、openpyxl 逐格、故障注入必敗。 | **同意**，並明定同一合成 SOP/PDF、各次全新 workspace、退出收據、artifact hash、新鮮度及已知輸出值。另做非零退出、無檔／空檔、舊檔、錯值、背景未完成及斷線的失敗注入，假成功數為 0。openpyxl 不執行公式，若驗公式結果，必須指定受控重算與 cache/公式檢查。5/5 是 gate，目前 **UNVERIFIED**。 |
| P2 單鍵上傳及安全、P3a 引用及匯入、P3b 先審後發、P4 隔離和三種觸發、P5 還原及升級。 | **同意**其目標。P2 SSE 以重讀狀態驗收。P3a 分開引用可重現與語意評分。P3b 跨 DB／內容檔案用 crash injection 實證。P4 分開入件確認與業務完成，容許重播且要求狀態冪等。P5 比對 manifest 並測 RPO/RTO。上述皆為未來 gate，實測 **UNVERIFIED**。 |
| Secrets、結構化 log、Windows CI、提早規劃備份與效果帳本。 | **同意**。交易紀錄在 Phase 1 開始，Phase 3a 就驗還原。官方 AEP 原始碼的 TurnEffects 只涵蓋一個 turn，OEP 需要持久紀錄，外部結果未定時先對帳。業務帳本歸 OEP 責任邊界內的服務。 |

## 尚待裁決

| 議題 | 方案 A（Option A） | 方案 B（Option B） | 建議 | 決策人 |
|---|---|---|---|---|
| Knowledge Asking 範圍 | Web 明確 Ask 和 Main Bot `/ask` 強制，聊天 MCP 共用 verifier 而由模型自選。優點是可測、可預期。代價是使用者須選入口。 | 一般自由文字也先經 OEP 判別並強制。直接 OpenCode 若需同保證須改走 OEP policy 路徑。覆蓋較廣。要承擔誤判、延遲與額外的入口控制。 | A，初版一次查單一 BI 或 Wiki vault。 | owner |
| 領域服務語言 | TypeScript/Node，Python 只做必要 converter/oracle。執行環境較集中。部分 Python 文件工具須跨程序。 | Python 領域服務 + HTTP/IPC，adapter 用 TypeScript。文件工具較豐富。須維護兩套常駐服務契約與部署。 | A，Phase 0 記錄必要 converter 和分發成本。 | owner |
| AEP 重用與基線 | 只採行為概念，自建合成資料及 OEP 基線，AEP 保持唯讀。容易交付。沒有 AEP 實測對照值。 | 具名權利人審查後選擇性重用，於私有環境做同集比較。保留對照。需授權與資料條件。 | A，授權與 egress 另由權利人核准。 | owner／資料權利人 |
| Windows 登出與漏跑 | 每使用者常駐，登出後暫停，恢復後在窗口內補一次。易於操作與對帳。睡眠／停機期間沒有即時派送。 | 背景 service／Task Scheduler 常駐，逐筆補跑。涵蓋登出。增加身分、密鑰存取和積壓風險。 | A，使用 UTC 和時區，逐 job 記漏跑與 Run Now。 | owner |

其餘產品範圍、Gateway 授權、模型及驗收門檻統一列入 v2「待 owner 決定」。此審查採讀碼與文件證據，Claude 對 Codex §B–§F 的交叉驗證仍未完成。
