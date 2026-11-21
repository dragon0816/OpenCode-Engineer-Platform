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
