# OEP 實作計畫 v2

## 待 owner 決定

日期 2026-11-21（Asia/Taipei）。狀態為待核准，核准後取代 [v1](IMPLEMENTATION_PLAN.md)。Stage 3 只交付設計文件。本節收集本輪的 owner 裁決。可回覆「接受所有建議預設，確認 v2」。如要調整，列出決策編號即可。實際憑證、內部設定和非公開測試輸入另走核准渠道。

| ID | owner 需決定 | 建議預設 |
|---|---|---|
| D01 | AEP 重用授權、私下 benchmark／資料輸入權限、OEP 發布授權 | AEP 唯讀，只參考行為，自寫與自製合成資料。未有權利人書面許可前，不匯入真資料、不重跑公司 benchmark、不重用 AEP 原始碼或 fixtures。OEP 自有程式建議採 MIT，發行前完成逐項授權盤點。 |
| D02 | S2 測試 key 發行人、aliases、modalities、fallback、retention 與 egress 核准人 | 由公司 Gateway 管理員發短期、可撤銷、模型 allowlist 與預算受限的測試 virtual key，僅由環境變數注入。先核准一個 tool-calling alias，以及確有需要且支援 image/PDF 的同一或第二個 alias。由公司資料權責人核准 egress 與 retention，預設僅送合成內容，停用內容留存及未核准 fallback。管理員以私下渠道提供具名設定，核准前維持 S2 真實驗證為 `UNVERIFIED`。 |
| D03 | Knowledge Asking 強制入口、多 vault 查詢與品質門檻 | Web Ask、Main Bot `/ask`，每次選一個已發布 BI 或 Wiki vault。一般聊天及直接使用 OpenCode 無強制承諾，唯讀 MCP 盡力而為且工具回覆經共用 verifier。48 題，Recall@5 ≥85%、不可答 abstain ≥95%、回答可用率 ≥90%、呈現引用 100% 可重現、關鍵 unsupported claim 為 0。細項與延遲見 Phase 3a。 |
| D04 | 領域服務語言 | 採 TypeScript／Node.js 24 LTS，Python 僅限有界 converter 或獨立 openpyxl oracle。S3/S6 提出改選的實測依據才重開 ADR-007。 |
| D05 | BI／Wiki 遷移範圍及 Dashboard | MVP 匯入已發布快照與其來源、evidence、關係、schema/revision 標識。維護 OEP 之後的新修訂歷史。延後 AEP 全歷史、共享資料夾多人同步及進階 Dashboard。先做唯讀概覽（數量、schema、版本、時間、可用狀態）。無授權快照時用合成資料驗匯入契約。 |
| D06 | Windows 支援矩陣、登入啟動、漏跑及恢復門檻 | 首版驗 Windows 11 x64，單使用者 supervisor，登入後可選自啟。關頁及鎖屏維持常駐，停 launcher／登出後暫停，睡眠後按 24 小時補跑窗口恢復。週期只補最新合格 occurrence。RPO ≤24 小時、RTO ≤30 分鐘。 |
| D07 | Telegram 發送者、通知對象、檔案及連結擷取政策 | 兩個獨立 bot，先開 allowlist 私聊，群組關閉。通知限 owner／同一受到授權的接收端。BI 入站允許核准來源連結、UTF-8 文字、圖片、PDF、XLSX，套用 Phase 2 限額，收件不送模型。公開連結只在允許且無登入門檻時擷取，受阻保留連結與原因並接受人工補件。禁止使用私人 browser session 或繞過登入牆。 |
| D08 | SOP/PDF→XLSX 驗收 oracle | owner 或指定 domain reviewer 核定合成 SOP、PDF、工作表名稱、範圍及每格型別／值。首版輸出採精確可比的固定值與精度規則。公式或容差日後需補核准 oracle。P1 連續 5/5，故障案例假成功為 0。 |
| D09 | v2 版本、正式 Web、Automation 與啟動開發的總核准 | 接受已收斂的 OpenCode v2.3.2 三重 pin、新 OEP Web 與 OEP 自有 BI job ledger。通用 OpenCode Automation 預設關閉。以本 v2 完成 Stage 4 核准，才進 Stage 5 的 Phase 0 驗證。 |

## 範圍、證據與開工邊界

OEP 是單使用者、local-first 工程平台。OpenCode 管模型 turn、tool loop、agent、權限、session/transcript。OEP 管本機控制入口、OpenCode API 轉接、附件產物、BI/Wiki 工作、兩個 Telegram bot 與知識問答政策。BI ingest 固定採立即、定時及 Run Now，發布需人工批准。多人平台、資源閒置監測、自動發布、第二套 harness 為本計畫排除項。 [ADR](ARCHITECTURE_DECISIONS.md)

主要證據為 AEP `c9961b2d0d66eef3892375213ce305883ebde960` 與 OpenCode `v2.3.2` 的固定原始碼、metadata 和實作契約。Claude Code 只讀 Codex 審查的 §A、§G、§H，未讀 §B–§F。Codex 完整讀 Claude 的兩份報告。公司 Gateway、Telegram、Windows 執行、遷移與所有未來測試門檻在本輪仍 **UNVERIFIED**，資料授權也待確認。 [審查對照](REVIEW_COMPARISON.md) · [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960) · [OpenCode 發行](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)

目前只完成 Stage 1–3 文件。Stage 4 由 owner 核准 v2。Stage 5 是整個開發流程，內含下列 Phase 0 至 Phase 5，兩個編號各有用途。所有路徑及命令均為後續工作計畫。每一 Phase 的執行 gate 一律在 owner 核准 v2 後進行，前一 Phase 完成才開始下一 Phase。

## 擬議 repo 佈局

| 路徑 | 擁有內容 |
|---|---|
| `apps/launcher/`、`scripts/windows/` | 單實例、Job Object、啟動／停止、安裝與還原 |
| `apps/adapter/src/{http,opencode,runs,telegram}/` | 同源 API、OpenCode 轉接、產物帳本、bot 收件／路由／通知 |
| `apps/web/src/` | chat、knowledge、BI review 和 metadata |
| `packages/knowledge/src/{bi,wiki,search,evidence,migration,jobs}/` | schema/revision、發布、檢索、引用、轉移及 BI job |
| `packages/contracts/`、`workers/office/`、`config/` | 型別和版本、受控文件 converter、去敏範例與 pin |
| `tests/{contract,integration,e2e,fixtures,oracles}/`、`docs/validation/` | 合成資料、契約、失敗驗證、經去敏的驗收報告 |

執行資料放在 `%LOCALAPPDATA%\OEP` 下的 profile、store、workspace、artifact 及 log。repo 保留合成 fixtures 和可公開的摘要。每次執行以私有輸出目錄保留必要原始證據，只在報告寫測試 ID、版本、狀態、數字及公開 fixture 的 hash。

## Phase 0　驗證設計假設與鎖定基線

**目標與依賴**　Stage 4 核准後，以 repo 外的一次性 probe 和合成資料做七個 spike。S1 先於 S2–S6，S7 並行。D02 的公司連線、D01 的真資料或 AEP 對照測試須有對應授權。若關鍵能力受阻，留下明確 **UNVERIFIED** 和 blocker，gate 保持未通過。

| Spike | 檔案與工作 | 測試及產物門檻 |
|---|---|---|
| S1　版本／契約 | `config/opencode.pin.json` 記 tag、commit、Windows 支援架構 ZIP/digest、解包 binary digest、client 版本與 package integrity、OpenAPI LF blob hash。`docs/validation/p0-s1-version.md` 記命令及 release metadata。`opencode-windows-x64.zip` 的官方 SHA-256 是 `8ad59f1992a0594d8bd72b5ed3be1f5bfffcd9d1756853eec7e5d3141c25be1f`，ZIP 及 binary 待下載驗證。 | 用 `Get-FileHash -Algorithm SHA256` 核對 ZIP、記錄解包 binary digest 並驗可重現，`opencode --version` 與 authenticated `GET /api/info` 均為 2.3.2。用 Git blob bytes 雜湊比對 ADR-001，避免 CRLF。以暫存 client smoke 查建 session、送 prompt、查狀態、interrupt、permission API。五類全部可重現。另比對 Automation flag on/off、一次性漏跑及重啟，結果至少明列是否可用，MVP 保持關閉。 [發行資產 metadata](https://api.github.com/repos/anomalyco/opencode/releases/tags/v2.3.2) |
| S2　LiteLLM tool-calling | `docs/validation/p0-s2-gateway.md` 只提交去敏摘要。使用「owner 提供的測試 Gateway（位址透過外部渠道提供，保存在本機 env／設定，不進版本控制）」。據 owner 經 Claude 轉述，該機器的 `/health/liveliness` 回 200、無憑證 `/v1/models` 回 HTTP 500，原因未知。由 Gateway 管理員用獨立環境變數 `OEP_LITELLM_TEST_API_KEY` 提供短期、可撤銷、有預算及 model allowlist 的 virtual key。此輪未收到 key。`LITELLM_MASTER_KEY` 禁用於開發或任何 spike。 | 在核准連線與資料政策後，以 OpenCode `@opencode/ai/providers/openai-compatible` 及合成 fixtures 執行。至少 20 次連續成功 tool 回合，涵蓋每個已宣告的 alias 能力與 streamed tool-call args JSON 重組、call ID／tool result 往返、`tool_choice` 和 parallel calls。結構化輸出驗 schema，測 401／403、429、5xx、timeout、失敗工具及未核准 fallback，依預期拒絕或回報，禁止靜默降級。對支援 image/PDF 的 alias 各讀出一個已知唯一值。重查無憑證與受限 key 的 `/v1/models` 行為及 liveness，記去敏 status／correlation，請管理員對帳先前的 500。若 500 持續且原因尚未確認，在報告續列 **UNVERIFIED**。只有受限 key 已證明模型隔離、認證語意符合服務契約且所需能力全通過時才可結案。 |
| S3　附件與 XLSX | `docs/validation/p0-s3-attachments.md` 記合成 PNG、PDF、兩個 sheet 的 XLSX、超限與不支援案例。以一次性 converter 驗證欄位、來源 locator 及 bounded parse。 | PNG、PDF 各讀出唯一內容，XLSX 的 Markdown/CSV 轉換逐格符合 fixture（兩 sheets 及列定位），原檔與轉換單獨有 hash。至少驗 `file:`、`data:`、超過 20 MiB、HTTP URI、掃描 PDF 回退及 Windows 路徑，所有結果符合預期。模型端媒體結果須與 S2 一致。 |
| S4　SSE 重連 | `docs/validation/p0-s4-sse.md` 列 `/api/event` 事件、scope 和可對帳來源。 | 以兩個 session 故障注入至少 3 次斷線／overflow（含完成事件在斷線期間）。重連 5 秒內以狀態讀取收斂，跨 session 曝露與重複送件均為 0。瞬時事件可缺，記入證據。 |
| S5　Server 安全 | `docs/validation/p0-s5-security.md` 以本機隔離的 upstream 和一次性 OEP proxy 探測 bind、密碼及 Origin 行為。 | `Get-NetTCPConnection` 顯示 listener 只在 loopback，受保護 API 無憑證回 401、正確憑證可用。測錯誤 Host、Origin、CSRF 與瀏覽器可見 upstream 密碼，全部拒絕或無外洩。對照 upstream 預設 CORS，確認 OEP 自行驗證。 |
| S6　Windows lifecycle | `docs/validation/p0-s6-windows.md` 記 Windows／Node／binary 架構、Job Object、per-user、登入及路徑。 | Windows 11 x64 私有 VM，包含中文／空格路徑。啟動、port 衝突、單實例、正常停、launcher 強制停止、睡眠／喚醒、登出／再登入各一輪，兩種停法後 10 秒內受管 orphan 為 0。記錄各種恢復結果及 Node／Python worker 額外部署成本。 |
| S7　授權盤點 | `docs/validation/p0-s7-licensing.md` 及 `docs/validation/p0-provenance.md` 盤點 AEP、OpenCode、依賴、fixture、自有素材與分發權。 | 100% 候選項有版本／來源／授權／處置，未授權可分發項為 0，secret scan 命中為 0。AEP 無通用 LICENSE，文件只引用公開路徑及設計概念。 |

**提前建立知識 baseline**　`tests/fixtures/knowledge/gold.v1.json`（Phase 0 擬議資料檔）及 `docs/validation/p0-knowledge-baseline.md` 定義 48 題合成集與可重現的簡單文字匹配基線。最少 24 題有答案、20 題無證據、4 題矛盾或注入，涵蓋繁中、英文、混合文字、精確料號和短查詢。鎖 fixture hash、標註和評分方法，寫 Recall@5 與延遲。Phase 1 用 mock evidence set 補拒答／引用 baseline。只有 D01 核准、同一資料集及條件可比時才在私有環境另做 AEP 對照。

**回滾、風險與 gate**　probe 在隔離目錄、profile 與合成輸入運行，停止後清理暫存、撤銷測試 key 並保留去敏證據。禁止修改 AEP。R01、R02、R03、R05、R06、R10。七份報告與基線齊備，S1–S7 各有可重現命令、結果與通過門檻，關鍵失敗不得進 Phase 1。保留所有 **UNVERIFIED** 的驗證責任與阻擋範圍。

## Phase 1　Runtime、Gateway 與可驗證 Excel 產物

**目標與依賴**　落實 OpenCode 固定契約、程序管理、兩個互相隔離的 agent/session 及 SOP/PDF→程式→XLSX。需 Phase 0 通過、D08 oracle 核准、公司環境可驗證。

| 預計路徑 | 任務與測試 |
|---|---|
| `package.json`、`package-lock.json`、`tsconfig.json`、`config/opencode.example.jsonc` | 鎖 Node 與 client，配置合成 provider fixture、兩個 agent、權限及 Automation 關閉。定義 `npm run` 的階段測試入口，範例只含 placeholder。 |
| `apps/launcher/src/{main,supervisor,job-object}.ts`、`apps/adapter/src/opencode/{client,sessions,reconcile}.ts` | 以絕對 exe/argv 啟動、認證 readiness、有限 restart/backoff、權限拒絕與 session admission 對帳。 |
| `packages/contracts/src/run.ts`、`apps/adapter/src/runs/{ledger,receipt,artifacts}.ts`、`apps/adapter/migrations/001_runs.sql` | 依 run 分開 `accepted/running/awaiting_permission/background/failed/indeterminate/verified`，對帳 receipt、結束時間、artifact hash 和路徑。 |
| `tests/contract/{opencode,poc-gateway,permissions}.test.ts`、`tests/e2e/sop-to-xlsx.test.ts`、`tests/oracles/verify_xlsx.py`、`tests/oracles/requirements.txt`、`tests/fixtures/sop/expected.json` | 建受控合成 SOP/PDF、openpyxl oracle、失敗注入及執行報告，未來公式需另設獨立重算，首版使用固定值。 |
| `packages/contracts/src/evidence.ts`、`tests/contract/evidence-verifier.test.ts` | 固定 Ask input/output，合成至少 3 類狀態（有效、缺證據、引用不合）。先建立驗證基準，不引入可寫知識庫。 |

**驗收與產物**　`npm run test:contract` 至少覆蓋 `/api/info` 無憑證 401、兩獨立 session、agent/model/permission deny、送件後狀態查詢及事件斷線。與 S2 同一核准 scope 重跑產品路徑的 tool call、媒體及錯誤契約，全部通過。`npm run test:e2e:excel` 連續 **5/5**，每次全新 workspace。成功必須有 exit code 0、當次完成收據、manifest/SHA-256、檔案新鮮度與 openpyxl 的完整工作表、逐格型別和值相符。注入非零退出、錯誤程式、無檔、空檔、舊檔、錯值，六類均須判為 failed。背景未完成與斷線兩類在完成驗證前須維持可追蹤的 background／indeterminate 狀態，過了驗收期限沒有有效收據或產物時該次驗收失敗。八類注入的假成功數為 0。`docs/validation/p1-runtime.md` 附 run/session ID、退出狀態與合成 artifact hash。

**遷移、回滾及風險**　從新 DB 啟用 migration，停止 launcher 後用空白 profile 或升級前備份切回 pinned 版本。保留不確定 run 的收據與 ledger，先對帳再人工重試。R01–R03、R05、R06、R09、R10。

## Phase 2　同源 Web、launcher 與附件

**目標與依賴**　Phase 1 通過後，交付單鍵啟動和瀏覽器操作，另用 stub 驗證未來 BI 工作的待審呈現。

| 預計路徑 | 任務與測試 |
|---|---|
| `scripts/windows/Start-OEP.ps1`、`apps/launcher/src/browser.ts`、`apps/adapter/src/main.ts` | 可無終端啟動 browser 與受控服務，終止程序樹，執行資料分離。 |
| `apps/adapter/src/http/{auth,chat,events,files}.ts`、`apps/adapter/src/runs/attachments.ts`、`apps/adapter/migrations/002_attachments.sql` | 同源認證、路徑安全、配額、檔案身份與 open-time 查驗、檔案存取授權、SSE 重連合併。 |
| `apps/web/index.html`、`apps/web/vite.config.ts`、`apps/web/src/{App,Chat,Upload,Artifacts,JobStatus}.tsx`、`apps/web/src/api.ts` | agent/session 選擇、拖放 PNG/PDF/XLSX、串流進度及驗證產物下載。顯示 fake job 的待審狀態。 |
| `workers/office/xlsx_to_text.py`、`workers/office/requirements.txt`、`tests/e2e/{windows-launch,upload,sse-recovery}.test.ts`、`tests/contract/local-api.test.ts` | 受控 converter、parser/路徑/安全及瀏覽器驗收。 |

**驗收與產物**　`npm run test:e2e:windows` 在乾淨 x64 VM 由單鍵開啟，含中文／空格路徑。PNG/PDF 各以唯一值驗模型可讀，XLSX 兩 sheets 轉換逐格、含 locator 匹配，下載 hash 與 run 一致。初始配額每檔 20 MiB、每個 session workspace 200 MiB。XLSX 轉換上限為 10 sheets、每 sheet 500 列／50 欄、解壓內容 100 MiB，worker 逾時 10 秒。超限測試全數明確拒收或標示截斷，公式不執行。測 `..`、任意 `file:`、UNC、ADS、symlink、junction/reparse point、競態及異 session 檔案，拒絕率 100%。Host/Origin/CSRF 錯誤全拒，LAN listener 及前端 credential 曝露為 0。兩會話三次 SSE 故障後 5 秒內對帳收斂，跨會話事件與重送為 0。連起兩次只有一個 supervisor，停止後 10 秒內受管孤兒程序為 0。`docs/validation/p2-windows-web.md` 記測試輸出與去敏畫面。

**遷移、回滾及風險**　上傳先落暫存再登錄，清理無引用的暫存檔。資料表前向遷移前做一致備份，回復 Phase 1 binary/DB 時保留不可變產物。R05、R06、R09、R10、R12。

## Phase 3a　唯讀 BI/Wiki 遷移、檢索與 Knowledge Asking

**目標與依賴**　以 Phase 2 的安全附件與入口，先驗資料可還原、遷移可對帳、公開答案只取已發布 revision。輸入預設合成，採權利人核准的私有快照才做真實遷移對照。

| 預計路徑 | 任務與測試 |
|---|---|
| `packages/knowledge/migrations/001_publications.sql`、`packages/knowledge/src/migration/{import-aep,compare,backup}.ts`、`scripts/knowledge/migrate.ts` | 建 blob/revision 保存、唯讀輸入與 dry-run、shadow、來源連結/ID 報告、快照備份還原。 |
| `packages/knowledge/src/search/{index,tokenize,retrieve}.ts`、`packages/knowledge/src/evidence/{ask,verify}.ts` | FTS5、語詞／料號查詢，綁定 request/revision/evidence，透過 OpenCode 生成後驗證、abstain。 |
| `apps/adapter/src/http/knowledge.ts`、`apps/adapter/src/opencode/knowledge-mcp.ts`、`apps/web/src/{Knowledge,VaultOverview}.tsx` | Web 明確 Ask、單 vault 選擇、唯讀 MCP 共用服務、不可答顯示、可重現引用、metadata 概覽。 |
| `tests/integration/{knowledge-migration,knowledge-restore,ask-policy}.test.ts`、`tests/e2e/knowledge-gold.test.ts` | 合成來源／卡片／wiki／證據對帳，強制前置檢索、索引過期、偽造引文與隔離測試。 |

**驗收與產物**　`npm run knowledge:migrate -- --dry-run` 列 100% 輸入筆數、ID、關係、schema、rev、blob/evidence hash 的映射或具名拒收，合成有效 fixture 拒收與不符均為 0，來源 hash 前後一致。Shadow 匯入、索引重建與 `npm run test:knowledge` 通過。固定 Phase 0 題集至少 48 題，Recall@5 ≥85% 且同 fixture 下不低於簡單匹配 baseline，不可答 abstain ≥95%，可答題正確且可用答案 ≥90%，呈現引用可重現 100%，人工標註辨識的關鍵 unsupported claim 為 0。以 Windows 11 x64 同一 VM、1,000 passages、暖機後至少 100 次樣本，量本地檢索 p95 ≤1 秒。直接 Ask 的無檢索、跨 revision、索引過期、草稿及錯誤引用測試全部封鎖。於至少一次備份→還原後比對所有 fixture counts/hash/revision。`docs/validation/p3a-knowledge.md` 留評分、分母、錯題分類、遷移與還原報告。若無可用 AEP 對照資料，AEP 品質差異仍 **UNVERIFIED**。

**遷移、回滾及風險**　來源唯讀，先 dry run，再 shadow，確認對帳後才切 publication pointer。禁用寫入，重灌可由 backup/manifest 回復。R01、R04、R07、R08。

## Phase 3b　BI/Wiki ingest、staging、審核及發布

**目標與依賴**　Phase 3a 通過後，新增可恢復寫入。人工批准的 BI cards 和 Wiki revision 才出現在查詢。

| 預計路徑 | 任務與測試 |
|---|---|
| `packages/knowledge/migrations/002_ingest.sql`、`packages/knowledge/src/bi/{schema,ingest,staging,review,publish}.ts` | 原檔與 Markdown 修訂、版本化 schema、逐欄 evidence、候選驗證、人工 approve/reject、idempotent publish/undo。 |
| `packages/knowledge/src/wiki/{sandbox,review,publish}.ts`、`packages/knowledge/src/jobs/{ledger,worker}.ts`、`packages/knowledge/migrations/003_jobs.sql` | Wiki sandbox、審核、版本、publish。建 BI job/effect ledger、lease、Run Now／立即共用 claim。 |
| `apps/adapter/src/http/{ingest,review}.ts`、`apps/web/src/{IngestReview,WikiReview}.tsx`、`tests/integration/{bi-publish,wiki-publish,ingest-crash}.test.ts` | 接合新 UI，驗證編輯、schema mismatch、權限、差異、通知事件和恢復。 |

**驗收與產物**　`npm run test:ingest` 完成 BI 與 Wiki 各一條 source→staging→review→publish→Ask。未審、拒絕、舊 schema、缺 evidence 全拒。每種發布在寫 blob、commit 中斷及 commit 後通知前三個點故障注入，重播後最多一次業務發布、0 半成品可見、0 重複通知 intent。相同 run/key 並行重送 10 次，最多一已發布 revision。人工編輯可保留，rollback 後指標及 Ask 讀取回前一 revision。Phase 3a 的查詢／基線全部回歸，`docs/validation/p3b-publish.md` 附處理／交易對帳與版本差異。

**遷移、回滾及風險**　由新 migration 新增 staging、job，備份後啟用寫入。回退先停 worker 與收件，保留待審的 staging snapshot，使用相容版程式及對應 DB/manifest，復原後對帳。R04、R07、R08、R11。

## Phase 4　Telegram 與三種 BI 工作觸發

**目標與依賴**　Phase 3b 通過後，以兩 bot 交付 Main 對話／`/ask`、BI 收件／審核通知與工作時點。真 bot 測試使用 D07 核准環境。

| 預計路徑 | 任務與測試 |
|---|---|
| `apps/adapter/src/telegram/{poller,inbox,router,outbox}.ts`、`apps/adapter/migrations/003_telegram.sql` | 每 bot 一個 poller，原子 inbox/cursor、allowlist、chat/topic 隔離、Main `/ask`、BI 檔案／連結、通知 outbox。 |
| `packages/knowledge/src/jobs/{scheduler,reconcile}.ts`、`packages/knowledge/src/bi/link-intake.ts`、`packages/knowledge/migrations/004_schedule.sql` | 將立即、定時、Run Now 接入共用 ledger，記 UTC/IANA 時區、occurrence、missed/expired 與補跑。連結抓取限制核准目標、重新導向、流量與逾時，受阻時留待人工補件。 |
| `apps/adapter/src/http/jobs.ts`、`apps/web/src/Jobs.tsx`、`tests/integration/{telegram-replay,schedules,source-fallback}.test.ts`、`tests/e2e/telegram-smoke.test.ts` | 使用者狀態、utc/時區、sleep/logout 恢復、真 bot smoke。 |

**驗收與產物**　`npm run test:telegram` 模擬兩 bot 相同 update ID、未允許 sender、無法讀取連結、逾時、429、重送及 crash。至少 20 筆 durable 接單全部可對帳，重複 job、跨 bot/session、重複發布為 0。刻意在 persist 前、persist 後送新 offset 前、外部送出結果未知處終止，應重投或對帳並保留可見 indeterminate。三種觸發皆有測試，注入 clock jump、夏令時及睡眠後同 occurrence 的 Run Now／schedule 競態，最多一個 claim。兩個真 bot 各通過 smoke（Main 對話及 `/ask`、BI 連結與檔案→待審→通知）。受阻連結保留 URL、原因和補件，編造內容數為 0。`docs/validation/p4-telegram.md` 存去敏紀錄。

**遷移、回滾及風險**　啟用前備份 inbox/job/outbox/cursor 及 profile。回退先停 poller，保留尚未確認的 offset 和未定 intent，恢復後以 ledger 對帳再派送。停機超過 24 小時標示可能遺失尚未收到的 Telegram updates。R01、R07、R11。

## Phase 5　Windows 發行、備份回復及完整回歸

**目標與依賴**　完成前面各 phase 與 owner 核准的 Windows 支援範圍，交付可重現發行物。

| 預計路徑 | 任務與測試 |
|---|---|
| `scripts/windows/{Install-OEP,Backup-OEP,Restore-OEP,Upgrade-OEP,Rollback-OEP}.ps1`、`config/release.manifest.json` | 安裝與一鍵回復、簽章／checksums、profile 與備份管理、自啟設定。 |
| `tests/e2e/{release,backup-restore,upgrade-rollback}.test.ts`、`.github/workflows/windows-ci.yml` | 乾淨 VM 回歸、資料一致性、合成 CI 與授權／secret scan。 |
| `docs/OPERATIONS.md`、`docs/validation/p5-release.md` | 操作、排程、停機、未定結果、升級、回退、備份重綁。交付 SBOM、NOTICE、checksums、去敏結果。 |

**驗收與產物**　`npm run test:release` 在乾淨 Windows VM 驗證 SOP→Excel、PNG/PDF 上傳、Telegram→BI→人工審核、Ask→可重現引用、schema 變更及備份→回復，6 類流程全數通過。使用兩套版本各演練一次升級及回退，把 OpenCode binary／profile 成套還原。備份前後比較 100% fixture counts、狀態、revision/hash、關係與引用。量測 RPO ≤24 小時、RTO ≤30 分鐘。發布候選含授權清單、SBOM、NOTICE、checksums，secret scan 無命中。

**遷移、回滾及風險**　升級前停止派送、做一致 DB/blob/profile 快照，啟用新程式後再次對帳。回退復原對應版本與資料，重新綁定 credentials，保持所有未定 intent 可追蹤。R01、R03、R05、R08、R10、R11、R12。

## Windows 操作模型

| 情境 | 行為及驗收方式 |
|---|---|
| 啟動／已啟動 | per-user 單實例 supervisor 擁有 OEP/OpenCode/MCP 子程序，版本與 authenticated readiness 過關才開 Web。重開導向既有同源 Web。port 衝突只重新選擇或回報，保留外部程序。 |
| 關 browser／鎖屏 | supervisor 繼續，工作可在再開頁後查到。 |
| 停 launcher／登出 | 停收件及新派送，保存狀態再停止自有程序樹。強停靠 Job Object。登出後停止，登入可選自啟，未選則手動啟動。 |
| 睡眠／重啟／不正常停止 | 休眠期間無派送。恢復先查 durable inbox/job/效果帳本及 OpenCode 狀態。尚無副作用的 lease 過期可再領取，外部寫入結果未定則等對帳。 |
| 漏跑 | 新時點保存 UTC 與原 IANA timezone。春季不存在的本地時間拒收並請重選，秋季重複時點要求選 offset。一次性逾期 ≤24 小時補一次。週期只補最新合格 slot，舊 slot 顯示 missed，超窗口為 expired，可人工 Run Now。 |
| 備份 | 版本化一致 SQLite 快照、不可變 blobs 和 manifest，RPO/RTO 量測見 D06。密鑰重新綁定。 |

## 風險登錄

| 風險 | 可能性／影響 | 緩解及驗證責任 |
|---|---|---|
| R01　公開 repo／外送／授權 | 高／高 | synthetic-only、D01/D02、S7、各 phase 掃描與發布清冊 |
| R02　LiteLLM tool/媒體相容 | 高／高 | S2 與 Phase 1 真實契約，鎖 aliases，明示不支援 |
| R03　實驗 API 升級或 Automation 不相容 | 高／高 | S1 pin、契約 diff、關閉 Automation、升級回復 |
| R04　AEP Host 耦合使領域移植失控 | 高／高 | 獨立實作與 Phase 3a/3b 拆分，驗無 AEP Host 依賴 |
| R05　本機 API／附件權限 | 中／高 | S3/S5、Phase 2 正式同源／路徑拒絕及會話隔離 |
| R06　產物假成功 | 中／高 | Phase 1 產物 oracle、背景及故障注入 |
| R07　跳過檢索、引用無根據 | 高／高 | Phase 0/1 基線、Phase 3a evidence verifier、gold set |
| R08　遷移掉資料、發布半套 | 中／高 | Shadow、原子 publication pointer、迭代備份/故障注入 |
| R09　附件接單後內容不可讀 | 高／高 | S2/S3、合成唯一值、XLSX converter 與 PDF 回退 |
| R10　Windows 程序殘留、睡眠或路徑失敗 | 高／中 | S6、Phase 2 Job Object、Phase 4 漏跑測試 |
| R11　Telegram 串台、重投或工作重複 | 中／高 | Phase 4 durable inbox/offset、job claim、outbox、真 bot |
| R12　SSE 漏事件或洩露其他 session | 中／高 | S4、Phase 2 授權投影與重連對帳 |

## Stage 5 開發與逐 Phase gate

1. Stage 4 核准後，Codex 依 phase 在 OEP 開 feature branch 與 worktree，例如 `phase/0-validation`、`phase/1-runtime`、`phase/3a-knowledge-read`。AEP 一律唯讀。
2. 開發者跑該 phase 的單元、契約、故障注入與 E2E，留下命令、環境、門檻、產物和狀態。公司環境的證據只發布去敏摘要。
3. 由 Claude Code 獨立 review diff 和驗收。Claude 不可用時，必須由獨立 Codex review delegate 讀 diff 並驗證，在報告記錄 reviewer 身分並明寫「reviewer 為獨立 Codex delegate，並非 Claude Code」。開發者自審不得代替。
4. 開發者修正失敗項，再跑相關測試，原 reviewer 或同等獨立 reviewer 核對修正與重新驗證結果。
5. phase gate 需全部必備門檻通過、阻擋問題結清、驗收文件齊備及 review 結論可追溯，才結束分支並開始下一 phase。仍需 owner 裁決的例外回到相應 ADR／決策。計畫未宣稱任一開發 phase 已開始或已通過。

## 2026-11-21　Phase 0 實測修訂

此節追加實測結果及執行解讀。Stage 4 已核准原 v2 與 D01–D09，Stage 5 的 Phase 0 有實作證據，gate 未通過。原驗收門檻續用。 [Decision 紀錄](DECISIONS.md) · [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)

- S1、S4、S5、S6　Windows x64 ZIP／binary pin 為已驗靜態證據。臨時 Linux 容器取得同 tag 的 CLI／API、Automation、SSE 和 proxy 實測。Windows 原生執行仍須隔離 VM，原生 OpenCode listener、Job Object、睡眠／喚醒及登出／再登入須補證。S4 三次實際斷線已錄，另留 upstream overflow 待驗。Automation 繼續預設關閉。
- S2　依 owner 此輪指定使用 `OEP_LITELLM_BASE_URL`／`OEP_LITELLM_API_KEY` 的程序或 User scope。實測 liveness 和有效憑證清單 200，無憑證清單 500、錯誤憑證 400。管理員須證實 key scope、認證語意、異常根因、retention／egress 及 fallback。禁止使用已知 master key，禁止探測管理端點。
- S2、S3　候選 alias 上線前須以同一路徑做最小健康 probe，listing 無法確認可用性。選定 aliases 20 次串流工具／往返達標，PNG 和 PDF 各辨識通過。永久 forced `tool_choice` 有重複工具風險，規劃須在同一受控 turn 只限定首步，待另行驗證。401／403／429／5xx、timeout、長輸入和 fallback 的合成證據依 [S2](validation/p0-s2-gateway.md) 的範圍採用，真端行為仍待證。
- Phase 0 probes 及合成 fixtures 納入版本控制，下載物、臨時 profile 與轉換輸出留於 `.phase0/` 或隔離容器的短暫檔案系統。D08 核定屬資料審核，Phase 1 才建 SOP→XLSX oracle 與 E2E。

<a id="phase-1-egress-acceptance"></a>

## 2026-11-21　Phase 1 模型出口設計與驗收補充

Phase 0 測試容器的 `--network bridge` 限於一次性 Gateway probe。Phase 1 設計採 relay-only。OpenCode 與其子程序置於隔離的 Windows VM 網路。私有虛擬交換器只連 host relay，停用 NAT、IP forwarding 與對一般網路的預設路由。VM 網路政策只放行 loopback 及 relay 的固定 IP／port。Host relay 持有受限 key，透過獨立程序的預設拒絕 Windows 過濾規則，僅連設定核准的 Gateway 目的位址及 port。Relay 固定 API 路徑及模型 allowlist、拒絕 redirect，Gateway 位址或解析結果變更時須先更新核准規則。保留去敏的允許／拒絕證據。

Phase 1 驗收須於目標 Windows 11 x64 VM 以合成資料測通 OpenCode→relay→核准 Gateway。由同一隔離環境中的 OpenCode 及測試子程序，分別嘗試直接連 Gateway、其他 LAN／公網目的地，及透過 relay 請求非核准路徑或 redirect。所有負例須在建立對外連線或轉送請求前拒絕，並用防火牆／relay 計數驗證沒有旁路或替代 provider。拒絕網路規則、移除 relay 或撤回 allowlist 後，工作須明確失敗。執行時不得以 Phase 0 bridge 取代這些限制。 [S5 測試出口邊界](validation/p0-s5-security.md)
