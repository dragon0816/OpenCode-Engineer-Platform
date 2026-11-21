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

## 2026-11-21　修正第 1 輪（fix round 1）

Claude Code 首輪限定範圍審查已記錄於 `11a18ee`。審查重跑 lint、typecheck、test、scan，並檢查歷史與 `.phase0/` 的憑證外洩，均與其報告相符。本輪只處理 I-1 至 I-3，開發者重測完成，修正待獨立複核。上文保留初版 gate 的結果及時點。 [Claude Code 審查](PHASE0_CLAUDE_REVIEW.md)

| 項目 | 本輪驗收 | 證據 |
|---|---|---|
| I-1　完整 forced turn | PASS | `pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode gateway-capabilities` exit 0。`gpt-5.4-mini` 6,124 ms，`claude-haiku-4-5-20251001` 3,961 ms，均少於 35 秒。各首步 forced、回傳相符工具結果、最終文字相符、工具執行 1 次、重複 0。其他 10 項 capability 均 HTTP 200、`succeeded`。原 FAIL 保留。本輪初次試跑也曾因局部變數遮蔽在送出模型 completion 前失敗，修正型別錯誤後重跑通過。 [S2 完整輸出](../validation/p0-s2-gateway.md) |
| I-2　裸私網 IPv4 掃描 | PASS | `npm test` 驗證 `10/8`、`172.16/12`、`192.168/16` 的正反例，含有無 port、CIDR 邊界與無效 octet。清除程序內的 Gateway 變數後，`npm run scan` 仍正常執行。 |
| I-3　出口邊界與驗收 | PASS（文件） | 明記 `--network bridge` 只用於 Phase 0，Phase 1 的 relay-only 設計涵蓋 OpenCode 與子程序隔離、relay 個別出站規則、正向串接、直連與旁路拒絕。Phase 1 實作及驗收尚未開始。 [S5](../validation/p0-s5-security.md) · [v2 出口修訂](../IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance) |

| 命令 | 本輪實際輸出 |
|---|---|
| `npm run lint` | `Checked 23 source and configuration files.`，exit 0 |
| `npm run typecheck` | `tsc --noEmit`，exit 0 |
| `npm test` | 5 passed、0 failed、0 skipped |
| `npm run build` | `tsc --outDir .phase0/build`，exit 0、6 支 JS |
| `npm run scan`（清除 Gateway 程序環境值） | `mode:tree, files:56, hits:0`，exit 0 |

**Gate 仍未通過，Phase 1 未開始。** O-1 受限 key scope、egress／retention，O-2 認證回應 500／400 的根因，O-3 隔離 Windows 11 x64 VM 的原生 OpenCode、睡眠與登出，O-4 D08 合成 SOP/PDF 與 cell oracle 核定均待 owner／基礎設施。此次診斷再次量到 `liveness:200, modelsValid:200, modelsNone:500, modelsWrong:400`，其餘首輪未完成的驗收仍列於上文。

## 2026-11-21　修正第 2 輪（fix round 2）

從獨立審查提交 `bc61330` 起算。原 v2 要求 O-1 至 O-4 全部結清，原版 gate 從未通過。Owner 核准的新門檻要求 R-1 至 R-9 及四項 Minor 修正與適用負例、獨立複核無未結 Critical／Important，以及 O-3a 本機基本測試通過。開發者修正與 O-3a 已驗，**仍待獨立複核，尚未達 conditionally passed**。Phase 1 未開始，未合併、push 或開 PR。 [獨立審查](PHASE0_INDEPENDENT_REVIEW.md) · [Owner 核准修訂](../IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)

### 歷史驗收狀態更正

| 舊證據 | 修正狀態 | 本輪證據 |
|---|---|---|
| S2 真 Gateway 20 回合 PASS | **UNVERIFIED**。先前 probe 的 alias 缺測與末則回答斷言不足。 | 合成 OpenCode `contract-relay` 在新斷言 20/20，真 Gateway 未取得本輪可重測的 HTTPS 入口。 |
| S4 隔離、重複送件 PASS | 舊證據 **UNVERIFIED**。過濾後的舊計數無法測到外洩，舊計數也未觀察實際送件。 | 新 `contract` 記錄接收端可見事件、送件端依 operation ID 計數和同一個 5 秒期限。 |
| S5 Host、Origin、CSRF PASS；S1 部分印表驗收 | 舊證據 **UNVERIFIED**。錯誤觀察值未必導致非零退出。 | 新 `contract` 將 S1 與 S5 條件納入退出門檻，負例可觸發失敗。 |

### 審查修正

| 項目 | 修正及本機證據 |
|---|---|
| R-1 | 真憑證限 HTTPS。解析後依欄位重組、限制 upstream 大小並遮蔽 JSON／URL 編碼、分段值與不帶 port 的 hostname。合成 transcript、tool trace 及錯誤回應測試通過。 |
| R-2 | relay 驗證每次啟動的 caller token 與限時 turn nonce、預期 alias、`tool_choice` 與 forced 兩步的結果 ID。負例拒絕無授權、錯 alias、非允許文字 choice、錯結果 ID、額外及遲到步驟。 |
| R-3 | S1／S5、能力與 fault probe 改為非零退出條件；S2 必須兩 alias 各 10 次成功，核對工具名及最後文字。負例涵蓋不健康 alias、缺次數、錯工具、錯答案、認證與 proxy 觀察值。 |
| R-4 | 預先分配六個 operation IDs，送件端計數、接收端驗 payload，重連及查詢共用一個 5 秒期限。外來事件、重複發送及超時反例均會失敗。 |
| R-5 | Linux 以子程序 socket inodes 核對 TCP IPv4／IPv6，Windows native 依 Job child PID 核對。送認證前驗 listener 所有權，本機拒絕 redirect。額外 IPv6、錯埠、錯 owner、redirect 負例通過。 |
| R-6 | `STARTUPINFOEX`／Job list 在建立時即入 Job。原生 Windows 合成 worker 尚未 resume 即中止，證實 readiness 無、listener 0、殘留 0。 |
| R-7 | `pypdf 6.21.4` 對應上游修補版本，四個 wheels 有 SHA-256。PDF worker 套 256 MiB、2 秒 CPU、5 秒外層 timeout，正常及超頁負例已重測。 [上游公告](https://github.com/advisories/GHSA-cggf-277g-3q54) |
| R-8 | OOXML 依 relationships 驗可達部件，禁 DTD/entity、外部 relationship 並預查座標；從同一已驗原生 handle 讀取。負例涵蓋非標準副檔名的 DTD、外部目標、過寬列、hardlink 及逸出。 |
| R-9 | 增加 URL、JSON、Base64、字串相接、IPv6 ULA、裸內部 hostname 偵測及反例。`core.hooksPath=.githooks` 已在此 worktree 安裝。真 staged canary 回 `hits:1`、commit exit 1、HEAD 不變；已移除 stage 和檔案。合併前掃描來源、目標及工作樹。 |
| Minor 1 | 開啟實際 XLSX 驗 `量測`、`Notes`，15 格，額外空白 sheet 負例失敗。 |
| Minor 2 | 不同工作目錄共用 SID mutex，同 SID 第二 instance exit 23；驗 Job 核心成員、listener 和退出碼。 |
| Minor 3 | 非串流 HTTP 200 無效 JSON 轉 relay 502，上游／relay 狀態分列，錯誤不回傳合成敏感標記。 |
| Minor 4 | `effect` 修正為 `@opencode/protocol`、`@opencode/schema` 的直接依賴，以 repository lockfile 核對。 [清冊](../validation/p0-provenance.md) |

### 重跑輸出與 owner 狀態

| 命令或案例 | 結果 |
|---|---|
| `npm run lint`、`npm run typecheck` | 38 檔，兩項 exit 0 |
| `npm test`、`npm run build`、`npm run scan` | 15 pass／0 fail／0 skip，編譯 11 個 JS，78 檔掃描 0 命中，均 exit 0 |
| `python scripts/phase0/attachment_probe_test.py -v`、`python scripts/phase0/attachment_probe.py` | 5 個測試通過；兩張實際工作表共 15 格，文字 PDF／OCR fallback 通過，CSV SHA-256 `26364dac52fafe7eb797453c92354b66bff6fbbb695667fffc4c9bdbc412a971` |
| `python scripts/phase0/d08_oracle_test.py -v` | 2 個測試通過。實際 PDF 抽取與 Markdown、JSON、XLSX 一致；一字節雜湊漂移、PDF 單值偏離、SOP 工作表名偏離均被拒。 [D08 核定及 SHA-256](../validation/d08-oracle.md) |
| `run-container.ps1 -Mode contract` | exit 0；S1 client／Automation 斷言通過，S4 三次收斂 30／26／27 ms，外洩 0、重複 0、追蹤 operations 6。S5 IPv4 1／IPv6 0，401／200、Host／Origin／CSRF 403，密碼未外洩。 |
| `run-container.ps1 -Mode contract-relay` | exit 0，`--network none`。兩合成 alias 各 10 次，分段 20、並行 10，兩 forced turn 完成，OpenCode transcript 有去敏。 |
| `run-container.ps1 -Mode gateway`、`-Mode gateway-capabilities` | 均 exit 1，`gateway requires HTTPS`，setup 擋下，未送出請求或憑證。真 Gateway 重測 **UNVERIFIED**。 |
| `pwsh -NoProfile -File scripts/phase0/windows-job.ps1` | exit 0，正常／強制／readiness 前中止 137／71／70 ms，所有殘留均 0。 |
| `node scripts/phase0/windows-native-probe.ts` | exit 0，Windows 11 Pro x64 build 26200。固定 exe、認證 `/api/info` 回 2.3.2、無認證 401、mock prompt 和開始／完成 SSE 成功、IPv4 loopback 1、IPv6 0、Job 4 成員、child/supervisor exit 0、殘留 0。 **O-3a PASS**。 |

O-1／O-2 仍為 Gateway 管理員的 **TRACKED KNOWN RISKS**。O-3b 為 **WAIVED by owner – not tested**，無 GPT dots、VM 或 Hyper-V 工作；D06 的真實 OS 行為與 RPO/RTO 為 **UNVERIFIED**，Phase 4 保留啟動／恢復對帳與模擬測試。O-4 已核定為最小管線 smoke oracle，並通過一致性與雜湊條件。 [決策紀錄](../DECISIONS.md) · [handoff](../HANDOFF.md)

## 2026-11-21　修正第 3 輪（fix round 3）

以獨立複核提交 `7467fdf` 為基線。前輪結果保留；該複核以故障注入證實 R-2、R-3、R-4、R-5、R-8 與 R-9 的第 2 輪驗收不足。以下為第 3 輪修正與開發者證據。**Gate 尚未達 `conditionally passed`**，待 Claude 安排下一次獨立複核。O-3a 重測通過，O-3b 免測、D08 核定及 O-1／O-2 known risks 維持。未使用真 Gateway，未修改或合併真正 `main`，Phase 1 未開始。 [第 2 輪獨立複核](PHASE0_INDEPENDENT_REREVIEW_R2.md)

### 負例與故障注入

分別在暫存副本注入故障。每列的 `exit 1` 為被測命令的實際退出碼；未受修改的測試均通過。

| 項目 | 修正及故障結果 |
|---|---|
| R-2 | forced 結果只接受完全相等的文字，或單一且僅含 `type: text` 和精確 `text` 的項目。改回 substring 後，包含正確 token 的錯誤結果使 relay 負例 exit 1。 |
| R-3 | deadline 與由 transport 明確回報的錯誤分開，未知例外向上傳遞。於 300 ms S2 案例注入無關 `TypeError`，確認 `probe-failed` 在 `failures` 步驟標記 `typeError:true` 且 exit 1。 |
| R-4　重複送件 | 在實際 HTTP transport 寫出前按 session 路徑和 operation ID 計數。於同一 `submit` 注入 B 的第二次提交，OpenCode 回兩筆 admission，S4 依 `sender` 斷言 exit 1。 |
| R-4　重連期限 | `server.connected` 前的 EOF 或 abort 會拒絕 `ready`，同一 5 秒期限也限制串流收尾。注入重連 EOF 即刻（0 ms）拒絕；注入忽略 signal 的停滯連線於 5,000 ms 拒絕，兩者 exit 1。 |
| R-5 | HTTP headers 只寫到核對過的同一條 established socket。Linux 以 server-side inode 對應 OpenCode PID，Windows 以反向 TCP tuple 對應 Job child PID。TCP 四元組負例、被拒 peer 零 HTTP、拒絕 redirect 均測，略過 peer 核對的副本 exit 1。 [S5](../validation/p0-s5-security.md) |
| R-8 | 拒絕結構外的 row/cell、非 `c` 的 row child 與不符列號／順序的座標，以預檢核定欄寬送入 openpyxl 配置。繞過預檢後測試觀察到進入 openpyxl，exit 1。 |
| R-9 | 解碼 UTF-16/UTF-32、BOM 與 ASCII 相容舊編碼。拋棄式 clone 的 UTF-16 canary 在來源 tree 以及實際 staged commit 均被攔截；乾淨 merge 後核對 clone `main` hooks 並清理 canary。分別停用檔案解碼、來源掃描及目標 hooks 安裝，三次均 exit 1。 [合併入口](../validation/p0-s7-licensing.md) |
| Minors | 乾淨環境 staging 測試先建 `.phase0`；授權清冊為 4 個鎖定 wheels；Windows PDF 2 秒為週期檢查的 user-time 配額。分別取消建目錄、還原舊 wheel 數、改回硬性 CPU 上限敘述，三次均 exit 1。 |

### 重跑輸出

| 命令或案例 | 結果 |
|---|---|
| `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run scan` | 均 exit 0。Lint 40 檔，Node 21 pass／0 fail／0 skip，編譯 12 個 JS，81 檔掃描命中 0。 |
| `npm run merge-check -- main` | exit 0。來源／目標 commit tree 分別 15、81 檔，工作樹 81 檔，index 無變更，均 0 命中。此命令只預檢。 |
| `python scripts/phase0/attachment_probe_test.py -v`、`python scripts/phase0/d08_oracle_test.py -v` | 分別 6 與 2 項通過；附件正例仍為兩張表、15 格及相同 CSV SHA-256，D08 核定雜湊不變。 |
| `run-container.ps1 -Mode contract` | exit 0。300 ms fault 輸出 `deadline`；S4 收斂 253／252／143 ms，送件 6、重複 0、外洩 0；S5 IPv4／IPv6 為 1／0，拒絕 Host／Origin／CSRF 403。 |
| `run-container.ps1 -Mode contract-relay` | exit 0。在無網路容器中兩合成 alias 各 10 次，兩 forced turn 完成且僅一次工具呼叫，去敏通過。 |
| `pwsh -NoProfile -File scripts/phase0/windows-job.ps1` | exit 0。正常／強制／readiness 前停止 140／68／72 ms，各 0 殘留。 |
| `node scripts/phase0/windows-native-probe.ts` | exit 0。OpenCode 2.3.2 的認證、mock prompt、SSE、已連線 PID 核對與停止通過，IPv4／IPv6 listener 1／0，Job 4 成員殘留 0。 |
