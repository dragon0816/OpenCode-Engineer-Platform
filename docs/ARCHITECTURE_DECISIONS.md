# OEP 架構決策紀錄

日期 2026-11-21（Asia/Taipei）。`Accepted` 表示本輪已由審查收斂或沿用既有約束。`Proposed-needs-owner` 表示仍待 owner 裁決。全部決策與實作授權須由 Stage 4 核准 v2。執行驗證集中於 [v2 計畫](IMPLEMENTATION_PLAN_V2.md)，證據範圍見 [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md)。

## ADR-001　鎖定 OpenCode v2.3.2

- **狀態** `Accepted`
- **情境** V1 npm 名稱仍指向 1.19.6。V2 的 API 標示 experimental，`info.version=0.0.1` 無法區分規格變化。
- **決策** 鎖 tag `v2.3.2`、commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`、各支援架構的發布 ZIP 與解包後 binary SHA-256、`@opencode/client@2.3.2` 與 lockfile integrity，以及 Git LF blob `packages/protocol/openapi.json` SHA-256 `bc152825b9b65224bfc56bddefcdd8f44b50e7f1d1541f741ae017aa791478ba`。正式起動前查版本與檔案完整性。
- **淘汰方案** V1 作為新案基線、追蹤 latest、只比對 API 的 `info.version`。
- **後果** 每次升級需更新 pin、檢查 OpenAPI/schema 差異、跑契約、兼容性及 Windows 回歸，先備份 OpenCode profile 與 OEP 資料，在 VM 演練回復。升級失敗或 upstream DB 不向下相容時，使用舊 binary 與對應的升級前備份成套回復，禁止混用。 [v2.3.2 release](https://github.com/anomalyco/opencode/releases/tag/v2.3.2) · [固定 OpenAPI](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/openapi.json)

## ADR-002　OpenCode harness 與 OEP 薄 adapter

- **狀態** `Accepted`
- **情境** `POST /api/session/{sessionID}/prompt` 可 durable admit 輸入，工具及模型執行的完成時點另外查詢。
- **決策** OpenCode 擁有 turn、planning、tool loop、模型呼叫、subagent、tool permissions、sessions/transcript。薄 adapter 只做固定版 client、驗證身分、channel/session/location 映射、同會話送件序列化、受控附件、授權事件投影與接單對帳。adapter 禁止自行規劃或呼叫模型執行 agent loop、接管 subagents、實作通用 tool 重試，以及複製 transcript、tool permissions 或執行歷史為第二份真相。領域服務擁有自己的固定工作步驟及業務驗證。
- **淘汰方案** 複製 AEP Host，或在 adapter 組裝另一個通用 agent runtime。
- **後果** OEP 只追蹤自己的 run/attachment/job/receipt 與 upstream IDs。不同 trust class 預設隔離。已送出且結果未定時先對帳，避免自動重送有副作用的工作。 [OpenCode session 契約](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/session.ts)

## ADR-003　BI 排程、job 和效果帳本

- **狀態** `Accepted`
- **情境** OpenCode 有 experimental Automation 與 SQLite lease，固定 API 缺獨立 Run Now。BI 需保存來源、去重、候選、待審、通知及結果未定狀態。
- **決策** OEP BI 服務擁有 job 與效果帳本。立即、定時及 Run Now 都走同一 transactional claim，保存 occurrence、attempt、lease、來源及 idempotency key。對同一待執行 occurrence，Run Now 提早競領原工作。明確重跑才建新 occurrence，沿用來源去重規則。發出外部操作前保存 intent/穩定 key，逾時先對帳或標記 `indeterminate`。OpenCode Automation 首版關閉，將來只可選用於通用定時 prompt。
- **淘汰方案** 以 OpenCode Automation 保存 BI job 狀態、兩個 scheduler 共同分派同一 BI 工作、以記憶體去重。
- **後果** 隨領域資料備份帳本，需要 crash/replay 測試。Windows 定時語意見 ADR-017。 [Automation API](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/automation.ts)

## ADR-004　Knowledge Asking 強制範圍與共用 verifier

- **狀態** `Proposed-needs-owner`（D03）
- **情境** 限定 MCP 工具權限無法保證模型呼叫該工具。來源存在也無法單憑路徑證實 claim 語意。
- **決策** 明確 Web Ask、Telegram Main `/ask` 由 OEP 先對選定的已發布 BI 或 Wiki revision 檢索，固定 request、passage IDs、hash、locator 及版本，再要求 OpenCode 產出結構化 `claims[]`。共用 verifier 核對 evidence set 成員、hash、頁碼／offset、引文、數字與單位，服務端產生引用連結。無證據、索引失效或驗證失敗即 abstain／error。先緩衝答案，可先串流狀態。一般聊天唯讀 `knowledge_ask` MCP 也用同一服務及 verifier，其工具結果受檢查，agent 自由回答為 best-effort。MCP 問答使用隔離且未掛該 MCP 的生成設定，避免協議重入。
- **淘汰方案** 靠提示詞、權限或引用存在檢查單獨承擔強制責任。
- **後果** 語意支持另以合成 gold set 與人工標註評估。自由文字的自動路由與直接使用 OpenCode 的強制保證延至 owner 核准額外範圍。

## ADR-005　附件及 XLSX

- **狀態** `Accepted`
- **情境** v2 可接收附件，XLSX 無原生模型內容投影。檔案路徑與上傳內容屬不可信輸入。
- **決策** 接受 upload 並指派 opaque ID，以 session workspace、伺服器生成檔名與 URI、MIME/大小/配額/hash 及可驗證的檔案 handle 維護歸屬，拒絕越根、UNC、ADS、symlink、junction、reparse point 與跨 session ID。PNG/PDF 只交已驗證的 alias。XLSX 用有界 converter 產出含 sheet／row locator 的 Markdown 或 CSV，截斷、公式與不支援情形須回報。來源檔保留，轉換不執行 macro／外部連結。下載限 run manifest 所列檔案，主動內容隔離或強制下載。
- **淘汰方案** 把客戶提供的 path／URI 透傳，或只憑 prompt 接受回應認定 XLSX 已讀。
- **後果** 模型可見內容與上傳成功分開檢查，掃描 PDF 用 owner 核准的本地 OCR 或回報不支援。任意 shell 的隔離靠 OS 政策及工具權限。 [附件讀取](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/prompt.ts) · [模型投影](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/runner/to-llm-message.ts)

## ADR-006　本機 API 與同源代理

- **狀態** `Accepted`
- **情境** OpenCode 預設 loopback，CORS 包含 localhost 各 port。OEP UI、上傳及下載需要自己的存取政策。
- **決策** OEP 及 OpenCode 明確綁 `127.0.0.1`，由 OEP 代理必要端點。launcher 每次啟動產生獨立高熵 upstream password，僅 server-to-server 側使用。OEP Web 用一次性啟動配對換 HttpOnly/SameSite session，頁面與 API 同 origin。OEP 依實際 Host/port、可信 Origin、方法、憑證及 CSRF token 驗證請求，SSE／下載也驗 session 歸屬。上游拒推瀏覽器 cookies、任意代理路由及 OpenCode pairing。
- **淘汰方案** 瀏覽器直連 OpenCode、公開 listener 或只依賴上游 CORS。
- **後果** 驗證 LAN 介面無 listener、無憑證受保護路由回 401、錯誤 Host／Origin／CSRF 被拒、密碼未進 HTML／JS／log。OEP 屬單人本機部署，同帳號其他程序的權限需依 OS 管理。 [Server process](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/process.ts) · [OpenCode CORS](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/cors.ts)

## ADR-007　領域服務語言

- **狀態** `Proposed-needs-owner`（D04）
- **情境** Claude 偏好 Python 領域服務，AEP 依賴和授權使套件直接重用不可作估算前提。
- **決策** 建議 launcher、adapter、BI/Wiki/domain contracts 用 TypeScript 與 Node.js 24 LTS，固定 SQLite driver 及版本。Python 用於必要的有界 converter worker 或測試 oracle，透過具 schema 的檔案／IPC 契約和 timeout 使用。
- **暫不採用方案** Python 領域 daemon 搭配 TS adapter，可能加快文件工具整合，同時增加分發、監控與 IPC 維護。
- **後果** 保持單一主要 runtime，Phase 0 S3/S6 比較文件處理、部署與 IPC 足跡。若評估推翻預設，更新 ADR，由 owner 裁決。

## ADR-008　獨立 OEP Web

- **狀態** `Accepted`
- **情境** BI 審核、workspace 附件與 API 存取限制需受 OEP 控制，AEP 內嵌 UI 綁定其 Host。
- **決策** 新建同源 OEP Web，建議 React/Vite 靜態資產，Phase 2 先做 chat、upload、event、artifact，再逐期接入知識與審核。
- **淘汰方案** 直接放入 OpenCode Web 作正式聊天頁、移植 AEP Python 內嵌頁面。
- **後果** OEP 負責上傳、工作狀態及審核的 UX，OpenCode Web 僅用於開發對照。第一版 BI Dashboard 以 D05 指定的唯讀狀態為限。

## ADR-009　Telegram at-least-once 與冪等

- **狀態** `Accepted`（收件與平台範圍見 D07）
- **情境** AEP collector 的 offset 與 hook 結果可分離。Telegram 以更高 offset 確認舊 updates，服務端保存時間最多 24 小時。
- **決策** Main／BI 各有 credentials、profile、單 poller、cursor 與 allowlist。原始 update 或明確拒件紀錄和 `next_offset` 同一 SQLite 交易，commit 後才以新 offset poll。先 durable handoff，再獨立執行領域行為，以 `(bot_id,update_id)`、job/action keys 去重。Main 依 bot/chat/topic 隔離 session。BI 接單不送模型，後續經允許、驗證及分類的 ingest 才產生候選。通知用 durable outbox，外部逾時保留 `indeterminate` 待對帳。
- **淘汰方案** hook 例外後直接丟棄、只在記憶體去重、承諾對第三方傳送 exactly-once。
- **後果** 已接單項目可追蹤及重播，業務效果冪等。超過 Telegram 保存期須顯示可能缺件。 [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)

## ADR-010　資料、遷移、發布與 provenance

- **狀態** `Accepted`（匯入範圍與備份目標見 D05、D06）
- **情境** AEP 來源與 vault 包含檔案、SQLite 投影、修訂及證據。
- **決策** OEP 以 SQLite 保存關係、索引版本、ledger 與發布指標，以不可變內容 blob 保存來源／修訂。先寫入並驗證內容 hash，再以 DB 交易記錄可見的 row 和發布指標。SQLite FTS5 為可重建投影。來源記 source/revision/hash、穩定 locator、轉換工具版本、schema、import key 和核准 actor。只讀 AEP 快照先 dry-run report，再匯入 shadow，對帳後切換。人工審核 publish 和 rollback 均留下版本指標與記錄。
- **淘汰方案** 就地改 AEP、直接接上既有 AEP DB 作可寫資料庫、分開更新 blob 與發布指標而缺恢復機制。
- **後果** 備份採一致 SQLite 快照加不可變 blob manifest、hash 與保留規則。孤立 blob 可在確認備份／引用後清理。Phase 3a 起驗還原及影子索引重建。

## ADR-011　FTS5 優先

- **狀態** `Accepted`
- **情境** 問題常有精確料號、繁中短詞或中英混合文字。向量提升與資料外送需求未驗證。
- **決策** 先用 SQLite FTS5，加繁中斷詞、短詞策略與精確料號對照。在同一 fixture manifest 評估 Recall@5、延遲、無證據拒答與語意支持。
- **淘汰方案** 首版預設 vector store 及外部 embedding。
- **後果** 只有在固定 gold set 指標達不到或能驗證顯著改善時，另案評估向量、維運成本與 egress 授權。 [SQLite FTS5](https://www.sqlite.org/fts5.html)

## ADR-012　公開 repo、授權與保密

- **狀態** `Accepted`（額外授權及 OEP 授權選擇見 D01）
- **情境** AEP 公開且固定快照未見根目錄通用 LICENSE，vendor 有個別授權。OpenCode 固定版採 MIT。
- **決策** AEP 保持唯讀。OEP 使用獨立撰寫的程式與自建合成 fixtures。公開 repo、CI、PR 和發布物禁止公司程式、資料、設定、端點與秘密。重用由權利人逐項書面核准，仍遵守公司素材禁止進公開 OEP 的限制。列清冊、來源、授權及 NOTICE，在 CI 掃描 secret 與敏感資料，出貨備 SBOM。
- **淘汰方案** 以 GitHub 公開可見或授權缺失當作移植許可。
- **後果** Phase 0 S7 檢查所有可分發項目，授權缺口留作排除或擋發布。 [AEP metadata](https://api.github.com/repos/dragon0816/agentic-engineering-platform) · [OpenCode MIT](https://github.com/anomalyco/opencode/blob/v2.3.2/LICENSE) · [GitHub 授權說明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

## ADR-013　Secrets 管理

- **狀態** `Accepted`
- **情境** launcher 管 OpenCode，bot 與模型提供方各有獨立憑證。
- **決策** 本機用 Windows Credential Manager 或使用者範圍 DPAPI 保護的儲存，僅服務在執行時取用。測試憑證依核准範圍透過程序環境注入。以最小權限及有效期發行，支援旋轉與撤銷。範例只含 placeholder，log、artifact 與備份排除密鑰。
- **淘汰方案** plaintext repo 設定、在 CLI argv／網頁送密碼、在 CI 使用高權限服務憑證。
- **後果** 啟動驗必需變數是否存在，故障輸出只含 redacted 原因，restore 後安全地重新綁定憑證。

## ADR-014　可觀測性及 SSE

- **狀態** `Accepted`
- **情境** OpenCode SSE 跨 location，斷線無重播且可能 overflow。
- **決策** OEP 先授權過濾 SSE，再映射受控事件。重連時重新訂閱、緩衝可比對事件，重讀 session、messages、inbox、permission 和 OEP artifact/job ledger，再合併及去重。以 durable API/ledger 為完成狀態依據。結構化 log 串聯 run、OpenCode session、job、update 的本機識別值，記錄 reject、reconnect、attempt、延遲、結果與原因，避免記 prompt、內容、憑證和未遮罩路徑。
- **淘汰方案** 以 SSE 齊全或最後一個 event 作成功真相，或將全域事件直接轉給瀏覽器。
- **後果** 允許瞬時事件漏過，驗收須證明狀態收斂、重複動作為零與隔離。 [OpenCode event 契約](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/event.ts)

## ADR-015　測試策略

- **狀態** `Accepted`（資料與門檻例外見 D03、D08）
- **情境** 文件、來源實作、合成測試與真實服務的證據強度不同。
- **決策** 單元、合成 fixture、固定版契約、故障注入及 Windows VM E2E 分層。公開 Windows CI 使用合成資料和 stub，真 Gateway、Telegram、授權的真資料 smoke 由有權限的私有環境執行並輸出無敏感內容的摘要。每 Phase 需留命令、輸入版本、門檻及實際結果。
- **淘汰方案** 只做手動 demo、以 mock 取代真實相容性 gate、照搬公司 benchmark。
- **後果** 重現用環境版本及 fixture manifest 有固定 id，預先建立知識品質基線，階段交付依測試和獨立 reviewer 過關。

## ADR-016　產物成功判定

- **狀態** `Accepted`（合成 workbook oracle 見 D08）
- **情境** prompt 接單、tool 訊息或腳本自然語言可能在 XLSX 缺失或背景執行時已宣稱成功。
- **決策** 成功須有同一 run 的完成／退出收據、新產物 manifest、hash 與驗證紀錄。P1 連續 5/5，openpyxl 逐格核對合成 workbook，故障注入的假成功數為 0。
- **淘汰方案** 採信 assistant 文字、exit code 或檔案存在任一單項。
- **後果** 背景完成、斷線與重啟先進入各自狀態並對帳。若日後允許公式，由獨立重算器或明確 cache oracle 驗證值。BI 發布以資料交易及核准紀錄判定。

## ADR-017　Windows 執行與漏跑

- **狀態** `Proposed-needs-owner`（D06）
- **情境** 常駐單人 launcher 要面對瀏覽器關閉、鎖屏、睡眠、登出及斷電。
- **決策** 每登入使用者一個 supervisor，瀏覽器關閉後常駐，launcher 停止或登出後暫停。支援登入後選擇自啟。由 Job Object 控制自身程序樹，驗證抗 crash。恢復時按 UTC 加 IANA timezone 對帳，一次性工作於 24 小時內補一次，週期工作只補最新有效 slot，過期記狀態並允許 Run Now。
- **暫不採用方案** 機器層 service／Task Scheduler 跨登出，或自動追補所有歷史 slot。
- **後果** 睡眠及登出期間不提供即時執行，工作狀態透明，使用者可重跑。Windows VM 必須實測，RPO/RTO 建議為 24 小時／30 分鐘。 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
