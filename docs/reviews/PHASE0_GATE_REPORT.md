# OEP Phase 0 gate 報告

2026-11-21（Asia/Taipei）。開發者 Codex，分支 `phase-0/spikes`，起點 `60bbe8816f7b3b121396e025adc8f4c9ded1aba3`。Owner 確認 v2 與 D01–D09。S1–S7 的 probes、去敏證據、repo hygiene 及合成基線已交付。**Gate 未通過，Phase 1 未開始**。Claude Code 可用，獨立審查待主線啟動，開發者驗證不得計為獨立審查。 [核准與追加決策](../DECISIONS.md) · [v2 修訂](../IMPLEMENTATION_PLAN_V2.md)

## 優先審查十個檔案

1. [`run-container.ps1`](../../scripts/phase0/run-container.ps1) 核對 User scope、stdin、binary SHA-256、唯讀映射及 port 設定。
2. [`model-probe.ts`](../../scripts/phase0/model-probe.ts) 核對固定 gateway 路由、alias／請求上限、redaction、SSE args／tool ID 驗證。
3. [`opencode-probe.ts`](../../scripts/phase0/opencode-probe.ts) 核對隔離 profile、上游認證、模型政策、allowlist、admission、斷線與 proxy 斷言。
4. [`probe-http.ts`](../../scripts/phase0/probe-http.ts) 核對 loopback listener、body 上限、流取消及錯誤回應。
5. [`windows-job.cs`](../../scripts/phase0/windows-job.cs) 核對原生結構、先 assign 後 resume 及 kill-on-close。
6. [`windows-job.ps1`](../../scripts/phase0/windows-job.ps1) 核對 per-user mutex、持有 process handle 及 orphan 實測。
7. [`attachment_probe.py`](../../scripts/phase0/attachment_probe.py) 核對 ZIP/XML 邊界、locator、逐格型別及掃描 PDF 行為。
8. [`attachment-probe.ts`](../../scripts/phase0/attachment-probe.ts) 核對 URI／Windows 路徑拒絕及 junction 測試邊界。
9. [`secret-scan.mjs`](../../scripts/phase0/secret-scan.mjs) 核對掃描範圍與去敏輸出。
10. [`opencode.pin.json`](../../config/opencode.pin.json) 核對官方來源、binary、client、OpenAPI hashes 及容器 digest。

## 驗收結果

原生環境是 Windows 11 Pro x64 25H2 build 26200、PowerShell 7.6.10、Node 24.14.1 x64、npm 11.11.0、Python 3.12.7 x64。只有隔離的 Podman 5.4.0 Linux x64 容器可啟動 OpenCode。Windows 資產僅下載與雜湊，原生 Windows 執行不得由容器證據代替。

| 驗收 | 狀態 | 命令、輸出與產物 |
|---|---|---|
| S1 標籤、ZIP／binary、client 與 LF OpenAPI | PASS | `pwsh -NoProfile -File scripts/phase0/fetch-pins.ps1` exit 0。ZIP `8ad59f19…`、exe `5d52d86e…`、OpenAPI `bc152825…`、client 2.3.2 integrity 相符。 [全值及重現命令](../validation/p0-s1-version.md) |
| S1 CLI、authenticated `/api/info` 及五類 client | PASS／UNVERIFIED | `run-container.ps1 -Mode contract` 顯示兩個版本皆 2.3.2，create、admit、active、interrupt、permission/list/reply 通過。Windows 原生執行 **UNVERIFIED**。 [S1](../validation/p0-s1-version.md) |
| S1 Automation off/on、漏跑、重啟 | PASS／UNVERIFIED | 容器 off 403。on 重啟後 `first:1, after:1, status:done, outcome:fired`。Windows 原生行為 **UNVERIFIED**，MVP off。 [S1](../validation/p0-s1-version.md) |
| S2 經 OpenCode openai-compatible 及 20 連續工具回合 | PASS | `run-container.ps1 -Mode gateway`，第二輪 `maxStreak:20, fragmented:20, parallel:10`。兩 alias 各 10，驗 JSON、ID、tool result、最後文字；首輪 19/20 保留。 [S2](../validation/p0-s2-gateway.md) |
| S2 alias 最小呼叫、listing 誤判 | PASS／FAIL | 六個 alias 健康 200。兩個 listing 存在的 alias 實際 400 `Model not found`，不得啟用。啟動健康設計已交付。 [S2](../validation/p0-s2-gateway.md) |
| S2 tool choice、parallel、結構化輸出、失敗工具 | PASS／FAIL | `run-container.ps1 -Mode gateway-capabilities`，雙 alias 的 `none`、schema、失敗工具、parallel 與首次 forced 通過。固定 model 設定會再次強制工具，probe 阻止重送。完整 forced turn **FAIL**。 [S2](../validation/p0-s2-gateway.md) |
| S2 兩 alias 各辨識 PNG／PDF | PASS | `gateway-capabilities`，兩者皆辨識兩個唯一值。 [S2](../validation/p0-s2-gateway.md) · [fixture hashes](../validation/p0-s3-attachments.md) |
| S2 401／403、429、5xx、長輸入、逾時及禁止 fallback | PASS／UNVERIFIED | `contract` 注入 401、403、400 各 1 次 `failed`；429、503 各 3 次後 8 秒停；慢速 endpoint 已請求，300 ms 到期；未見 relay fallback。真 Gateway 的長輸入錯誤、限流、5xx、timeout、服務端 fallback **UNVERIFIED**。 [S2](../validation/p0-s2-gateway.md) |
| S2 liveness、有效／無／錯誤 key 與認證語意 | PASS／FAIL | `gateway` 回 `liveness:200, modelsValid:200, modelsNone:500, modelsWrong:400`。認證異常重現，根因未證實。 [S2](../validation/p0-s2-gateway.md) |
| S2 受限 key、模型隔離、retention 與 egress | UNVERIFIED | Key 種類未知，無法證實為可撤銷受限 key 或非 master。未使用管理端點，待 owner／管理員提供證據。 [S2](../validation/p0-s2-gateway.md) |
| S3 PNG、PDF、掃描 PDF fallback；XLSX 兩 sheet、逐格／locator、各自 hash | PASS | `python scripts/phase0/attachment_probe.py`，`cells:15, sheets:2, pdf:PRINT-2746, scan:OCR_REQUIRED`，CSV `26364dac…`；PNG/PDF 模型側證據同 S2。 [S3](../validation/p0-s3-attachments.md) |
| S3 `file:`、`data:`、HTTP、大小、不支援檔案及 Windows 路徑 | PASS | `npm test`，20 MiB + 1 byte 拒絕，20 MiB 接受，NTFS 中文／空格與 junction 案例通過。 [S3](../validation/p0-s3-attachments.md) |
| S4 兩 session、三次斷線、離線完成、5 秒收斂、隔離、重複送件 | PASS／UNVERIFIED | `contract`，重連 16/8/7 ms，foreign dropped 3、foreign exposed 0、duplicate submissions 0。上游 buffer overflow 與原生 Windows 時序 **UNVERIFIED**。 [S4](../validation/p0-s4-sse.md) |
| S5 loopback、Windows `Get-NetTCPConnection` 和密碼 | PASS／UNVERIFIED | `contract` 容器 `/proc/net/tcp` 為 loopback，auth 401/200。Windows 指令查到合成 Node worker loopback。Windows OpenCode listener **UNVERIFIED**。 [S5](../validation/p0-s5-security.md) |
| S5 Host、Origin、CSRF、密碼暴露、上游 CORS | PASS | `contract`，錯誤 Host／Origin／CSRF 403，無 session 401，有效 proxy 200；OpenCode 允許 `localhost` 異 port，proxy 拒絕。回應與 headers 未暴露 upstream 密碼。 [S5](../validation/p0-s5-security.md) |
| S6 Windows x64 啟動、路徑、port 衝突、單實例、正常與強制停 | PASS／UNVERIFIED | `pwsh -NoProfile -File scripts/phase0/windows-job.ps1`，兩個受管程序，`EADDRINUSE`、mutex 23、中文／空格；正常 138 ms、強制 70 ms，orphan 均 0。Windows Job 內實際 OpenCode **UNVERIFIED**。 [S6](../validation/p0-s6-windows.md) |
| S6 私有 VM 睡眠／喚醒、登出／再登入、恢復、部署成本 | UNVERIFIED／PASS | `powercfg /a` 僅證實主機有 S0、休眠。沒有私有 Windows VM，未切換共享登入或電源。已量測 Node 約 91.4 MB，Python 三個 wheels 約 5.16 MB 加 runtime。 [S6](../validation/p0-s6-windows.md) |
| S7 100% 候選清冊、MIT、AEP 唯讀、未授權分發 0 | PASS | 8 npm、3 Python 等逐項有版本、來源、授權、處置。AEP 程式／資料排除。 [清冊](../validation/p0-provenance.md) |
| S7 secret scan、Git hook、CI 設定 | PASS／UNVERIFIED | `npm run scan` `hits:0`，已在每次後續 commit 啟用 staged hook，合成正反樣本通過。CI 已配置，遠端未執行。 [S7](../validation/p0-s7-licensing.md) |
| 48 題合成基線、比對、標註與延遲 | PASS | `node scripts/phase0/knowledge-baseline.ts`，24/20/2/2，Recall@5 24/24，9,600 量測 p50 0.0047 ms、p95 0.0113 ms。LF hash `e5466242…`。 [完整基線](../validation/p0-knowledge-baseline.md) |
| 七份報告及獨立 review | PASS／UNVERIFIED | S1–S7 文件齊全；Claude Code 獨立 review 尚未執行，本報告為交付審查的開發者證據。 |

## 專案驗證

| 命令 | 最終本機輸出 |
|---|---|
| `npm ci --ignore-scripts --registry https://registry.npmjs.org` | 8 套件安裝，9 套件 audit，0 vulnerabilities |
| `npm run lint` | `Checked 23 source and configuration files.`，exit 0 |
| `npm run typecheck` | `tsc --noEmit`，exit 0 |
| `npm test` | 4 passed、0 failed、0 skipped（包含原生 Windows junction） |
| `npm run build` | `tsc --outDir .phase0/build`，exit 0、6 JS 檔。首次 TS5011，補顯式 rootDir 後通過 |
| `node .phase0/build/knowledge-baseline.js` | exit 0，Recall@5 24/24，確認轉譯後入口 |
| `npm run scan`（含本機確切環境值比對） | `mode:tree, files:55, hits:0`；合成 canary 有命中，公開樣本文字無命中 |
| `git diff --check 60bbe88..HEAD` | 無 whitespace errors |

## 偏差、新風險與 owner 待辦

- Windows 原生執行缺所需隔離 VM。Linux 容器提供同 tag 契約補證，Windows Job 只用合成 Node 程序樹。Owner 需提供可隔離的 Windows 11 x64 VM，涵蓋 OpenCode CLI/API、listener、SSE、睡眠／喚醒及登出／再登入。另補上游 SSE overflow。 [v2 修訂](../IMPLEMENTATION_PLAN_V2.md)
- 現有 key 的 scope 未明，無憑證模型清單 500／錯誤 key 400。Owner 或管理員需證實 key 為短期、限 alias、限額且可撤銷，確認 egress／retention、fallback、認證錯誤與 500 根因，安排真故障矩陣的安全時段。OEP probe 沒有撤銷權限，測試 key 由發行人管理。
- alias 列名與可路由能力分離。永久 forced `tool_choice` 可形成重複工具與費用，須把強制選擇限於首步並補驗，逾時計入失敗。已提供啟動健康檢查設計。文件 converter 邊界以合成檔驗證，Phase 2 需驗原子檔案 handle 與不可信文件資源限制。
- 第一輪 SSE 與錯誤 Host probe 分別受事件物件形狀及 `fetch` 自動 Host 影響。修正讀 SSE 的 `data.sessionID` 與原生 HTTP Host 後重測通過。第一輪 Gateway 的 19/20 與受 cap 阻擋的能力結果按原樣保留。 [S2](../validation/p0-s2-gateway.md) · [S4](../validation/p0-s4-sse.md) · [S5](../validation/p0-s5-security.md)
- D08 的合成 SOP/PDF 與 cell oracle 待 owner／domain reviewer 核定，正式 E2E 屬 Phase 1。獨立審查與修復複驗仍是 gate 條件。CI 遠端未執行，沒有 push 或 PR。

## 本地 commits 與 diff

| Commit | 主旨 |
|---|---|
| `2a6851c` | Record Stage 4 approval and open Phase 0 |
| `9590b8c` | Add Phase 0 verification and secret scanning |
| `6282eb4` | Pin the OpenCode release and probe isolated contracts |
| `10bbe86` | Validate synthetic attachment conversion and boundaries |
| `7cfb451` | Probe Windows Job Object lifecycle |
| `a4cee97` | Lock the synthetic knowledge baseline and regression checks |
| `7ffffea` | Document Gateway spike results and alias preflight |
| `be83169` | Inventory Phase 0 provenance and license boundaries |
| `724825a` | Set the probe compiler source root |
| 交付 commit | Record the blocked Phase 0 gate and handoff |

`git diff --stat 60bbe88..HEAD` 涵蓋 45 檔、`+2082`／`-19`，含 4 個合成二進位 fixtures。報告以外為 44 檔、`+2000`／`-19`。用 `git log 60bbe88..HEAD` 查看交付 commit SHA。Repo Git 預設信箱有公司網域，本輪使用 Codex noreply 建立本地 commits，含指定 co-author trailer。確認 probe 容器均已停止並採 `--rm`。執行政策回 `blocked by policy`，拒絕遞迴清理已核對的 `.phase0/`，因此暫存的公開下載物與合成產物保留於 Git 忽略區，測試憑證僅用記憶體。
