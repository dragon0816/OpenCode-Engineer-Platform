# Phase 0 獨立補審（Codex `gpt-6.2-astra`，非開發者、非 Claude；2026-11-21）

審查版本 `aed57e3`。**唯讀**；未使用真 Gateway、金鑰、Podman、原生 Windows OpenCode。全文由審查者回覆，此檔為忠實摘要（Claude Code 存檔）。

## 結論
- **Phase 0 gate：FAIL**（O-1..O-4 仍為 owner/基礎設施阻擋）。
- **本機合併 `phase-0/spikes` → `main`：FAIL**。先修 relay 憑證保護與回合綁定，並讓 S1/S2/S4/S5 的失敗確實阻擋驗收；再複核 Windows 建立程序空窗與附件解析依賴。
- Critical：未確認。

## Important（路徑相對 `scripts/phase0/`）
| ID | 位置 | 失敗情境 | 建議 |
|---|---|---|---|
| R-1 | `model-probe.ts:72,79,97,111,117` | Gateway URL 接受 HTTP → Bearer 明文；redaction 只比對單一 SSE `data` 行的一種 JSON 拼法，跨事件文字、URL 編碼、等價 JSON 跳脫、非預設 port 時單獨出現的 hostname 可能進入 OpenCode 歷史/tool trace | 真實憑證限 HTTPS；解析後依欄位重組、限量並遮罩再交付；用合成標記驗證最終 transcript/trace/錯誤輸出 |
| R-2 | `model-probe.ts:130,155,161,204` | relay 不驗呼叫者；同 loopback 程序可耗額度；`forcedSteps` 為整個 relay 共用，同模型遲到請求可占用下一回合；非物件 `tool_choice` 不經步序檢查 | 每呼叫者/每回合獨立識別，綁定預期模型、工具結果與兩次請求，拒絕額外步驟與逾時回合 |
| R-3 | `opencode-probe.ts:144,169,282,315,322,383` | admission/interrupt/automation/Host/Origin/CSRF/未認證回應/密碼可見性多半只列印；兩個模型都不健康時 20 回合測試**跳過並正常退出**；一般工具回合在整段 transcript 找到 token 即通過 | 預期值改為會失敗的斷言；兩個指定 alias 各 10 回合，核對末則回答與工具名稱；缺測/狀態錯誤/安全條件失敗皆非零 |
| R-4 | `opencode-probe.ts:177,196,223,241` | `owned` 只有 A，通過篩選後才檢查 `owner !== a.id` → **`foreignExposed` 必為 0（虛斷言）**；重連多次讀取沒有共用 5 秒期限；`duplicateSubmissions` 未觀察實際送件次數 | 接收端記錄實際可見事件；送件端按操作 ID 計數；整次收斂共用同一截止時間 |
| R-5 | `opencode-probe.ts:23,70,86,188,245,278` | 探測空埠後釋放再啟動 OpenCode（TOCTOU）→ readiness 可能把 Basic 密碼送錯服務；`fetch` 允許 redirect；socket 檢查只看 `/proc/net/tcp` 第一筆同埠 listener，排除不了額外 IPv6 listener | 送憑證前確認 listener 屬預期子程序；本機請求拒絕 redirect；列舉該程序全部 IPv4/IPv6 listeners 並斷言 |
| R-6 | `windows-job.cs:84,88`、`windows-job.ps1:35,45` | assign-then-resume 與 `KILL_ON_JOB_CLOSE` 正確；但 supervisor 死於 `CreateProcess` 成功至 assign 之間時，suspended worker 可能殘留；強停測試等到 `ready.json` 才開始 | 以 `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` 建立時即入 Job；驗證 readiness 前的中止路徑 |
| R-7 | `requirements.txt:3`、`attachment_probe.py:105` | `pypdf==6.1.1` 落在上游已公告的 page-tree 記憶體耗盡範圍（GHSA-cggf-277g-3q54）；`len(reader.pages)` 先解析頁樹，五頁上限保護不到 | 升級到已修補版並過相容測試、鎖 wheel hashes、解析置於有記憶體/時間上限的子程序 |
| R-8 | `attachment_probe.py:32,44,57`、`attachment-probe.ts:22` | ZIP 有項目數與宣告解壓量上限且不解壓到磁碟，但 XML 宣告檢查只套特定副檔名；列寬在 openpyxl 建整列後才驗；Windows 端 `lstat`/`realpath` 與轉換器之間有 TOCTOU | 依實際 OOXML relationship 驗所有會解析的部件；禁 DTD/entity 的 parser 與資源配額；自受控 staging 目錄開檔一次，同一 handle 驗證並讀取 |
| R-9 | `secret-scan.mjs:10,15,26`、`.githooks/pre-commit:2`、`docs/validation/p0-s7-licensing.md:5` | 裸 RFC1918 邊界測試有效，但編碼/拆段文字、IPv6 ULA、裸內部 hostname 仍可能漏報；**兩個 checkout 均未設定 `core.hooksPath`，有效 hook 路徑沒有 pre-commit → 本機 commit 不會觸發掃描** | 補支援的編碼與位址類型之正反例；提供可驗證的 hook 安裝步驟；合併前 tree scan 列為明確檢查 |

## Minor
- `attachment_probe.py:85,128`：`sheets` 印 `len(ORACLE)`，加第三張空白 sheet 仍報 2 → 比對實際 sheet 名稱與數量。
- `windows-job.ps1:8,27,38,48`：`mutex=23` 僅證明同 SID 同 `$Instance`；各自 GUID 的啟動可並行；`orphan=0` 只涵蓋兩個已持有 handle 的程序；`loopbackOnly` 未列入失敗條件。
- `model-probe.ts:167,173,175`：非串流上游 HTTP 200 但 JSON 無效時 `trace.status ||= 504` 保留 200 → 解析失敗回 502，分開記錄上游與 relay 狀態。
- `p0-provenance.md:14`、`package-lock.json:50,60`：`effect` 並非 optional peer（protocol 與 schema 直接依賴）→ 更正文件。

## 獨立驗證（通過）
- S1 pins 全數相符：官方 immutable tag → `c0ad18b4…`；Windows ZIP/exe `8ad59f19…`/`5d52d86e…`；Linux tar.gz/binary `563b5d66…`/`e6543f6e…`；LF OpenAPI `bc152825…`；npm tarball SHA-512 = registry `dist.integrity` = pin。`fetch-pins.ps1` 錯誤 ZIP → exit 1 且未解壓（fail closed）。
- 重現：lint 23 檔、scan 56 檔/0 命中（無 gateway 環境值）、typecheck、build、5 項測試；fixture 15 格/2 sheets、CSV `26364dac…`、`PRINT-2746`、`OCR_REQUIRED`、Recall@5 24/24、9,600 次查詢、6 個建置 JS。
- Windows x64 struct 大小 64/144/104/24 bytes；合成 worker + grandchild 正常/強制停止後 0 殘留（134/59 ms），`EADDRINUSE` 與 mutex exit 23。
- **未驗證**：真 Gateway/key、Podman、原生 Windows OpenCode、睡眠/登出恢復、遠端 CI、D08 oracle；S2 真實成功率與 S4 毫秒數未獨立重現。
- 審查者保留外部暫存副本（OS temp `oep-review-*`），因政策拒絕遞迴清理。

## Claude Code 補註
- 先前 Claude 的 re-review 接受 I-1 時主要依開發者證據；本審查證明部分 PASS 的斷言本身無法失敗（R-3、R-4）。**gate 報告中 S2 的 20 回合、S4 的隔離/重複送件、S5 的 Host/Origin/CSRF 的 PASS 應降為「probe 有執行，但斷言不嚴格 → UNVERIFIED」，直到 R-3/R-4 修正並重跑。**
