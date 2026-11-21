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
