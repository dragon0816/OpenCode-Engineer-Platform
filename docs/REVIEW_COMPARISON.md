# OEP Stage 3 審查對照

2026-11-21（Asia/Taipei）。證據以 AEP `c9961b2`、OpenCode `v2.3.2` 固定版本為準。Claude Code 只交叉讀取 Codex Stage 1 的 §A、§G、§H，§B–§F 未讀。下表所列 Claude 立場來自其獨立報告與有限交叉審查。Codex 完整讀取兩份 Claude 報告並回查原始碼。 [Claude Stage 1](reviews/CLAUDE_STAGE1_REVIEW.md) · [Codex Stage 1](reviews/CODEX_STAGE1_REVIEW.md) · [Claude 交叉審查](reviews/CLAUDE_CROSS_REVIEW.md) · [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md)

## 共識與互相修正

| 議題 | Claude | Codex | 整合結論及證據品質 |
|---|---|---|---|
| 版本線／契約 | Stage 1 建議先做 V1/V2 spike，Stage 2 接受精確 pin 並指出 `info.version` 不足。 | Stage 1 從 V2 release、client、OpenAPI 定版。Stage 2 重算 schema 與 LF blob 的 hash。 | v2.3.2 binary + client + spec hash。正式 release、npm 與原始碼已驗證，Windows binary 實際驗收 **UNVERIFIED**。 |
| Harness 邊界 | Stage 1 指出薄 adapter 容易變成 control plane，提議可測邊界及交易紀錄。 | Stage 1 區分 session admission 與業務成功，Stage 2 將 BI ledger 放在 OEP 領域服務。 | OpenCode 管 harness，OEP adapter 轉接，BI/Wiki 管固定工作與資料。OpenCode session contract 已讀碼，OEP 屬共識設計。 |
| 排程 | Claude 撤回「無原生排程」，改採 BI ledger，通用 prompt 可走 Automation。 | Codex 從 server process、Automation source 及 OpenAPI 驗證。接受按業務語意取捨。 | 原生 experimental Automation 已驗證，無獨立 Run Now，SSE 不重播與 scheduler 自己的事件游標分開。OEP 自有三種 BI 觸發，通用 Automation 首版關閉。Windows 恢復行為 **UNVERIFIED**。 |
| BI phase 文件 | 原先概括文件落後，Stage 2 接受 `BI_VAULT.md` §11 的實作紀錄及 BI inbox 遺漏。 | Codex 比對 BI vault、staging、FTS5、Inbox 與 `bi_overview`，補正 BI_INGEST 檔首本就指 §12。 | 已從 AEP 原始碼驗證逐功能存在。§11／§12 的完成紀錄屬文件證據，跨媒介原子性、部署與 scripted model 以外結果 **UNVERIFIED**。 |
| 耦合、前端 | Claude 列匯入及 UI 行數，主張新 Web，也曾考慮 OpenCode Web 聊天。 | Codex 重現計數，修正 `knowledge.repo*` 的統計範圍及「15k 要抽出」「59k 要重寫」推論，補精確檔案行數與 AEP API 耦合。 | 匯入／行數與 Host 路由已驗證。MVP 採獨立同源 Web，保留 BI 審核及上傳控制，OpenCode 密碼只給 OEP server。實作成本 **UNVERIFIED**。 |
| 問答及檢索 | 原 MCP + permission 提案改為 hybrid，明確 Ask 強制、MCP best-effort，兩者共用 verifier。接受先 FTS5。 | Codex 堅持已發布 revision retrieval-first，逐 claim 驗證，每次限定 evidence set。加入語意 gold set，支持 hybrid 的入口差異。 | 強制檢索在入口執行，權限輔助。AEP `knowledge_query`、`bi__query` 和 FTS5 路徑已讀碼。OEP 的保證範圍、門檻及品質待 D03／實測。 |
| 知識分期 | 主張 3a 先唯讀問答、3b 再寫入，並提前 baseline。 | Stage 1 草案先領域／遷移／部分寫入，再問答與 Wiki。Stage 2 接受 Claude 順序，保留資料與人工發布驗收。 | Phase 0/1 建合成基線，Phase 3a 唯讀遷移／檢索／詢問，Phase 3b 發布。AEP benchmark 作設計參考，直接比較與原分數 **UNVERIFIED**。 |
| Gateway／附件 | 設定上可接 provider，xlsx 轉換。Claude Stage 2 明承沒有 Gateway 實測。 | 明定逐 alias 工具與媒體契約，補 `media:` 參照與 XLSX 收件／模型可見分別處理。 | 固定版本設定與投影原始碼已驗證。真 Gateway、模型可見與實際轉換 **UNVERIFIED**。 |
| 本機 API／SSE | Stage 2 接受 v2 auth/CORS/SSE 補查。Stage 1 P2 提案為斷線不丟事件。 | Codex 驗證 `/api/event` 斷線無重播、慢 consumer overflow，補固定可信 Host/Origin、密碼、CSRF 和狀態對帳。 | 原始碼已驗證。OEP 端驗收改收斂、授權及零重送，Windows listener 和代理 **UNVERIFIED**。 |
| Telegram | Stage 1 稱 durable cursor 可借用。Stage 2 限縮並要求 durable handoff。 | Codex 指出 hook 例外仍可前推、記憶體去重。加入 inbox/cursor 同交易與業務重播。 | AEP 邊界由讀碼確認，漏件是推論。OEP at-least-once 加本機冪等，外部通知可未定。真 bot、身分與社群內容 **UNVERIFIED**。 |
| R9 與 Phase 1 | 提出 5/5、openpyxl 逐格和注入失敗，稱 TurnEffects 為 AEP 對策。 | 核對歷史問題另案的文件，區分 per-turn 去重與產物驗證。補背景、舊檔、錯值、退出收據、hash 及斷線。 | 歷史是假成功報告（僅文件），TurnEffects 是讀碼確認，P1 採加嚴的雙方驗收，通過率尚 **UNVERIFIED**。 |
| LICENSE／.env | 指出無 LICENSE。Claude Stage 2 補正 `.env/` 是有兩個檔名的目錄。 | 讀 metadata 和固定 Git tree，確認 `.env/` 的結構。沒有讀取內容，fixture 也需另核准。 | 公開 metadata、根目錄缺通用 LICENSE 與 vendor license 檔案可驗。真正重用權及設定內容 **UNVERIFIED**。只用合成 fixtures 與獨立實作。 |

## 未決選項

| 對應 v2 | 方案 A | 方案 B | 建議與決策人 |
|---|---|---|---|
| D01　AEP 重用／基準 | 行為參考加合成資料。可立即設計，缺 AEP 實測對照。 | 權利人逐項批准再做選擇性重用及私下對照。有可比數據，需額外授權及環境。 | A。owner／資料權利人。 |
| D03　Knowledge Asking | Web Ask 與 Main Bot `/ask` 強制，聊天 MCP 共用 verifier。容易保證，使用者需選入口。 | 自由文字分類後亦強制，需要控制所有受保證的客戶端。覆蓋多，增加誤判及執行成本。 | A，先單一 vault 與可測 gate。owner。 |
| D04　領域語言 | TypeScript 領域及 adapter，Python converter/oracle。主要 runtime 較少，部分工具用 IPC。 | Claude 的 Python 領域服務搭配 TS adapter。文件生態成熟，需維運兩套服務與 API。 | A，S3/S6 以實際分發足跡複核。owner。 |
| D05　遷移／Dashboard | 已發布快照與 provenance、唯讀概覽。先驗恢復，省去共享歷史整理。 | 遷入全部歷史與進階 Dashboard。功能較全面，增加遷移與核對。 | A。owner／資料權利人。 |
| D06　Windows 漏跑 | per-user supervisor，窗口內補一次且週期僅最新。部署單純，登出無執行。 | machine service／Task Scheduler，逐筆補跑。跨登出可執行，身分和補跑積壓較複雜。 | A，24 小時窗口及 RPO 24 小時／RTO 30 分鐘。owner。 |
| D07　Telegram 來源 | allowlist 私聊及合規公開連結，受阻人工補件。有清楚資料邊界，來源覆蓋較小。 | 另案支援群組或已授權的外部來源整合。覆蓋增加，需要另定政策、通知及合法存取。 | A。owner／資料政策負責人。 |

D02、D08、D09 是執行輸入與核准責任，雙方無已記錄的相反主張。所有 owner 裁決及預設集中於 [v2 計畫](IMPLEMENTATION_PLAN_V2.md#待-owner-決定)。本輪沒有階段性應用程式測試結果可互相採信。
