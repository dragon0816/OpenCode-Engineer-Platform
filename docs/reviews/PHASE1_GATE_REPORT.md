# Phase 1 Gate 報告

2026-11-21（Asia/Taipei） · `phase-1/runtime-poc` · 起點 `1c45494`

## 優先複核的 10 個檔案

| 順序 | 檔案 | 複核重點 |
|---:|---|---|
| 1 | [gateway.ts](../../apps/adapter/src/opencode/gateway.ts) | 真憑證邊界、固定路徑及模型、去敏、拒絕轉址與逾時 |
| 2 | [supervisor.ts](../../apps/launcher/src/supervisor.ts) | 三重 pin、隔離 profile、執行環境、readiness 及有限重啟 |
| 3 | [runtime-job.ps1](../../scripts/windows/runtime-job.ps1) | 同 SID 單實例、Job membership、停止及退出碼 |
| 4 | [client.ts](../../apps/adapter/src/opencode/client.ts) | Loopback、Windows TCP peer 核對及 Basic 認證 |
| 5 | [sessions.ts](../../apps/adapter/src/opencode/sessions.ts) | 每 session agent、模型、目錄、檔案權限及單次送件 |
| 6 | [reconcile.ts](../../apps/adapter/src/opencode/reconcile.ts) | durable 對帳、權限拒絕、SSE 篩選 |
| 7 | [excel.ts](../../apps/adapter/src/runs/excel.ts) | run 狀態、失敗收據、Gateway 失敗及 5/5 路徑 |
| 8 | [program-worker.ts](../../apps/adapter/src/runs/program-worker.ts) | 合成 JavaScript 執行、固定 workbook API 及輸出檔 |
| 9 | [receipt.ts](../../apps/adapter/src/runs/receipt.ts) | workspace 檔案檢查、程式雜湊、逾時及退出收據 |
| 10 | [artifacts.ts](../../apps/adapter/src/runs/artifacts.ts) | 收據綁定、檔案新鮮度、驗證後雜湊 |

## Gate 結果

本節保留 Gateway 離線時的首輪驗收。恢復後的實測接續記在文末。 [真模型重測](#gateway-恢復後的真模型重測)

**Phase 1 未通過。** 原生 Windows runtime、合成 pipeline 與故障注入已通過。本機到設定的 Gateway 可建立 TCP，但兩個核准 alias 的健康檢查皆未收到 HTTP 回應。真模型 Excel campaign 在工作送出前退出，真模型 Excel 回合數為 **0**。Phase 0 由 owner 豁免結案，原 v2 與修訂後 gate 均未通過。Phase 2 尚未開始。 [決策紀錄](../DECISIONS.md)

| 驗收項 | 結果 | 命令與精簡輸出 |
|---|---|---|
| Windows 11 x64、Node 24、binary／client／OpenAPI pin | **PASS** | `pwsh -NoProfile -File scripts/phase0/fetch-pins.ps1` exit 0。Windows exe `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3`，OpenAPI `bc152825b9b65224bfc56bddefcdd8f44b50e7f1d1541f741ae017aa791478ba`，client 2.3.2 integrity 相符。 |
| Job 程序監督、隔離 profile、認證與正常停止 | **PASS** | `npm run test:contract:native` exit 0，`native=2.3.2 auth=401`。IPv4 loopback 1、IPv6 0。Job 起始成員 4，正常停止 child／supervisor exit 0，所查殘留 0。 |
| 兩個並行 session、不同 agent、權限及資料隔離 | **PASS** | 同一原生測試，`maxConcurrent=2 sessionCount=2 externalReadDenied=2 inspectorWriteDenied=true distinctAgents=true`。各自讀取 marker，唯讀 session 無輸出，另一 session 的送件 ID 無對應訊息。 |
| 送件對帳、工具結果與事件重連 | **PASS** | `npm run test:contract` 和原生測試 exit 0。遺失送件回應時只查 durable 狀態。合成供應方驗 6 個工具回傳與 call ID，收到開始事件後切斷再訂閱，432 ms 內核對每 session 一則送件，重複 0。 |
| Relay 合成契約 | **PASS** | `npm run test:contract` 6/6。未核准路徑／模型／憑證不轉送，拒轉址，400／401／403／429／500／503 均失敗，測試憑證回顯去敏。 |
| 真 Gateway 啟動健康檢查 | **FAIL** | `npm run test:e2e:excel` 真模式 exit 1。兩核准 alias 均未收到上游 HTTP status。見下方全部嘗試。 |
| 同 scope 的真工具、媒體及故障契約 | **UNVERIFIED** | 原生合成工具、Markdown 和 PDF 路徑已跑通。真健康檢查受阻，未取得真工具／媒體矩陣。 |
| D08 13 格精確驗證與連續真模型 5/5 | **FAIL** | 真模式進入 Excel 產物流程 0 次，無真產物可開啟。合成供應方 5/5 單列於下。 |
| 合成 SOP／PDF→程式→XLSX、收據、帳本與 oracle | **PASS** | `npm run test:e2e:excel:synthetic` exit 0，`attempts=5 longestConsecutive=5 synthetic=true`。每次新 workspace、程式 exit 0、13 格與核定 oracle 精確相等。核定 fixture 測試另為 2/2。 |
| 故障注入的假成功 | **PASS** | `npm run test:e2e:excel:faults` exit 0，`faults=9 falsePositives=0`，另有 1 個有效控制組。背景及斷線為帳本情境注入，期限前分別停在 `background`／`indeterminate`，缺收據判失敗。 |
| Evidence mock | **PASS** | `npm run test:contract` 內 3 案例涵蓋有效、缺證據、錯引用。驗證 passage hash、locator、來源及原文。 |
| Windows VM 出口及旁路負例 | **UNVERIFIED** | 本機無可用目標 VM 或 `Get-VM`。已驗應用層 relay 的路徑／模型／轉址行為。Host relay 的 VM 專用介面、固定 IP／port 與預設拒絕規則待部署、測通及測旁路。 [v2 出口門檻](../IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance) |
| 本機品質與憑證檢查 | **PASS** | `npm run lint` 檢查 69 檔，`npm run typecheck`、`npm run build` exit 0，`npm test` 31/31。安裝 worktree hooks 並於每次提交前 `npm run scan`，命中 0。 `npm audit --omit=dev` 顯示 0。 |
| 獨立 gate 複核 | **UNVERIFIED** | 交由 Claude Code 安排一次輕量複核。 |

## 全部真 Gateway 嘗試

以下目錄皆相對於 `%LOCALAPPDATA%\OEP\`。原始紀錄留於本機，內容只記狀態、時間、合成識別值及收據。Excel 尚未送件的 campaign 無 `attempts.jsonl`。

| 命令與資料目錄 | 結果與原始紀錄 |
|---|---|
| `npm run test:e2e:excel` · `phase1-4ItGM4` | exit 1，開發中版本字串解析未處理 `opencode v2.3.2` 前綴。已修正。健康回合 0、上游請求 0。留有 `startup-failed` 與 `runs.sqlite`。 |
| `npm run test:e2e:excel` · `phase1-c7mOTi` | `gpt-5.4-mini` 健康回合 `ses_e04464d89ffe4kiPgFUlnwAMMW` 失敗，105541 ms。Relay 前兩個請求於 45003／45011 ms 回本機 502，第三個請求在 9536 ms 被取消。三個 `upstreamStatus` 均為 null。命令 exit 1。保留 `gateway.jsonl`、`health.jsonl`、`lifecycle.jsonl`、`runs.sqlite`。 |
| Node `net.createConnection`／`fetch`、PowerShell `Invoke-WebRequest` · `phase1-HQ8lp6/gateway-diagnostics.jsonl` | IPv4 解析與 TCP 連線成功。Node 向聊天路徑各送一次合成短句，兩 alias 分別逾時 25009／25007 ms。PowerShell liveness 與一次合成聊天請求分別逾時 8115／8018 ms。沒有 HTTP 回應或已確認的服務端根因。去敏原始輸出的轉錄 SHA-256 為 `d69dbf4ccba4ec3c2481e709cb4516505b7969a56ea8bd47f4e86a9fdd6dce97`。 |
| `$env:OEP_MODEL_ALIAS='claude-haiku-4-5-20251001'; npm run test:e2e:excel` · `phase1-HQ8lp6` | 健康回合 `ses_e0441496dffe30gkaWdVQ3Zlax` 失敗，45538 ms。首請求 35005 ms 逾時，本機 502。第二請求 7825 ms 取消，本機 499。兩個 `upstreamStatus` 均為 null。命令 exit 1。保留 `gateway.jsonl`、`health.jsonl`、`lifecycle.jsonl`、`runs.sqlite`。 |

兩次啟動健康回合的 OpenCode 與 supervisor 最終皆 exit 0，Job 快照中 4 個成員殘留 0。OEP 重送 0，表中多筆上游請求來自 OpenCode 內部重試。

## 合成紀錄與產物

最終重測的所有 5 筆依執行順序列於下。根目錄為 `%LOCALAPPDATA%\OEP\phase1-OpTNDI\`，每個所列 workspace 都有 `program.js` 與 `output.xlsx`。五份程式 SHA-256 均為 `863bdab79e592b12dc4e79ca02ddf100f83f3c3070fa9016669f338986c8c754`。全部程式 exit 0，OEP 重送 0。另以 `Get-FileHash` 與 `python tests/oracles/verify_xlsx.py` 重開 5 份工作簿，全部雜湊相符且各 13 格通過。原始 `attempts.jsonl` SHA-256 為 `f172692ed6ae87ec75c943f2687bc0141334339393c13a1053e3c3fa9bf642a7`。SQLite 帳本為 `runs.sqlite`。

| 格式／workspace | Run ID | Session ID | `output.xlsx` SHA-256 |
|---|---|---|---|
| Markdown · `work-FGsI2J` | `8fc94106-c28d-40ef-ab56-73036a7bc317` | `ses_e043fd807ffedmr1z3x7RuPrbB` | `6696307c897103d139ca17b471a5f23481758605c5f3ad3b1d63204e11161aa2` |
| PDF · `work-oKMumS` | `3e6622ca-c224-4315-8be1-5b64218e4dd1` | `ses_e043fd502ffe35mer7TmPxasFr` | `9bb702f2bde67d9dc1bd816aa7b099a8844f8148405d09082837f6555a65552e` |
| Markdown · `work-A4v797` | `741085f6-166b-4198-9e52-f21ef754d63b` | `ses_e043fd1f3ffeJJh4FJ89TRSjWL` | `9bb702f2bde67d9dc1bd816aa7b099a8844f8148405d09082837f6555a65552e` |
| PDF · `work-cc5Yci` | `16539cb1-b405-4a2a-918d-7ac166336a74` | `ses_e043fced9ffekLfXFQFM9S4kSq` | `9bb702f2bde67d9dc1bd816aa7b099a8844f8148405d09082837f6555a65552e` |
| Markdown · `work-LZHGMh` | `1109fc0a-b1d7-4195-9e01-ad2127aa92bc` | `ses_e043fcbcfffe5pvBfinADDemRs` | `0696d4981088066324b458590352ddb212d3bab6d13178f5d85df6683405046d` |

早一輪合成 Excel 的完整 5 筆在 `phase1-XccvjD/attempts.jsonl`。原生合約兩輪都通過，紀錄在 `phase1-J56x1v/` 與 `phase1-e3aHU4/`。故障驗收三輪各保留控制組和全部 9 筆負例，原始紀錄分別為 `phase1-qiiwiz/attempts.jsonl`、`phase1-jzFv1a/attempts.jsonl`、`phase1-jxA8dk/attempts.jsonl`。

最終故障結果依序為非零退出與語法錯程式（exit 1）、exit 0 無檔、空檔、舊檔、錯工作表、錯值（均 exit 0）、背景未完成、斷線待對帳（均無收據）。九項全部 `failed`。控制組 `verified` 且逐格比對 13/13。 [重現步驟](../validation/p1-runtime.md)

## 偏差、新風險與待辦

- 目標 Windows VM 的出口證據與真 Gateway 的回覆均缺。實體 Windows 上的 agent 權限與 Job Object 僅用於上述本機證據。Phase 1 應用層 relay 只在本機 loopback 提供服務。
- Gateway 的明文 HTTP 傳輸為 owner 已接受的測試取捨。Gateway 管理員待排查本機 TCP 成功而 HTTP 不回覆，後續可提供 HTTPS。O-1 的 key scope／retention 與 O-2 的認證狀態異常持續追蹤。 [決策紀錄](../DECISIONS.md)
- 合成程式執行器的能力限固定 workbook API。測試涵蓋 agent 讀寫權限與有限子程序，任意不受信任程式或不同 OS 使用者的隔離仍無驗收證據。
- Phase 0 舊 probe 保留原狀。產品測試補了特定重連與工具回傳案例。跨其他客戶端／路徑的重複送件、真 upstream overflow、舊 teardown、S6 null 退出碼注入及三項 Minor 保持 **UNVERIFIED**。Owner 已免除本輪額外舊 probe 補強。 [任務清單](../TASKS.md)
- Gateway 服務恢復後重跑真工具／媒體與連續 5/5，保留失敗、重試以及通過紀錄。目標 VM 部署與出口負例、一次獨立複核仍待完成。 [交接](../HANDOFF.md)

## 提交與差異

| Commit | 內容 |
|---|---|
| `9f01cdf` | Record the Phase Zero waiver and authorize Phase One |
| `fa01d76` | Launch and isolate the pinned OpenCode runtime |
| `27ac1ae` | Verify generated workbooks against the D08 oracle |
| `94af8bb` | Validate citations against pinned synthetic evidence |
| 本報告所在提交 | Record the Phase One gate and remaining blockers |

`git diff --stat 1c45494..94af8bb` 為 37 檔、`+1587`／`-14`。完整交付含本報告為 39 檔、`+1723`／`-18`，可用 `git diff --stat 1c45494..HEAD` 核對。所有提交均在本機實作分支，hooks 已啟用。

## Gateway 恢復後的真模型重測

2026-11-21（Asia/Taipei）。Owner 通知服務恢復。Claude 從本機回報 liveness HTTP 200 約 145 ms、模型清單 11 個 alias、GPT 的短聊天成功，以及 Haiku 的 20-token 短提示收到 HTTP 200 空訊息。本次使用固定版 OpenCode 和本機 OEP relay，以合成 nonce 分別檢查准入。完整 HTTP 200 空回覆在 audit 中記為 `output=empty`，與串流逾時分開。單元測試確認空回覆仍為 HTTP 200，且保留可用 token 用量。

全程使用核定的 D08 SOP、PDF 與 13 格 oracle。每個跑次使用新工作目錄和 session，普通跑次交替輸入 Markdown 和 PDF。驗收以程式執行收據、工作簿 SHA-256 及 openpyxl 的工作表、格型別和值為準。故障注入使用真模型先生成的程式，保留原程式雜湊後才注入。LAN 明文 HTTP 的取捨仍適用。 [決策紀錄](../DECISIONS.md)

### 本輪判定

| 項目 | 結果 | 證據 |
|---|---|---|
| 真 Gateway 啟動和兩個核准 alias | **PASS** | GPT 首輪與補跑的 nonce 分別用時 8037、2683 ms，Haiku 用時 4571 ms。健康檢查皆一次通過，HTTP 200 且內容符合。 |
| 真模型 SOP→程式→XLSX | **PASS** | GPT 補跑與 Haiku 各自一輪連續 5 筆。19 份成功的工作簿另以 `Get-FileHash` 及 `python tests/oracles/verify_xlsx.py` 重開與比對，各驗 13 格。 |
| OpenCode 真實工具呼叫與 PDF | **PASS** | 兩個 alias 合計 8 筆成功 PDF。用例在相同回合處理 PDF、工具寫程式並通過 D08。 |
| 真模式故障注入 | **PASS** | Haiku 先生成程式，控制組逐格通過，7 個負例全部判失敗，假成功 0。 |
| 真 Gateway 的獨立圖片、完整錯誤契約 | **UNVERIFIED** | 保留先前合成契約與本輪實際逾時紀錄。 |
| 目標 Windows VM 出口、旁路與獨立 gate 複核 | **UNVERIFIED** | 實測仍在實體 Windows。本輪達成真模型工作流程門檻，完整 Phase 1 gate 保留未結項。 |

### 真模型普通跑次

以下依各次指令的實際順序列出所有跑次。表內雜湊為 SHA-256 前 12 位。完整 run／session／submission ID、雜湊、stdout／stderr、錯誤、逐筆請求的延遲及 token 保存在 `%LOCALAPPDATA%\OEP\` 的各目錄。沒有 usage 的請求不列入 token 合計。普通跑次均未由 OEP 重送相同 prompt ID。

#### GPT 首輪 · `phase1-TqPpKe`

`npm run test:e2e:excel` exit 1。共 9 筆，6 筆驗證成功，單輪最長連勝 4。9 筆原始 `attempts.jsonl` 的 SHA-256 為 `330d6ea53b934d319cd71dddec090da190222a35c8d6beadaeedd63bdf44bcd0`。

| 順序／短 Run ID | 輸入 | 結果 | Exit／格數 | 程式／XLSX SHA-256 | 耗時 ms／已知 tokens |
|---|---|---|---|---|---:|
| 1／`9d5451bf` | Markdown | `verified` | 0／13 | `409bc7ae6a3a`／`ab48a6fa1cb2` | 12643／4306 |
| 2／`f1e2e2c1` | PDF | `verified` | 0／13 | `409bc7ae6a3a`／`c1d0b15841ff` | 5118／2861 |
| 3／`8e2edd1a` | Markdown | `failed` | —／— | —／— | 105282／1117 |
| 4／`e100dc65` | PDF | `failed` | —／— | —／— | 105323／— |
| 5／`edfd278d` | Markdown | `failed` | —／— | `4f76023027a5`（未執行）／— | 92799／4302 |
| 6／`a49cc3d4` | PDF | `verified` | 0／13 | `409bc7ae6a3a`／`1a954b2a55d6` | 14216／2857 |
| 7／`ca35a8fc` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`fb6e5df65a47` | 8316／4309 |
| 8／`7471e596` | PDF | `verified` | 0／13 | `409bc7ae6a3a`／`2271595956c4` | 6021／2857 |
| 9／`37799a8b` | Markdown | `verified` | 0／13 | `21435f579af4`／`5c8644318842` | 8419／4302 |

第 3 筆的上游 HTTP 200 串流兩度在 35 秒期限內沒有完整結束，第 4 筆的兩個逾時請求連上游 HTTP 狀態也未取得。兩筆 OpenCode 回合均到達約 105 秒期限，取消當時未完成的請求。第 5 筆有兩個逾時請求，隨後同回合重試成功寫出程式。驗收保留為失敗且未執行。該原程式的路徑與完整雜湊另在 `attempt-artifacts.jsonl`。同期診斷的 liveness HTTP 200 用時 5699 ms，直連 Haiku 的一次 64-token 上限短聊天在 15006 ms 逾時，保存在 `gateway-diagnostics.jsonl`。

#### GPT 補跑 · `phase1-ptZggk`

`npm run test:e2e:excel` exit 0。共 9 筆，8 筆驗證成功，第 5 至 9 筆同輪連續通過。第 4 筆取得兩次缺上游 HTTP 狀態的逾時，並在回合期限取消未完成的請求。9 筆原始 `attempts.jsonl` 的 SHA-256 為 `e39242c1b03164c51af306b40b289b7c76769f0a1132ab59c828d8dc30f62479`。

| 順序／短 Run ID | 輸入 | 結果 | Exit／格數 | 程式／XLSX SHA-256 | 耗時 ms／已知 tokens |
|---|---|---|---|---|---:|
| 1／`13c19cc6` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`e13bf2bf9532` | 15175／4303 |
| 2／`414d4fbd` | PDF | `verified` | 0／13 | `409bc7ae6a3a`／`87ea313ac4c2` | 4282／2865 |
| 3／`1543ae0b` | Markdown | `verified` | 0／13 | `409bc7ae6a3a`／`a8ecac99e7fc` | 6039／4315 |
| 4／`ab1fd0e7` | PDF | `failed` | —／— | —／— | 105277／— |
| 5／`e322b3a3` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`b472bff7e8e5` | 9103／4309 |
| 6／`bef7c698` | PDF | `verified` | 0／13 | `409bc7ae6a3a`／`78626179b8df` | 38224／2861 |
| 7／`39ad9963` | Markdown | `verified` | 0／13 | `21435f579af4`／`c7274ae9ca39` | 17932／4296 |
| 8／`abe3b624` | PDF | `verified` | 0／13 | `21435f579af4`／`f4e392edf38b` | 6572／2847 |
| 9／`e5c5af45` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`188d66579511` | 11592／4309 |

GPT 兩輪共 18 筆，14 筆成功與 4 筆失敗。依同 alias 的普通跑次順序，首輪尾端 4 筆和補跑開頭 3 筆形成最長連續 7 筆。單輪的 5 筆門檻由補跑第 5 至 9 筆獨立滿足。

#### Haiku · `phase1-DA1Wx4`

`npm run test:e2e:excel` exit 0。5 筆皆成功並連續通過。啟動檢查一次通過，nonce 符合，上游 HTTP 200，該請求耗時 3747 ms，總用量 698 tokens。這輪未重現 Claude 所報的 HTTP 200 空訊息。5 筆原始 `attempts.jsonl` 的 SHA-256 為 `1760cba2de127b0c47c1b2be9a07b8720e7892574695de2ddee39dc009dc405a`。

| 順序／短 Run ID | 輸入 | 結果 | Exit／格數 | 程式／XLSX SHA-256 | 耗時 ms／已知 tokens |
|---|---|---|---|---|---:|
| 1／`7627f21e` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`8bf06cf03005` | 22293／4986 |
| 2／`e49a9476` | PDF | `verified` | 0／13 | `64c56eb29eed`／`bde81a155f6d` | 17252／3551 |
| 3／`77b80fb1` | Markdown | `verified` | 0／13 | `1c8b269a77d6`／`15098151b6fe` | 10434／4885 |
| 4／`b8ea3fd9` | PDF | `verified` | 0／13 | `64c56eb29eed`／`2cabe35ff93e` | 7559／3367 |
| 5／`f24a9163` | Markdown | `verified` | 0／13 | `64c56eb29eed`／`d34130e15bd9` | 9950／4851 |

GPT 與 Haiku 合計完成 23 筆普通跑次，19 筆驗證成功，4 筆失敗。成功 PDF 有 8 筆。各筆都有真 Gateway 回傳的工具呼叫，OpenCode 寫出程式，執行後逐格驗證；PDF 跑次的 session 沒有 Markdown SOP 檔案。獨立圖片附件仍為 **UNVERIFIED**。

### 真模式故障驗收 · `phase1-UW6XYZ`

以 `OEP_MODEL_ALIAS=claude-haiku-4-5-20251001` 執行一次 `npm run test:e2e:excel -- --real-faults`。啟動 nonce 一次通過，耗時 3165 ms。8 個 session 都先完成真模型程式生成，控制組執行原程式並通過 13 格。7 個注入案例皆判 `failed`，假成功 0，命令 exit 0。原始 `attempts.jsonl` 的 SHA-256 為 `06166ec60fd93e0d12c3add2f31f38e470dc97833b026e2a745d4d0bdc4785d9`。

| 案例／短 Run ID | 結果 | Exit | 原始程式／執行程式／XLSX SHA-256 | 耗時 ms／已知 tokens |
|---|---|---:|---|---:|
| `valid-control`／`a2ae5405` | `verified` | 0 | `64c56eb29eed`／`64c56eb29eed`／`4628b75aa6ce` | 10788／4909 |
| `nonzero-exit`／`24894c70` | `failed` | 1 | `64c56eb29eed`／`9969beb05ac0`／— | 8284／4855 |
| `wrong-program`／`4ab4dc5f` | `failed` | 1 | `64c56eb29eed`／`90cdcfe37b79`／— | 22547／5041 |
| `no-file-exit-zero`／`bde63ebe` | `failed` | 0 | `172ff1e46fae`／`0a9ed18377b2`／— | 7208／4845 |
| `empty-file`／`fdeb8065` | `failed` | 0 | `031a9bad5ff1`／`e3b0c44298fc`／`e3b0c44298fc` | 7076／4775 |
| `old-file`／`7acad212` | `failed` | 0 | `64c56eb29eed`／`e3b0c44298fc`／`d4816db2ceaf` | 9365／4781 |
| `wrong-sheet`／`e2e38f4d` | `failed` | 0 | `b0e63570655b`／`832fb46a28b9`／`bc7559edcfde` | 7825／4841 |
| `wrong-value`／`0fe0e206` | `failed` | 0 | `031a9bad5ff1`／`57bf2c7d9598`／`9024651226d1` | 8086／4840 |

非零退出與語法錯誤沒有有效收據。Exit 0 但無檔、空檔、舊檔都被擋下。錯工作表與 `Run.B2` 錯值均由 openpyxl oracle 拒絕。另核對了八筆所有可用檔案的雜湊，並重開控制組工作簿。背景與斷線的帳本情境仍在本機注入組驗證，`npm run test:e2e:excel:faults` 的 9 個負例全部失敗，假成功 0，紀錄在 `phase1-omsA2d/attempts.jsonl`。

本輪共 31 筆真模型工作流程跑次，包含 23 筆普通跑次與上述 8 筆故障驗收跑次。另有四次正式啟動 nonce，分別保存在每輪的 `health.jsonl`。各輪的 `gateway.jsonl` 保留全部請求狀態與可用用量，`lifecycle.jsonl` 均記錄 supervisor／child exit 0、殘留 0。

`npm run lint`、`npm run typecheck`、`npm test`（32/32）、`npm run build`、`npm run scan` 及 `git diff --check` 均通過。從 `f79dddf` 起 D08 fixtures 無差異。實作提交 `0ddf191`，本節與任務清單、交接一併提交。
