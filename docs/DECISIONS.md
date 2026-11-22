# OEP 決策紀錄

## 2026-11-21　Stage 3 架構整合

以下為已收斂的設計及既有約束。Stage 4 仍待 owner 核准 v2。 [ADR](ARCHITECTURE_DECISIONS.md) · [v2 計畫](IMPLEMENTATION_PLAN_V2.md)

- ADR-001、002　鎖 OpenCode v2.3.2 binary、client、OpenAPI SHA-256。OpenCode 擁有 harness，OEP 薄 adapter 只做接入與對帳。
- ADR-003、009　OEP BI 服務擁有 job/effect ledger，立即、定時、Run Now 同走 claim。OpenCode Automation 首版關閉。Telegram 採 durable inbox/cursor、at-least-once 與業務冪等。
- ADR-005、006、008、014　獨立同源 Web、loopback 加 upstream password、OEP 代理與 Host/Origin/CSRF 驗證。XLSX 受控轉換。SSE 用重連對帳，log 保存去敏關聯識別值。
- ADR-010、011　核准後的 revision 由一致發布指標及不可變內容保留，遷移先乾跑及 shadow，備份可驗。先用 FTS5 與繁中詞法。
- ADR-012、013　AEP 唯讀，公開 repo 不放公司程式、資料、設定、端點或 secrets。以獨立實作及合成 fixtures，管理分發授權，憑證存本機受保護空間。
- ADR-015、016　分層驗證並提前建知識基線。SOP→Excel 驗收 5/5、openpyxl 逐格與故障注入。

ADR-004、007、017 的入口範圍、語言及 Windows 策略待裁決。開工條件、授權、Gateway、驗收口徑與產品範圍統一放在 [待 owner 決定](IMPLEMENTATION_PLAN_V2.md#待-owner-決定)。Claude 只交叉讀 Codex §A、§G、§H。此紀錄只依讀碼、metadata 與文件，沒有應用程式執行結果。

## 2026-11-21　Stage 4 核准與 Phase 0 開工

Owner 回覆「接受所有建議預設並開工」。以 Asia/Taipei 日期記錄，確認 v2 及 D01–D09 全部建議預設。此輪從 `60bbe88` 啟動 `phase-0/spikes`，執行至 Phase 0 gate 即停。

- D01　OEP 自有程式採 MIT。AEP 唯讀且僅參考，使用獨立編寫的程式與合成資料。
- D02　採可撤銷、限模型、限預算的測試 gateway key。Owner 授權使用現有測試 gateway 進行低流量、合成 S2；實際 key scope、retention 與模型 egress 仍須確認。現有憑證依 owner 指定優先取程序環境，缺少時讀取 Windows User scope，僅保存在記憶體。禁止管理端點。
- D03　明確 Ask 入口先檢索並強制共用 verifier。
- D04　TypeScript／Node.js 24 LTS 為主，Python 限必要的文件轉換和 openpyxl 驗證。
- D05　先匯入已發布快照與 provenance。
- D06　Windows 11 x64 使用者登入後常駐，24 小時補跑，RPO ≤24 小時、RTO ≤30 分鐘。
- D07　雙 Telegram bot、私聊 allowlist，限核准的公開連結。
- D08　合成 SOP 和逐格 oracle 需 owner 或指定 reviewer 核定。此回覆核定流程，個別內容待審。
- D09　固定 OpenCode v2.3.2 binary、client、OpenAPI hash，採獨立 OEP Web，通用 Automation 預設關閉。

Phase 0 僅提交 probes、報告、合成 fixtures 與 repo hygiene。所謂一次性 probe 指實際執行狀態與下載檔存於 worktree 內隔離且忽略的 `.phase0/`，可重現腳本納入版本控制。下載與靜態檢查可先完成，任何 OpenCode 執行須在隔離環境內進行，與工作目錄或停用 tools 分開驗證。

## 2026-11-21　Phase 0 觀察、解讀與 gate 阻擋

- ADR-001、002、003、006、014、017　Windows 安裝包及規格 pin 通過。此主機無可用的私有 Windows VM，OpenCode 只在固定 Linux 容器執行，以唯讀 worktree、獨立暫存 profile、loopback 和密碼補取契約證據。Windows 原生 OpenCode 的版本、API、SSE、listener 和 Job Object 行為保留 **UNVERIFIED**。實體主機的 Node 合成 Job 測試可獨立採信。睡眠／登出僅在私有 VM 執行。Automation 以 flag 測到單次漏跑，MVP 繼續關閉。
- ADR-002、013、015　透過固定 OpenCode 測得兩個已選 alias 的 20 個連續成功工具回合。兩個已列出的候選 alias 回 400，不可啟用。`/v1/models` 的無憑證 500／錯誤憑證 400 仍不符合認證驗收，需管理員對帳並證實該 key 為受限可撤銷 key。固定 model 層 `tool_choice` 會跨工具步重複套用，故 forced 首次呼叫通過，但完整自然終止的 forced turn 仍失敗。候選 alias 的單句健康證據不能核准工具或媒體。長輸入、429、5xx、timeout 採合成注入，真服務行為保留 **UNVERIFIED**。
- ADR-005、014　附件入口拒絕客戶直接提供 URI，只有 probe 可用自己的合成 bytes 建立 URI。S4 三次斷線達標。將 v2 的「斷線／overflow」保守解讀為另列 upstream overflow 證據，實際 overflow 仍未驗。受控轉換及單一 proxy 都是 spike。
- ADR-004、007、012、015、016　合成 48 題固定且測得文字檢索指標，owner 尚須另行核對 D08 的 SOP 與 oracle。本輪不上真資料。AEP 維持唯讀參考，新增程式與合成資料依 D01 採 MIT。

Phase 0 gate 維持 **未通過**。不降低 Windows、Gateway 與獨立 review 的門檻。 [v2 Phase 0 修訂](IMPLEMENTATION_PLAN_V2.md#2026-11-21phase-0-實測修訂) · [完整 gate 證據](reviews/PHASE0_GATE_REPORT.md)

## 2026-11-21　Phase 0 審查修正第 1 輪

- I-1　Phase 0 relay 只在合成回合首步轉送 forced `tool_choice`，比對唯一工具結果後改用 `none`。兩個 alias 各完整跑完一次。原 FAIL 及本輪結果一併保留。 [S2](validation/p0-s2-gateway.md)
- I-2　Secret scan 加入 RFC 1918 IPv4 規則，涵蓋無 scheme 和帶 port 的位址，獨立於程序環境值。合成正反例隨 Phase 0 驗證。
- I-3　`--network bridge` 限於 Phase 0 Gateway probe。Phase 1 加入 relay-only 出口設計及 Windows VM 正反例驗收。此輪只記錄設計。 [S5](validation/p0-s5-security.md) · [v2 出口修訂](IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance)

O-1 至 O-4 維持未結，Phase 0 gate 未通過。本輪修正待獨立複核。 [Claude Code 首輪審查](reviews/PHASE0_CLAUDE_REVIEW.md) · [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)

## 2026-11-21　Phase 0 待辦責任分派

- O-1　Gateway 管理員負責提交受限 key、egress 與 retention 證據。
- O-2　Gateway 管理員負責說明無 key 回 HTTP 500、錯 key 回 HTTP 400 的根因及預期認證行為。
- O-3　Owner 指定「use GPT dots to test」。此為 owner 指定環境，細節待釐清（owner-named environment, details pending clarification）。Windows 11 x64、隔離條件、原生 OpenCode、睡眠及登出均待驗，阻擋狀態維持。
- O-4　Owner 親自核定 D08 合成 SOP／PDF 與逐格 oracle。 [Oracle 填寫範本](validation/d08-oracle.template.md)

O-1 至 O-4 維持未結與原 gate 狀態。提交清單見 [HANDOFF](HANDOFF.md#phase-0-owner-checklist)。

## 2026-11-21　Owner 核准 Phase 0 gate 修訂

Owner 在對話選擇「照我的建議放寬」。此修訂取代原 v2 的 O-1 至 O-4 全部結清門檻，原標準及驗收歷史保留。

- O-1／O-2 為 Gateway 管理員負責的 **TRACKED KNOWN RISKS**，尚未通過。Gateway 只用於合成資料 spike，憑證不得寫入 repo、log 或 trace，保留去敏與 secret scan。OEP 將每個非 2xx 視為失敗。新 relay 的真憑證限 HTTPS。
- O-3a 在這台 Windows 11 x64 主機做原生基本測試。使用獨立的暫存 profile/data、密碼及 `127.0.0.1`，在 Job Object 中運行固定的 v2.3.2，驗證啟動、認證、mock relay session/prompt、SSE、IPv4/IPv6 listeners、正常停止與無殘留。
- O-3b 睡眠／喚醒、登出／再登入延期追蹤，尚未通過。「GPT dots」是 owner 指定而細節待釐清的環境，未確認為 Windows VM。
- O-4 由 owner 親自核定。Phase 0 提供合成 SOP／PDF、預期 XLSX 與逐格 oracle 草案。核定是 Phase 1 E2E 驗收門檻。 [D08 草案](validation/d08-oracle.md)

新 gate 須同時有 R-1 至 R-9 與 4 項 Minor 修正及反例、由 Claude 安排的獨立複核無未結 Critical／Important，以及 O-3a 通過。三項皆滿足才可記錄 **conditionally passed**。 [v2 修訂](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)

## 2026-11-21　Owner 免除 O-3b 真實 OS 驗證

O-3b 狀態為 **WAIVED by owner – not tested**。Owner 已免除睡眠／喚醒及登出／再登入測試。O-3b 無 GPT dots、VM 或 Hyper-V 工作，也無 PASS 證據。

D06 的登入常駐、登出暫停、睡眠恢復對帳、24 小時補跑、RPO ≤24 小時及 RTO ≤30 分鐘均為 **UNVERIFIED** 設計假設。Phase 4 保留啟動／恢復對帳實作，以模擬時鐘跳躍、終止程序與重啟做單元及整合驗收。結果僅驗證模擬條件，無真實 OS 睡眠或登出證據。使用者文件須寫明，在 owner 於真實使用中驗證前，OEP 對跨真實 OS 睡眠／登出的排程正確性無保證。

Phase 0 修訂後的三項 gate 條件維持。R-1 至 R-9 與 4 項 Minor 修正及反例、乾淨的獨立複核和 O-3a 通過齊備後才記錄 **conditionally passed**。 [v2 修訂](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)

## 2026-11-21　Owner 核定 O-4 最小 D08 smoke oracle

Owner 明確回覆「O-4 OK」。核定 `Readings` 的 `A1:C3` 和 `Run` 的 `A1:B2`，共 13 格，精確相等，容差 0，僅用合成資料，禁止公式及額外工作表。Owner 核閱 Markdown SOP 與 oracle；核定以 PDF 抽取結果與兩者一致、逐格與核定雜湊測試通過為條件。O-4 不再開放。更改核定值或規則需事先取得新的 owner 核准。 [核定內容與 SHA-256](validation/d08-oracle.md)

用途限最小管線接線 smoke。含計算的多步驟 oracle 是可另案選擇的 Phase 1 工作，本輪未建立。Phase 0 gate 仍待獨立複核。

## 2026-11-21　Owner 豁免結案並啟動 Phase 1

Owner 已將 Phase 0 合併至本機 `main`（`1c45494`）並授權實作 Phase 1。Phase 0 以 **owner waiver** 結案，原 v2 及修訂後的 gate 均未通過。O-1／O-2 繼續追蹤，O-3b 維持免測，O-4 維持核定的 13 格精確相等最小煙霧 oracle，D01–D09 繼續適用。

下列五項 probe 證據降為 **UNVERIFIED**：

- S4　跨其他客戶端／路徑的重複送件計數。
- S4　已收到緩衝事件後串流切斷時的重連。
- S2　工具執行失敗時的回合內容、call ID 與結果形狀。
- S4／S2　probe teardown 錯誤處理。已知有跳過清理、`SyntaxError` 轉 502 後 exit 0、原始原因遺失的路徑。
- S6　Windows Job supervisor 將 worker 的 `null` 退出碼當作 0。

三項 Minor 一併列為 **UNVERIFIED**：Git 設定文件未區分兩把鎖、`windows-job.cs` 未檢查 `CloseHandle` 回傳值、secret scan CLI 未給模式時靜默 exit 0。Phase 1 只在現有產品測試直接涵蓋時補證據，這份清單不阻擋開工或另開一輪舊 probe 複核。

Owner 允許 Phase 1 使用設定中的 Gateway URL。測試 Gateway 採 LAN 明文 HTTP，token 傳輸未加密，後續可請 Gateway 管理員提供 HTTPS。

## 2026-11-21　Phase 1 PoC 的實作與驗收口徑

- 啟動時一次選一個已核准 alias，預設 `gpt-5.4-mini`。以固定 OpenCode、同一 provider 與 relay 驗合成 nonce。任一請求非 2xx 或健康檢查逾時，該次驗收失敗。OEP 以 durable ID 對帳，不重送 prompt 或自動切換 alias。
- 每次 Excel campaign 建獨立 OpenCode profile，且每次 run 新建 workspace 與 session。OpenCode 執行檔案工具，模型寫出 `program.js`。OEP 的 Node 工作程序提供固定 `writeWorkbook` 介面執行產物步驟，並以 SQLite 留存狀態、收據及 SHA-256。此工作程序只用於合成 PoC。
- 直接使用 D08 核定資料、逐格 JSON 與 13 格精確相等規則。五回合交替餵 Markdown 與 PDF，驗證實際送件、工具寫檔及獨立 openpyxl 核對。合成供應方結果單獨保留。 [D08 核定](validation/d08-oracle.md)
- 本輪採實體 Windows 11 x64 檢查 launcher、relay 與 agent 層的檔案權限。v2 的目標 VM、網路出口和防火牆旁路驗收維持 **UNVERIFIED**。 [驗收紀錄](reviews/PHASE1_GATE_REPORT.md)

## 2026-11-21　Gateway 恢復後的真模型重測

- 以各 alias 的啟動 nonce 為准入條件。若完整的 HTTP 200 回覆沒有可用內容，保留該次為失敗，啟動檢查最多以新 session 重試一次。一般驗收的空回覆若未產生程式，記為該回合失敗並重算連勝。每次送件仍使用各自 durable ID，不重送同一 ID。
- 每個通過健康檢查的 alias 交替跑 D08 Markdown 與 PDF，最多九筆，達到實際連續五筆即停止。故障驗收先讓真模型寫程式並保留原檔與雜湊，再於各 run 的工作目錄注入故障。
- 每次保留 relay 與上游 HTTP 狀態、可見輸出的類型、各請求延遲及 Gateway 有回傳的 token 用量。完整空回覆與未完成的串流有各自的紀錄。測試 Gateway 維持先前核准的 LAN 明文 HTTP，憑證在該段傳輸未加密。 [重測證據](reviews/PHASE1_GATE_REPORT.md#gateway-恢復後的真模型重測)

## 2026-11-21　Owner 啟動 Phase 2

Owner 已將 Phase 1 合併至 `main`（`e616e6a`）並推送，授權在 `phase-2/web-gui` 開始 Phase 2。普通真模型測試共 23 筆，19 筆通過，兩個 alias 各有同輪連續 5 筆通過。真故障注入的 7 個負例全數判失敗。Phase 2 依 v2 交付 Windows 單鍵啟動、同源 Web、附件、即時進度、產物下載及 BI 待審介面 stub，止於 Phase 2。 [Phase 1 驗收](reviews/PHASE1_GATE_REPORT.md) · [Phase 2 計畫](IMPLEMENTATION_PLAN_V2.md#phase-2同源-weblauncher-與附件)

- 保留限制。AEP 唯讀，禁止推送、強制推送、重寫已發布歷史及直接提交至 `main`。禁止刪除或覆寫目前 worktree 或 OEP 資料目錄以外的檔案。禁止 Gateway 管理端點。已追蹤檔案只使用去敏設定，維持既有 hooks 與掃描，提交前跑 `npm run scan`。
- 工作方式採最簡可行作法。取消例行加審、逐斷言 mutation、舊 Phase 0 probe 加固及小決策逐項請示。每個提交聚焦一件事。保留 lint、typecheck、test、build 的實際輸出及所有真模型嘗試，含失敗與重試。開發結束交由 Claude Code 做一次輕量複核。
- Gateway 使用程序或 Windows User scope 的 `OEP_LITELLM_BASE_URL`、`OEP_LITELLM_API_KEY`，位址及 token 不寫入輸出、日誌或提交。延續核准的 LAN 明文 HTTP 與 `gpt-5.4-mini`、`claude-haiku-4-5-20251001`。沿用 relay 和有界的模型重試。UI 顯示去敏逾時、空回應及未確定的送件結果。
- Web 採同源靜態 HTML、CSS 及原生瀏覽器 JavaScript，無前端建置依賴。附件透過單檔 HTTP 請求送入，UI 負責拖放及選檔。自動測試使用 HTTP 契約與可用的 Windows Chromium 瀏覽器。

## 2026-11-21　Phase 2 實作取捨

- Windows 捷徑採 VBS 隱藏啟動 PowerShell。首次具備系統工具及核准 Gateway 設定後，由啟動器補齊 npm 依賴、Windows 固定版執行檔與 OpenAPI。啟動以本機版本、認證及 listener 驗證為準，Gateway 請求於使用者送出訊息時開始，服務逾時仍可打開對話與檔案清單。同帳號第二次啟動通知既有主程序重新開頁。
- PNG、JPG、PDF 以伺服器從已核對的 bytes 自建媒體附件。UTF-8 文字與有工作表／列號的 CSV 投影作為模型文字輸入。存檔單檔 20 MiB，每個會話的上傳工作區 200 MiB，計入原檔及 CSV 投影。模型暫存使用專用工作目錄。每則訊息的原始媒體合計上限 40 MiB、文字合計上限 1 MiB。Gateway relay 保留有界請求體及逾時。PDF 交核准模型處理。
- Web 運行中一次派送一個模型 turn，讓同機兩個以上的會話可保有獨立資料及台帳，並可精確關聯 Gateway 請求。OpenCode 內部重試保留由 relay 稽核。OEP 每個 ID 派送一次，後續依同一 ID 對帳。OEP 重啟後未驗證的工作顯示失敗或待核對。對話從 OpenCode 讀取，OEP 只保存自身會話映射、附件、run、收據及產物 manifest。
- Web Excel 由助理將資料寫入僅當次 run 可寫的 JSON 檔。OEP 只解析資料並驗證 JSON 與工作簿，使用 Phase 1 現有工作簿編碼器建立固定值 XLSX。產物限制為 4 張、每張 20 列／12 欄。BI 待審列使用固定假資料。
- Chromium 驗收採已安裝的 Edge／Chrome 與 Node 內建 WebSocket，無 Playwright 下載。Windows 腳本測試由 WSH 實際啟動，測試邊界攔截最後的 OS 瀏覽器交接，保護目前的使用者瀏覽器；另外以隔離 Chromium profile 驗 UI。

## 2026-11-21　Owner 啟動 Phase 3a 並安排 GUI 功能對照與版面

- Owner 確認 Phase 2 已推送、基本對話可用。保留現有 GUI 視覺風格，對照 AEP Web 的全部適用 Settings／Operations，版面依 Codex／Claude Code／T3 Code 的 sidebar、中央串流對話、底部輸入框及輔助面板安排，含設定、鍵盤與淺深主題。
- 以唯讀來源記錄功能、替代方案、階段及驗收，延續 D01 獨立實作。2b 盤點先提交，通用 GUI 後續分批交付。3a 僅新增現有視覺風格的知識頁入口與 Ask，3b／4 分別接入寫入審核、Telegram 與排程。2b gate 完成後才打包。
- 本輪工作限制集中於破壞性操作。AEP 唯讀，禁止 push、強制推送、重寫已發布歷史、直接提交 `main`、刪除或覆寫 worktree 與 OEP 資料目錄以外的檔案，以及呼叫 Gateway 管理端點。合成資料、既有 hooks、提交前 `npm run scan` 續用，憑證、真實主機及公司資料不入提交。
- 取消 Phase 3a 額外審查與 mutation，常規實作決定採簡單且可逆作法並記錄。lint、typecheck、test、build、模型嘗試與報告的逐項門檻仍需驗證。Gateway 維持 User scope 回退、兩個核准 alias、短次數重試與先前明文 LAN 紀錄。
- 文件自查確認 D01、D03、D04、D05、D07、D09 及 3a→3b→4 依賴完整。已在追加條款釐清 2b 並行與打包 gate，並更新舊的 3a 獨立複核任務。Phase 2 未驗項目保持歷史狀態。 [計畫修訂](IMPLEMENTATION_PLAN_V2.md#phase-2b-gui-parity)

## 2026-11-21　Phase 3a 實作決策

- 使用 Node 24 內建 SQLite，原始快照、正規化快照及證據依 SHA-256 存 blob，與 FTS5、發布指標合為同一交易。相同修訂內容固定，較舊版本保留。CLI 匯入時以 `--allow-model` 明確授權該修訂送模型。唯一 Python 步驟為核對 AEP BI 舊封裝的數字正規化與 digest。
- 明確 Ask 使用與聊天同規格的獨立 LiteLLM relay，一次只讀一座 vault。每一項公開答案均由已驗證的逐字摘錄組成，可開展原段；另檢測顯式引文指令及中英混合的技術詞匹配。OpenCode 保有一般聊天 harness，MCP 呼叫同一 Ask 及 verifier。保留 Phase 3a 計畫中「透過 OpenCode 生成」與實際採 relay 生成的差異。 [驗收報告](reviews/PHASE3A_GATE_REPORT.md)
- 以 Phase 0 的 48 題加 10 段合成干擾語料重跑真模型。第一輪 Haiku 的錯誤證據保留，後兩輪兩個 alias 達門檻。現行 OEP 服務持有 Windows 單實例鎖，原生合成測試經明確注入使用專用 mutex，正式啟動仍採原本的鎖。 [操作與評分](validation/p3a-knowledge.md)

## 2026-11-21　Phase 3a 儲存庫資料夾取捨

- 先支援 BI 的已發布 SQLite。以發布紀錄順序解析標籤，僅驗選中標籤與其成品。發布紀錄無法判讀、最新 tag 缺件或成品不符時，保留目前的 OEP 世代。沒有發布紀錄時回報未發布。Wiki 資料夾提供結構檢查，既有 Wiki manifest 與合成快照匯入沿用原契約。
- 在既有 OEP SQLite 以每筆發布事件建立不可變世代。原始 SQLite、卡片、欄位出處、關係、證據與 FTS5 同交易持久化，最後切換指標。發布排序以 clock 為準，可重發舊 tag。保留既有世代供明確回復，較舊輸入不取代目前的發布。證據出處以快照內資訊為準，原始文件的獨立核對與撤回紀錄重播留待實際版本確認。
- Web 以現有同源配對及 CSRF 驗證接收本機完整路徑。結構檢查預設遮蔽 tag 及深層路徑，CLI `--show-names` 在本機解除名稱遮蔽。預設匯入只供本機持有，獲明確模型授權的世代才供 Ask 使用。 [格式與操作](validation/p3a-repo-reader.md)

## 2026-11-21 Phase 3b implementation decisions

- Store review schemas, original drafts, saved edits, job claims, effects and notification intents as additive SQLite tables. Commit the reviewed snapshot, blobs, FTS index, pointer, review receipt and outbox intent in one transaction.
- Keep the Phase 3a snapshot and SQLite format readable. A vault with an installed review schema accepts new active publications through review. Existing published imports remain available for unmanaged vaults.
- Use a distinct candidate ID as the job, review and notification deduplication key. Compare the saved edit number during review and the published predecessor during publish and rollback.
- Normalize known AEP SQLite layouts 8, 9 and 14 in memory. Fail closed on unknown versions and use the OEP data directory for writes.

## 2026-11-21　Phase 3a 檢索與 Gateway 拒絕

- D03 補充。FTS5 匹配結果按 NFC 與空白正規化後的文字合併，保留每筆段落識別碼、卡片、來源與位置。每組以最佳 FTS5 匹配選出代表，再按詞法訊號排序。Ask 對代表段落的原文、來源、位置及雜湊執行既有引用驗證。多來源關聯留在檢索結果內，共用引用契約維持原樣。
- 每次 Ask 最多提供 5 段、合計 20,000 UTF-8 bytes 的段落正文。這是以 byte 為基礎的 tokenizer 的保守正文 token 上限，問題、JSON 包裝及固定指令另計。既有 SQLite 發布世代可直接查詢。
- Relay 將不可重試的 4xx 交給 Ask 作為 `gateway-rejected`，一次結束並以固定繁中文案呈現。429 與 5xx 維持原重試策略。 [驗證](reviews/PHASE3A_RETRIEVAL_REPORT.md)

## 2026-11-21　Phase 3b review improvements

- BI changes use an explicit parent and content-addressed source uploads. The existing candidate API remains available. Human review and the same atomic publication and intent transaction apply to both paths.
- First-publication rollback records deactivation and retains the vault and history. Reactivation is an explicit review action. Ask and MCP use a SQLite read-only connection.
- Owner decision for 3b-R5. Model proposal is available by default to anyone who can see the BI vault. Permission is handled externally. Proposal requires an explicit action, deterministically validates every quoted excerpt, and creates only a pending review. The UI and operations guide state that source text leaves the machine through the LAN HTTP Gateway. Ask retains its existing publication-level model permission.

## Phase 4 implementation decisions

- Key Telegram intake by bot slot and update ID. The owner and bot binding protects the ledger when credentials change. Private conversation topics use separate OpenCode sessions.
- Keep a send with unknown delivery in the outbox for reconciliation. Retry an explicit rate limit using the server delay. Preserve BI publication intents and use their review IDs as outbox keys.
- Use a local date and configured time as the daily occurrence identity. Run Now uses the same key, so a repeated DST minute and overlapping triggers share the BI effect.
- Keep downloaded binary originals and blocked public URLs in the inbox. UTF-8 supplements let an owner stage a review without enabling automatic model use.

## Phase 4 Technical Lead follow-up

- Store inbox first-seen time and processing attempts. Stop after 120 seconds from the first attempt or 20 attempts. Commands have a separate lane. Preserve failed updates and create their replies in the same transaction.
- Long poll for 25 seconds per bot. Saved inbox processing and outbox delivery run independently of that request.
- Treat a configured active BI target as owner authorization for the existing model proposal flow. Preserve the target per intake. Exact-source quote validation and human approval still apply.
- Allow the owner to resend an uncertain notification from the work view after confirming the duplicate risk.


## Phase 2b 工作台實作

會話名稱及刪除標記使用附加 SQLite 表，讓既有會話及稽核資料可保留。主題及最後選擇存於瀏覽器。助理設定依接收回合時的值，沿用既有 OpenCode 文字輸入。


## Phase 2b Slice 1b 專案範圍

工作台提供兩個由 OEP 管理的工作根目錄。舊會話歸入主要工作區，原 API 路徑保留主要工作區語意。專案路徑先驗證會話歸屬，再讀取狀態、訂閱事件、上傳附件或下載產物。側欄只展開目前專案的會話。

## Phase 2b Slice 2A 工作台取捨

- 助理 Markdown 由 DOM 建立文字和區塊。工具由 OpenCode 訊息對帳並在伺服器遮蔽網址、憑證及絕對路徑。活動摘要使用既有 SSE 的事件識別碼，保存每個會話最近 60 筆可顯示事件。
- 停止路由以會話及回合 ID 定址，沿用本機配對與 CSRF。等待 OpenCode 中斷及狀態對帳後結束回合，取消狀態禁止工作簿完成與下載。未能確認中斷時保留待核對狀態。
- 沿用 Relay 完整框架檢查和跨框架遮蔽。逐 token 顯示與重連後遺漏事件補齊仍待驗收。 [驗收報告](reviews/PHASE2B_SLICE2A_REPORT.md)

## Phase 2b Slice 2B 會話面板

- 分頁以專案會話路徑保存於瀏覽器。窄版以底部面板顯示。附件下載與預覽以現有記錄核對檔案身分及雜湊，移除沿用原本的配對及 CSRF 驗證。
- HTML 附件以現有 UTF-8 與大小規則驗證，預覽在空白 sandbox 屬性的 iframe 內使用限制外部資源的 CSP。PDF 提供檔案資料及下載。
- XLSX 比較使用既有轉檔器輸出，按工作表名稱與儲存格位置比對同會話前一版同名產物。
- Relay 的遮蔽行為取決於整個欄位，固定尾端視窗無法保持此語意。保留原 Relay，生成中顯示等候秒數。 [驗收報告](reviews/PHASE2B_SLICE2B_REPORT.md)

## Phase 2b Slice 2C 設定

- 設定使用既有配對與同源 CSRF。SQLite 採新增資料表保留原助理欄位與會話模型，修改設定時在同一交易留存分類及時間。外觀包含 90 KiB、寬高各 1024 像素的 PNG／JPEG。舊瀏覽器主題在首次儲存外觀前仍可讀取。
- 啟動與手動重新檢查對核准模型各送一次固定合成訊息。手動檢查相隔 30 秒。會話切換使用固定版 OpenCode 的模型切換方法。
- 歷史訊息及位元組超界時以完整回合省略。工具數超界時在 relay 阻擋該批呼叫。回合時限到達時中斷推論並與 OpenCode 核對停止狀態。

## Phase 2b Slice 2D 對話操作與設定

- 斜線指令使用固定清單。知識指令沿用已發布證據驗證及知識頁的引用呈現。
- 回覆連結、註記與動作決定保存在 Web 台帳。會話刪除動作卡記錄接受與拒絕，沿用既有 OpenCode 工具核准策略。
- 唯讀資料夾以專案為範圍，使用 OEP 受限的檔案開啟檢查附加副本。工作根為 OEP 管理的每會話沙箱。語音設定存在瀏覽器，轉錄只更新輸入框。 [Slice 2D](reviews/PHASE2B_SLICE2D_REPORT.md)

## Phase 2b Slice 3A

- 概覽以已發布快照為資料來源。伺服器分頁每次最多 25 張卡片，搜尋沿用 SQLite FTS5，重建沿用原子交易。來源欄位、狀態或歷史缺資料時顯示「無資料」。
- 問答保留個別發布版本的模型授權。品質題集儲存在 OEP 知識庫 SQLite，兩題並行上限由瀏覽器及伺服器共同執行。合成示範庫預設本機瀏覽，可明確授權使用模型。
- 示範移除停用示範發布指標。Atlas 網址保存在本機設定，交由瀏覽器在確認後開啟。新會話在建立時記錄 BI 工具開關，已建立會話沿用自身設定。 [驗收](reviews/PHASE2B_SLICE3A_REPORT.md)

## Phase 5 Windows 發行建置

- ZIP 內附固定版 OpenCode 和鎖定的 Node 正式相依套件。Node.js 24、Python 3.12 和 PowerShell 7 由使用者準備。Excel oracle 的 Python 套件以鎖定雜湊安裝。
- ZIP 未簽署。檔案清單逐項列 SHA-256 與大小，ZIP 的外部 SHA-256 同時涵蓋清單。 [發行驗證](validation/p5-release.md)

## Phase 5B 維護與回復

安裝使用每使用者版本目錄和 current.json。備份與回復須先關閉 OEP，以線上備份 API 擷取 SQLite，回復先在同層目錄驗證再重新命名。強制取代前保留原資料和額外安全備份。備份清單只列需要重綁的憑證名稱。D06 和 O-3b 驗證狀態延續既有決策。 [操作文件](OPERATIONS.md)

## Phase 5C 資料相容與中斷復原

使用新版 SQLite 寫入前，先保留一致備份及清單 SHA-256，並原子寫入 `prepared` journal。資料對帳完成才切換版本。中斷時回復到同一筆備份。回退用 `restoring` journal 及固定的暫存與原資料目錄名稱跨重新執行辨識目錄交換進度。完成後保存原資料和待處理工作的列雜湊供對帳。舊版拒絕超出支援範圍的 `user_version`。

## Phase 5D release decisions

Generate CycloneDX, third-party license text and NOTICE from the pinned production inventory. Retain PowerShell 7 for maintenance and Job supervision. The bundled variant uses relative runtime paths and Windows Script Host for hidden launch. Chromium verification remains manual pending evidence of a usable hosted-runner browser.

## Phase 2b Slice 4A

內建知識 MCP 由啟動器管理，設定頁沿用既有 BI 查詢開關。OEP 僅公開固定工具名稱與 OpenCode 的狀態代碼，連線錯誤原文留在執行環境。通用 MCP 的憑證與專案隔離設計待實作。 [驗收紀錄](reviews/PHASE2B_SLICE4A_REPORT.md)

## Phase 2b Slice 4B

自訂 stdio 定義儲存於 Web SQLite。憑證參照採用 `OEP_MCP_<ID>_<NAME>`，後續值儲存沿用 Windows User-scope 環境變數。回復時以備份資料庫核對清單中的參照名稱。專案允許清單與資料範圍說明作為 Email 舊設定的替代，維持由 MCP 管理。 [進度](reviews/PHASE2B_SLICE4B_REPORT.md)

## 2026-11-21　自訂 MCP 套用模型（Technical Lead）

Slice 4B 留下的整合問題：Web 啟動器共用單一 OpenCode 執行環境，無法為不同專案各自注入 MCP 設定。決定如下。

- **設定在啟動時寫入。** 所有已啟用的自訂 MCP 伺服器在 OEP 啟動 OpenCode 時寫入執行環境設定。新增、修改、停用、移除伺服器後，需「重新啟動執行環境」才會生效，設定頁提供明確按鈕及提示，並說明不會中斷已存在的資料。不使用 OpenCode 的 experimental 動態新增與移除端點。
- **專案可用清單用會話權限規則實作。** 伺服器對特定專案不可用時，該專案新建立的會話以權限規則拒絕該伺服器的工具，作法與 BI 查詢工具開關相同。模型看不到被拒絕的工具，以合成模型的請求紀錄驗證。
- **憑證值只經子程序環境變數注入。** 值保存於 User-scope 環境變數（`OEP_MCP_<ID>_<NAME>`），啟動時由啟動器讀入並只交給 OpenCode 子程序，不寫入設定檔。
- **理由：** 動態端點為 experimental 且固定版本的行為變動風險高；重啟套用行為單純，可測，也和 D06 的啟動／恢復對帳一致。
- **捨棄的替代方案：** 動態新增與移除（風險高）；每專案各自啟動一個執行環境（資源與單一實例鎖衝突）。

## 2026-11-21　自訂 MCP 傳輸與工具權限

自訂伺服器由 OpenCode 在連線時啟動 OEP 的 stdio 傳輸程序。本機程式從環境取得其憑證值。遠端傳輸程序從環境建立 HTTPS 標頭，每次 HTTP 請求固定到這次驗證的 IPv4 位址並拒絕所有重新導向。遠端使用此傳輸程序將 DNS 驗證綁定至實際 TLS 連線。固定版遠端設定可指定 URL 與標頭，DNS 固定與重新導向限制由 OEP 執行。遠端支援 Streamable HTTP POST 的 JSON 與 SSE 回應，使用靜態標頭憑證。設定檔及定義檔僅存憑證參照。移除定義後 Windows 憑證仍可供回復定義時使用。

專案允許清單與個別工具的權限寫入新會話。個別工具開關適用於已驗證可精確對應的工具名稱。其它工具名稱在測試結果中可查看。重啟採用原工作資料及 profile，在對話或工作處理中回覆稍後重試。 [驗收紀錄](reviews/PHASE2B_SLICE4C_REPORT.md)

## 2026-11-22 GUI 外殼以 AEP 版型重做

- **決策：** 擁有者安裝使用後認為 OEP 畫面雜亂、不如 AEP。暫停補功能缺口，先以 AEP 的版型（左側單欄導覽、主區單欄、輸入框為中心、無常駐右欄）重做前端外殼。後端、API 與安全邊界不變。藍圖見 `docs/GUI_REDESIGN_BLUEPRINT.md`，擁有者確認後才派工。
- **理由：** 先前以功能對照表驗收，沒有以日常使用順手度驗收。在版型不對時繼續補功能會增加雜亂。
- **捨棄的替代方案：** 只整理現有畫面（版型不變，無法解決三欄常駐與側欄堆疊）。

## 2026-11-22 多助理採主助理協調模式

- **決策：** 主助理擔任協調者（orchestrator），和使用者溝通並把工作交辦給專職助理。專職助理有各自的工作資料夾、知識庫、能力與通道。使用者可直接和專職助理對話，這些對話不進主助理紀錄。交辦由 OEP 控制，只有一層，每次在專職助理端開獨立執行紀錄，主助理只取得結果。細節見 `docs/PHASE3_REQUIREMENTS.md` 4.9。
- **理由：** 擁有者指定。各專職助理的範圍（知識庫、工具、檔案）可隔離與稽核，主助理保持單一溝通入口。
- **捨棄的替代方案：** 所有助理平行、無協調者（使用者需自己分派工作）；使用 OpenCode 內建子代理（共用工作資料夾與工具設定，無法隔離與完整稽核）；多層交辦（循環與費用失控風險）。

## 2026-11-22 Phase 3 擁有者決議

- **決策：** Share Platform 沿用 AEP 的公司服務，API 參考 AEP repo 唯讀、獨立實作。外部代理（Claude Code、Codex）只做 coding 幫手，只可送公開資料，以機密標記在送出前阻擋；Copilot 暫緩。WhatsApp 最後做，先設計通用通道介面。客製 MCP 為標準 MCP over HTTP（FastAPI 實作）。名片寫入前需審核。分期順序依 `docs/PHASE3_REQUIREMENTS.md` 第 5 節，決議全文見第 7 節。
- **理由：** 擁有者決定。
- **捨棄的替代方案：** 外部代理取代對話模型（資料外送範圍過大）；先做 WhatsApp（需要對外網址與 Meta 商業帳號）；MCP 走 REST 轉換（協定已是標準 MCP，不需要）。
