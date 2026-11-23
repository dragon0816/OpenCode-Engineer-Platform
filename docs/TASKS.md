# OEP 階段與任務清單

日期 2026-11-21（Asia/Taipei）。Phase 0 已合併至本機 `main`（`1c45494`），由 owner 豁免結案，原 v2 與修訂後的 gate 均未通過。Owner 已授權 Phase 1。 [決策紀錄](DECISIONS.md) · [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)

## Stage 1–4　審查與開工核准

- [x] Stage 1　Claude Code 與 Codex 完成獨立審查。
- [x] Stage 2　Codex 完整審查 Claude 兩份報告並回查固定版原始碼。Claude 只交叉讀了 Codex §A、§G、§H，§B–§F 未讀。
- [x] Stage 3　完成審查對照、ADR、v2、AEP gap、任務、決策與交接。
- [x] Stage 4　owner 回覆「接受所有建議預設並開工」，確認 v2 與 D01–D09。 [核准紀錄](DECISIONS.md#2026-11-21stage-4-核准與-phase-0-開工)

## Stage 5　開發

### Phase 0　驗證假設

- [ ] S1　版本、client、OpenAPI hash 已驗，容器 API 五類與 Automation 通過。O-3a 另驗原生 Windows `/api/info` 與基本 session；完整原生契約不在 O-3a 內。 [S1](validation/p0-s1-version.md)
- [ ] S2　舊真 Gateway 穩定性 PASS 降為 **UNVERIFIED**。新斷言於合成 relay 證實兩 alias 各 10 回合及完整 forced turn。真 Gateway 重測待可驗 TLS 的 HTTPS 入口，key scope、認證異常與真故障矩陣仍待結。 [S2](validation/p0-s2-gateway.md)
- [x] S3　合成附件有界轉換、逐格 oracle、Windows junction／路徑與入口限制通過。模型側證據取同一組 S2 容器 probe。 [S3](validation/p0-s3-attachments.md)
- [ ] S4　隔離容器三次斷線收斂達標。原生 Windows 時序與 upstream overflow 待驗。 [S4](validation/p0-s4-sse.md)
- [ ] S5　隔離容器的 auth、loopback、proxy、Origin／Host／CSRF 已驗。O-3a 原生 Windows listener 核對通過，完整原生 proxy 集成另行驗收。 [S5](validation/p0-s5-security.md)
- [x] O-3a　Windows 11 x64 本機的 native OpenCode 基本測試與合成 Job probe 通過。 [S6](validation/p0-s6-windows.md)
- O-3b　**WAIVED by owner – not tested**。真實 OS 睡眠／喚醒與登出／再登入無測試；此項無 GPT dots、VM 或 Hyper-V 工作。D06 行為與 RPO/RTO 仍為 **UNVERIFIED** 設計假設。
- [x] S7　已列授權、provenance、MIT、secret scan 和 hook。合成測試證明裸私網 IPv4 可脫離環境值偵測。公開 CI 執行待允許推送的時機。 [S7](validation/p0-s7-licensing.md)
- [x] 固定 48 題知識合成集、Recall@5、延遲與七份 probe 報告。 [基線](validation/p0-knowledge-baseline.md)
- [x] 修正第 1 輪　I-1 完整 forced turn、I-2 私網 IPv4 掃描、I-3 Phase 1 出口驗收補充。 [修正證據](reviews/PHASE0_GATE_REPORT.md)
- [x] O-4　Owner 核定最小 D08 smoke oracle，PDF 對照與雜湊測試通過；核定範圍僅限管線接線。 [D08 核定](validation/d08-oracle.md)
- [x] 第 4 輪　I-A 至 I-E 與兩項 Minor 已更新，O-3a 重測通過。 [實測與故障注入](reviews/PHASE0_GATE_REPORT.md#fix-round-4)
- [x] 結案　Owner 豁免 Phase 0 gate，已本機合併。O-1／O-2 繼續追蹤，O-3b 已免測，O-4 維持核定。 [責任人清單](HANDOFF.md#phase-0-owner-checklist)

### Phase 1　Runtime 與 SOP→XLSX

#### Phase 1 前置補強

以下 Phase 0 證據維持 **UNVERIFIED**。勾選只表示 Phase 1 的產品測試已涵蓋該情境。

- [ ] S4　跨客戶端／路徑的重複送件計數。
- [x] S4　已收到連線和開始事件後由客戶端切斷，再重連對帳。上游 overflow 仍待驗。
- [x] S2　合成供應方核對工具成功／失敗回傳的內容、call ID 與形狀。真 Gateway 已驗成功寫檔與 PDF，完整錯誤契約仍待驗。
- [ ] S4／S2　teardown 跳過清理、`SyntaxError` 轉 502 後 exit 0、遺失原始原因。
- [ ] S6　Job supervisor 遇 worker `null` 退出碼的失敗處理。
- [ ] Minor　Git 文件區分兩把設定鎖。
- [ ] Minor　`windows-job.cs` 檢查 `CloseHandle` 回傳值。
- [ ] Minor　secret scan CLI 無模式時靜默 exit 0。

#### Phase 1 實作及驗收

- [x] 管理監督程序、OpenCode client/session mapping 與權限。原生 Windows 測試通過。
- [x] 兩個並行 session 隔離、SSE 重連對帳、relay 合成錯誤契約及 evidence stub 通過。
- [x] 真 Gateway 的兩個核准 alias 均通過啟動健康檢查，實際完成 OpenCode 工具呼叫及 PDF→XLSX。
- [ ] 真 Gateway 的獨立圖片附件與完整錯誤契約維持 **UNVERIFIED**。
- [ ] 在 Windows VM 驗證 OpenCode 及子程序只能透過受限 relay 連核准 Gateway，完成旁路負例。 [出口驗收](IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance)
- [x] 完成 run／receipt／manifest。合成 SOP→XLSX 連續 5/5、13 格逐格相等，9 類故障注入假成功 0。
- [x] 真模型 SOP→XLSX 連續 5/5。GPT 補跑與 Haiku 各有同輪連續 5 筆。合計 23 筆普通跑次，19 筆成功全部各驗 13 格，4 筆逾時相關失敗均留存。 [真模型重測](reviews/PHASE1_GATE_REPORT.md#gateway-恢復後的真模型重測)
- [x] 真模式故障注入以 Haiku 完成，1 個控制組通過，7 個負例全部判失敗，假成功 0。 [故障證據](reviews/PHASE1_GATE_REPORT.md#真模式故障驗收--phase1-uw6xyz)
- [x] 提交 Phase 1 gate 報告及原始紀錄位置。 [Gate 報告](reviews/PHASE1_GATE_REPORT.md)
- [x] Owner 確認 Phase 1 已合併並推送（`e616e6a`），授權 Phase 2。原報告保留各驗收項的證據與限制。

### Phase 2　Web、launcher 與附件

Owner 已核准開始。從 `e616e6a` 開 `phase-2/web-gui`，完成或具體受阻即留下驗收報告並交接。 [決策紀錄](DECISIONS.md)

- [x] 交付單鍵 Windows 啟動、同源 Web chat、選檔與拖放、Excel 投影及驗證產物下載。
- [x] 本機 Windows 驗收兩次啟動共用一個 supervisor、正常／強制停、三次 SSE 斷線、同源與檔案界線。WSH 測試於瀏覽器交接處使用測試接收器。
- [x] 真 Gateway 共 15 筆，14 筆通過，完整保留 2 筆請求逾時重試及 1 筆模型 JSON 失敗。最終 GPT 的 Chromium 驗收 3/3 通過。
- [x] 提交 Phase 2 操作及驗收文件。 [操作](validation/p2-windows-web.md) · [Gate 報告](reviews/PHASE2_GATE_REPORT.md)
- [ ] 乾淨 Windows 11 x64 VM 與實際預設瀏覽器交接、Windows 檔案 symlink、其他未驗項目及 Claude Code 輕量複核。 [待辦](reviews/PHASE2_GATE_REPORT.md#偏差風險及-owner-待辦)

### Phase 2b　GUI 功能對照與版面

- [x] 唯讀 AEP 功能盤點、owner 意見與版面規格。 [矩陣](AEP_GUI_PARITY.md) · [版面](GUI_LAYOUT.md)
- [x] GUI 外殼第二版已提交。完成可收合功能欄、對話輸入框、按需附加區、繁中操作文字、Chromium 回歸與合成樣張。 [驗收報告](reviews/PHASE2B_SHELL_V2_REPORT.md)
- [ ] GUI 外殼第二版完成全部驗收。這次 Web HTTP、安裝、升級遇到執行中服務的鎖定或保護，Excel 真模型驗收暫停。 [驗收結果](reviews/PHASE2B_SHELL_V2_REPORT.md#驗收結果)
- [x] 設定整頁與十個分類已實作，含窄版分類選單、分類記憶、行內回饋、控制項對照與 40 張合成樣張。 [設定頁驗收](reviews/PHASE2B_SETTINGS_PAGE_REPORT.md)
- [x] 設定頁的完整回歸通過。Chromium 連續三次通過，真模型 Excel 五次連續通過，發行及維護驗收通過，敏感資料掃描 0 hits。 [驗收結果](reviews/PHASE2B_SETTINGS_PAGE_REPORT.md#驗收結果)
- [x] GUI 重做藍圖分步 3 已交付知識庫、排程與工作、獨立審核、共用附加資料分頁、控制項對照與 36 張合成樣張。 [驗收報告](reviews/PHASE2B_KNOWLEDGE_JOBS_REPORT.md)
- [x] 分步 3 的完整回歸已通過，包含 Chromium 三輪、真模型 Excel 五次連續驗證、發行、維護與 0 hits 掃描。擁有者逐頁驗收待完成。 [驗收結果](reviews/PHASE2B_KNOWLEDGE_JOBS_REPORT.md#驗收結果)
- [x] GUI 重做分步 4 已交付繁中用語、淺色與深色、窄版、鍵盤操作、定稿控制項對照及合成樣張。 [驗收報告](reviews/PHASE2B_GUI_POLISH_REPORT.md)
- [ ] 完成分步 4 的擁有者逐頁驗收，並補跑受執行中 OEP 保護限制的 Web HTTP、真模型 Excel、安裝、升級及備份還原。 [驗收輸出](reviews/PHASE2B_GUI_POLISH_REPORT.md#驗收輸出)
- [ ] 通用工作台與設定分批交付。知識、審核、Telegram、排程功能隨 3a、3b、4 交付。
- [ ] Phase 5 打包前完成 2b gate，逐項留驗收或省略理由。

### Phase 3a　唯讀 BI/Wiki

- [x] 合成快照乾跑／shadow 遷移、provenance、備份還原與 Web 唯讀概覽。
- [x] FTS5 繁中與料號查詢、明確 Ask 檢索優先、共用 verifier、原生聊天 MCP。
- [x] 固定 48 題，兩個真 Gateway alias 各三輪，保留所有嘗試與未驗項目。最終各為 24/24 可答、24/24 不可答拒答、24/24 引用可重現。 [驗收報告](reviews/PHASE3A_GATE_REPORT.md)
- [x] 在 `phase-3a/repo-reader` 交付 BI 儲存庫發布解析、唯讀匯入、世代回復、結構檢查及 Web 入口。合成鏡像與兩個真 Gateway alias 的 48 題驗收已完成。 [資料夾操作](validation/p3a-repo-reader.md) · [驗收報告](reviews/PHASE3A_REPO_READER_REPORT.md)
- [ ] Owner 在自己的同步資料夾執行去敏檢查及選擇性的本機匯入，比對實際結構與遷移差異。目標 Windows 11 x64 VM 仍待補測。 [Owner 驗證步驟](reviews/PHASE3A_REPO_READER_REPORT.md#owner-本機驗證)

### Phase 3b　Ingest／review／publish

- [x] 合成 BI staging／schema/evidence、Wiki sandbox 與人工核准核心流程。
- [x] 永續 job/effect ledger、冪等發布、失敗恢復及 rollback。
- [ ] Phase 3b GUI parity 剩餘功能及 Technical Lead 獨立審查。 [Gate 報告](reviews/PHASE3B_GATE_REPORT.md)

### Phase 3a 後續

- [x] 3a-R1　段落去重並保留多卡出處，降低 frontmatter 單行權重，加入數字、型號及中文詞法加權與雙語合成回歸。 [驗證](reviews/PHASE3A_RETRIEVAL_REPORT.md)
- [x] 3a-R2　Gateway 回傳不可重試的 4xx 時，Ask 回傳 `gateway-rejected`，Web 顯示繁中說明。 [驗證](reviews/PHASE3A_RETRIEVAL_REPORT.md)
- [ ] 3b-R6　模型提議擷取只驗證引述存在於原文，不驗證提議的欄位值是否由該引述支持。審核畫面應並排顯示欄位值與引述，並評估要求值出現在引述內或標示差異。上傳來源的保留與清理政策待定。 [Technical Lead 審查 2026-11-21]

### Phase 4　Telegram 和三種 BI 觸發

- [ ] Main／BI bot 隔離、durable inbox/cursor、outbox、`/ask`。
- [ ] 即時、定時、Run Now 共用 claim，處理時區、漏跑與來源阻塞；實作啟動／恢復對帳，以模擬時鐘跳躍與終止程序／重啟做單元及整合驗收。真實 OS 睡眠／登出行為仍為 **UNVERIFIED**。
- [ ] 合成 crash/replay 與兩真 bot smoke，提交 Phase 4 驗收和獨立 review。
- [x] 假 API 重投、48 筆收件、程序終止、24 筆 BI effect、通知重試與模擬排程恢復已驗。Chromium 與原生 OpenCode 驗證工作頁、Main Topic 隔離及 Ask。真 bot、完整 GUI parity 及獨立審查仍為 **UNVERIFIED**。 [驗收報告](reviews/PHASE4_GATE_REPORT.md)
- [x] 複核修正已通過合成驗證。收件重試與處理期限、獨立指令、25 秒長輪詢、目標 BI 提案及不確定通知的人工重送。
- [ ] 為 `bi_sources` 的原始檔及補件內容定義保留期限或容量上限，並驗證清理及對帳。

### Phase 5　發行及回歸

- [x] 建置可重現 Windows ZIP、逐檔雜湊清單及外部 ZIP checksum，在本機以解壓後的內容載入啟動器。 [發行驗證](validation/p5-release.md)
- [ ] 交付安裝、解除安裝、備份、回復、升級與回退腳本及隔離的安裝版驗收。
- [ ] Windows VM 安裝、全程 E2E、升級、rollback 與備份恢復。
- [ ] SBOM、NOTICE、checksums、secret scan 和操作文件，含真實 OS 睡眠／登出的排程已知限制。 [文件計畫](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)
- [ ] 提交 Phase 5 驗收和獨立 review。

### Phase 3b review follow-up

- [x] 3b-R1　Incremental BI changes, bounded uploads, legacy API, and crash/replay/concurrency coverage.
- [x] 3b-R2　First-publication deactivation, retained history, reactivation, and rollback crash recovery.
- [x] 3b-R3　Traditional Chinese review forms and Chromium BI publish, cited Ask, and rollback.
- [x] 3b-R4　Read-only Ask and MCP connection with a write-denial check.
- [x] 3b-R5　Explicit model proposal, fabricated-quote rejection, and both approved aliases exercised with synthetic text. [Improvement report](reviews/PHASE3B_IMPROVEMENT_REPORT.md)


## Phase 2b Slice 1

- [ ] 完成工作台、日常設定、對話操作和專案隔離。部分實作與未驗項目見[驗收報告](reviews/PHASE2B_SLICE1_REPORT.md)。


## Phase 2b Slice 1b 進度

- [x] 專案側欄、會話清單與跨專案路由隔離。
- [ ] 對話區、右側面板、設定及對話操作。詳見 [驗收記錄](reviews/PHASE2B_SLICE1B_REPORT.md)。

## Phase 2b Slice 2A 進度

- [x] 緊湊側欄、鍵盤列選單、安全 Markdown、工具卡、單回合停止，以及取消工作簿的帳本驗收。
- [ ] 驗收逐 token 顯示、SSE 斷線遺漏活動補齊、執行中工具取消與完整對比稽核。 [Slice 2A 驗收](reviews/PHASE2B_SLICE2A_REPORT.md)

## Phase 2b Slice 2B 進度

- [x] 右側分頁、窄版面板、附件操作與預覽、工作台帳與 BI 摘要、同名 XLSX 產物差異。
- [x] 生成中顯示等候秒數，保留跨框架機密遮蔽。
- [ ] 另行驗收逐 token 串流、PDF 首頁及文字產物差異整合。 [Slice 2B 驗收](reviews/PHASE2B_SLICE2B_REPORT.md)

## Phase 2b Slice 2C 進度

- [x] 設定頁、助理、外觀、模型、回合限制、執行環境、整合說明。 [驗收報告](reviews/PHASE2B_SLICE2C_REPORT.md)
- [ ] 輸入、專案與資料夾、關於，以及其餘設定矩陣項目。Telegram 語音留在原階段。

## Phase 2b Slice 2D

- 對話操作與剩餘設定的實作、測試及開放項目見 [Slice 2D 驗收](reviews/PHASE2B_SLICE2D_REPORT.md)。

## Phase 2b Slice 3A

- 知識頁概覽、問答、品質、建置與整合設定的驗收及開放項目見 [Slice 3A](reviews/PHASE2B_SLICE3A_REPORT.md)。

## Phase 5B

- [x] 以隔離目錄驗證發行 ZIP 安裝、解除安裝、SQLite 備份及回復。
- [ ] 乾淨 Windows VM 或 Sandbox 驗開始功能表、登入和備份排程、安裝版工作流程及一般使用者權限。RPO、RTO 維持 UNVERIFIED。 [驗收狀態](reviews/PHASE5_GATE_REPORT.md)

## Phase 5C

- [x] 交付升級、前向 SQLite 遷移、成套回退和中斷復原。
- [ ] 在一般使用者的乾淨 Windows VM 驗證升級、回退、開始功能表與排程。實際環境的 RPO、RTO 維持 **UNVERIFIED**。 [驗收狀態](reviews/PHASE5_GATE_REPORT.md)

## Phase 5D follow-up

- [ ] Technical Lead verifies the first Windows CI run and all release hashes.
- [ ] Owner completes license and provenance review and the clean Windows VM run, including credential rebinding and RPO/RTO evidence.
- [ ] Complete the [release checklist](RELEASE_CHECKLIST.md) before designating a release candidate.

## Phase 2b Slice 4A

- [x] 設定頁列出內建知識 MCP，連至現有 BI 查詢開關。
- [ ] 完成通用 MCP、專案授權、資料範圍、憑證與備份驗收。
- [ ] 完成能力清單、技能安裝與新會話有效工具驗收。 [驗收紀錄](reviews/PHASE2B_SLICE4A_REPORT.md)

## Phase 2b Slice 4B

- [x] 自訂 stdio MCP 定義驗證、儲存與備份回復。

## Phase 2b Slice 4C

- [x] 自訂 MCP 設定 API、啟動套用、專案與可驗證工具名稱的權限、隔離連線測試及繁體中文設定頁。 [驗收紀錄](reviews/PHASE2B_SLICE4C_REPORT.md)
- [ ] 補齊遠端成功情境與各遠端失敗原因的 Chromium 驗收。 [驗收紀錄](reviews/PHASE2B_SLICE4C_REPORT.md)

## Phase 3 工作台介面語言切換

- [x] 完成繁中與英文語言檔、即時切換與本機保存、工作台後端訊息代碼，以及雙語介面與英文樣張。 [驗收記錄](reviews/PHASE3_I18N_REPORT.md)
- [ ] 擁有者驗收 Web HTTP、Excel、安裝、升級和備份還原。

## Phase 3A 閘道模型清單

- [x] 探索並保存閘道模型清單，提供繁中及英文的模型勾選、測試、預設與閒置重啟。會話可保留紀錄並在原模型移除後改用預設模型，知識庫品質檢查沿用已套用的模型選擇。 [驗收紀錄](reviews/PHASE3A_GATEWAY_MODELS_REPORT.md)
- [x] 模型設定顯示未儲存提示，離開前確認捨棄變更。「儲存並套用」在閒置時自動生效，對話只有預設模型時可直接前往模型設定。 [驗收紀錄](reviews/PHASE3A_MODEL_SETTINGS_UX_REPORT.md)
- [ ] 由審核者補跑執行中 OEP 阻擋的 Web HTTP、真模型 Excel、安裝、升級及備份還原驗收。

## 2026-11-22 升級與測試強化

- [x] 加入跨 schema 升級 fixture、失敗版本目錄回收與相對路徑診斷。
- [x] 強制隔離測試資料目錄，修正 MCP 測試結果與 Job 成員確認的交接。 [驗收紀錄](reviews/HARDENING_UPGRADE_TESTS_REPORT.md)
- [ ] 由審核者在 OEP 關閉後驗收 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。

## Phase 3B 切片 1 助理台帳與跨版遷移

- [x] 建立內建助理、工作資料夾、會話歸屬、初始授權、資料分級及交辦額度設定。舊 Web、Telegram 與 BI 流程沿用原入口。
- [x] 以升級前多庫 fixture 驗證逐庫交易、重跑、資料列比對與檔案雜湊。 [多助理設計](design/PHASE3B_MULTI_AGENT_DESIGN.md) · [切片 1 驗收](reviews/PHASE3B_SLICE1_REPORT.md)
- [ ] 由審核者補跑 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。
- [ ] 後續切片完成執行隔離、通道與 BI 歸屬、助理設定介面，以及交辦、結果與通知流程。

## Phase 3B 切片 2 隔離執行與內建工具

- [x] 在隔離的 Windows Job 驗證固定版 OpenCode v2.3.2。SSE 可將 relay 注入的欄位傳至 MCP，測試也核對權限覆蓋、工具允許清單及工作台遮蔽。 [原始切片 2 探針](reviews/PHASE3B_SLICE2_REPORT.md)
- [x] 2a 依設計第 12 節驗證 SSE 契約，拒絕受管會話的非串流工具請求。建立會話權限、內建工具一次性票券，以及 Web 與 Telegram 共用的模型派送順位。 [2a 驗收](reviews/PHASE3B_SLICE2A_REPORT.md)
- [x] 2b 在正式 launcher 啟用內建 broker，遷移工作簿至受控檔案寫入，統一 Web、Telegram 與 MCP 的知識查詢授權。自訂 MCP 僅代理符合授權的遠端 HTTPS 工具，暫停本機與私人網路工具提供給助理，保留設定連線測試。完成隔離效能煙霧測試。 [2b 驗收](reviews/PHASE3B_SLICE2B_REPORT.md)
- [ ] 由審核者補跑 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。

## Phase 3B 切片 3 通用通道及 BI 領域歸屬

- [x] 遷移兩個內建 Telegram 帳號、通道收寄件、游標與會話歸屬。啟動核對原 bot 與擁有者指紋，依助理語言回覆。 [切片 3 進度](reviews/PHASE3B_SLICE3_REPORT.md)
- [x] 抽出 BI 送審服務，保留原始收件、補件、審核與發布歸屬。依收件會話核對狀態、補件及發布通知。
- [x] 修正 Telegram 未來版本拒絕與升級測試的 SQLite 清理問題。已用隔離的 Windows fixture 驗證修正前後。
- [x] 通道設定 API 支援驗證、確認綁定、解除與改綁。合成第三個 bot 驗證專職會話、語言、忙碌時拒絕改綁、舊版通知目的地及輪詢衝突。
- [x] 合成 Telegram 經已配對且有 CSRF 保護的審核 HTTP API 驗證來源、核准、發布和原 topic 通知。來源不明的舊審核維持 BI 預設 topic。
- [x] 以共用工作台帳派送 Web 回合、Telegram 收件、BI 補件與送審、排程及立即執行。完成優先順序、租約、逾期、復原及擁有者處理 API。 [切片 3c 驗收](reviews/PHASE3B_SLICE3C_REPORT.md)
- [ ] 以 UUID 來源鍵支援新增帳號的 BI 收件。
- [ ] 開放新增帳號經擁有者確認後重送不確定的通知。
- [x] 切片 4 加入通道設定畫面與審核助理來源標籤。
- [ ] 由審核者補跑 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。

## Phase 3B 切片 4 建立精靈、助理與通道畫面

- [x] 加入助理、工作資料夾會話及設定版本 API，保留主助理的既有路由。
- [x] 工作台新增助理列表、會話分組、精靈與詳情。主助理頭像及指示移至詳情，設定保留入口。
- [x] 顯示通道指派與審核來源。依助理選擇模型、讀取來源與外部工具，Skill 與助理排程保留後續入口說明。
- [x] 完成依序驗收、三次 Chromium 測試及 88 張雙語合成截圖。
- [ ] 擁有者複核驗收結果與合成截圖。 [切片 4 報告](reviews/PHASE3B_SLICE4_REPORT.md)

## Phase 3B 切片 5 交辦工具、台帳與預算

- [x] 將五張 STRICT 交辦表加入中央工作台帳。新版驗證既有工作與預算保留，並比對新增結構及空表。
- [x] 以固定 OpenCode 和合成 gateway 驗證主助理的交辦票券、封閉參數、請求鍵去重、額度保留及附件交接副本。
- [x] 接上正式派送與專職執行，包括 BI 待審收據、relay 與 broker 計量、時限、終態結算、取消與重啟對帳。
- [x] 在 Web 與 Telegram 主助理開放交辦工具，提供已配對的結果、事件、匯出、取消及雙語預算設定。 [切片 5 報告](reviews/PHASE3B_SLICE5_REPORT.md)
- [x] 切片 6 接上交辦結果卡、唯讀執行紀錄、取消、後續回合脈絡與原對話的完成及發布通知。[切片 6 驗收紀錄](reviews/PHASE3B_SLICE6_REPORT.md)
- [ ] 在 BI 專職助理的 Web 直接對話提供依會話授權的收件狀態與補件。
- [ ] 由審核者補跑 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。

## Phase 3I 切片 1 分級、來源快照與交辦接單

- [x] 已配對工作台可分級工作資料夾、來源檔案與知識庫。檢查來源、版本、雜湊、權限及繼承分級後，固定這次選取的公開資料。
- [x] 外部幫手各自預設停用。Claude Code 需要擁有者確認商業條款。Web 主助理可使用已核准的清單識別碼接單，預設等待擁有者確認後才排隊。
- [x] 完成繁中與英文的分級、設定警示及交辦確認介面。中央台帳升至 v7，保留 3B 內部交辦。 [切片 1 驗收紀錄](reviews/PHASE3I_SLICE1_REPORT.md)
- [ ] 由審核者補跑 `test:e2e:web`、`test:e2e:excel`、`test:install`、`test:upgrade` 和 `test:backup`。
- [ ] 切片 2 完成 Windows 隔離、原版 CLI 與供應商個別驗收。切片 3 完成已驗證的差異匯出、預覽及下載。

## R22 對話附件

- [x] 對話與輸入區支援拖放檔案，輸入框可貼上檔案、截圖和文字。沿用上傳限制、資料分級與右側圖片預覽。 [驗收紀錄](reviews/UX_COMPOSER_DROP_PASTE_REPORT.md)
- [ ] 由審核者補跑 `test:e2e:web`。
