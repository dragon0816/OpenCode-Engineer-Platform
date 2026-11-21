# Phase 5 發行建置紀錄

基準為 `c287ce0`，工作分支為 `phase-5/release`，打包提交為 `14b85ce`。本機使用 Windows 11 Pro x64 25H2（26200）與 Node.js 24.14.1。

在工作樹執行以下命令。建置使用鎖定的 npm 正式相依套件，從 OpenCode 官方發布來源取得固定版本與規格。

```powershell
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run test
npm run scan
npm run test:ingest
npm run test:telegram
npm run test:knowledge
npm run test:release:determinism
npm run build:release
Get-Content dist/SHA256SUMS
```

重建測試在兩個獨立暫存輸出目錄建置，核對 ZIP、SHA256SUMS 和 ZIP 內的清單。在 Windows 上另解壓到暫存目錄，用只包含系統路徑與空白測試資料目錄的環境，核對 OpenCode 版本並載入 Web 啟動器與內建示範題集。這個測試只驗執行檔與模組載入。需另完成安裝版流程與乾淨 VM 驗收。

備份和回復時間 **UNVERIFIED**。本輪未量測 RPO 或 RTO。

重建測試通過 1 項，耗時約 88.8 秒。單元及契約測試通過 54 項，工作樹掃描 0 命中。工作樹的 ingest、Telegram 與 knowledge 測試分別通過 16、5、12 項。

| 產物 | SHA-256 |
|---|---|
| `OEP-0.0.0-windows-x64.zip` | `a14cc4e3ca6496a1509a09109fcfc636f189d002a1708ea44381c9049a8cafc5` |
| OpenCode 官方 ZIP | `8ad59f1992a0594d8bd72b5ed3be1f5bfffcd9d1756853eec7e5d3141c25be1f` |
| 包內 OpenCode 執行檔 | `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3` |

## 乾淨 VM 的發行包初驗

1. 在乾淨 Windows 11 x64 VM 或 Windows Sandbox 使用一般使用者權限。將 ZIP 與 SHA256SUMS 複製到下載目錄。按照操作文件準備 Node、Python 與 PowerShell。 [環境準備](../OPERATIONS.md)
2. 在下載目錄執行下列指令。應顯示 `opencode v2.3.2` 和 `Web 啟動器載入成功`。

```powershell
$zip = 'OEP-0.0.0-windows-x64.zip'
$expected = ((Get-Content -LiteralPath .\SHA256SUMS -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { throw '下載檔案的 SHA-256 不符。' }
$destination = Join-Path $env:TEMP ('OEP-驗證-' + [guid]::NewGuid())
Expand-Archive -LiteralPath $zip -DestinationPath $destination
Set-Location -LiteralPath $destination
$env:OEP_DATA_DIR = Join-Path $destination '測試資料'
New-Item -ItemType Directory -Path $env:OEP_DATA_DIR | Out-Null
& .\vendor\opencode\opencode.exe --version
node --disable-warning=ExperimentalWarning --input-type=module -e "await import('./apps/launcher/src/web.ts'); console.log('Web 啟動器載入成功')"
```

3. 留存 Windows 版本與位元、一般使用者權限、Node 版本、ZIP SHA-256、上述兩行輸出和任何錯誤。安裝版六類流程、重新啟動後的資料比對與升級回退需有各自的證據。

## Phase 5B 開發機測試

- Phase 5B 的 OEP-0.0.0-windows-x64.zip 雜湊為 1a3f6f04a7375bec9c757e980253e838742ff743b7aa261f0d1abb9f26f00298。
- 執行 npm run build:release 後，以 npm run test:install 驗 ZIP、檔案清單、竄改、額外路徑、路徑穿越、降版拒絕、重裝及解除安裝。
- npm run test:backup 測試含約 1,000 張已發布知識卡、5,000 個段落、10,000 筆合成佐證資料和 2,000 個關係，另有審核、工作階段、BI 工作、收發匣及執行紀錄。使用實際知識庫和 Ask 引用驗證器比對發布內容。SQLite WAL 寫入程序持續執行時可取得線上快照。
- 此份合成資料在開發機的一次測試耗時為備份 674 毫秒、回復 741 毫秒，包含 PowerShell 啟動與清單驗證。使用者環境的 RPO、RTO 為 **UNVERIFIED**。
- 本機回歸通過 lint、typecheck、單元及契約測試 54 項、秘密掃描 0 命中、ingest 16 項、knowledge 12 項、Telegram 5 項、Web、瀏覽器、合成 Excel、知識整合以及發行可重現建置。Recall@5 基線為 24/24。
- 初次執行既有 Web、瀏覽器和 Excel 回歸時漏設資料根目錄覆寫，這些回歸在預設 OEP 資料目錄下建立了新的合成測試資料夾。之後在獨立暫存資料目錄重跑。
- 一般使用者乾淨環境、開始功能表和排程操作 **UNVERIFIED**。 [乾淨 Windows 驗證](p5-clean-vm-runbook.md)

## Phase 5C 開發機測試

在 Windows x64 使用 Node.js 24、PowerShell 7 和包含 openpyxl／defusedxml 的 Python 3.12 環境。先執行 `npm run build:release`，再執行 `npm run test:upgrade`。測試預設使用 `dist/OEP-0.0.0-windows-x64.zip`。可設定 `OEP_TEST_RELEASE` 指向對應 ZIP。

測試把該 ZIP 作為 v1。v2 是測試組在獨立暫存目錄產生的 patch 版本。測試只改寫發行檔內的 KnowledgeStore，使它為 `publications` 增加一個有預設值的欄位並把 `user_version` 從 1 改為 2，再重新計算清單與 ZIP 雜湊。兩版用相同的固定 OpenCode 執行檔，測試檢查回退後選用舊版的執行檔路徑及雜湊。合成資料含 300 張新增知識卡、發布修訂、引用、審核、通知 intent、BI 工作、Web 工作階段、執行紀錄、Telegram 收發匣及 OpenCode profile 樣本。

測試中斷點在備份後、遷移與切換之間，以及回退移走原資料後。重新執行會回退並核對備份的逐檔 SHA-256。第一方 SQLite 版本防護逐庫驗證。安裝的舊版拒絕遷移後的知識庫。另以故意變更資料後回傳失敗的合成遷移驗證自動回退，並以同版套件驗證修復受損程式檔案。使用者環境的 RTO、RPO 和乾淨 VM 維持 **UNVERIFIED**。 [乾淨 Windows 驗證](p5-clean-vm-runbook.md)

| 開發機演練 | 升級 | 回退 |
|---|---:|---:|
| 第一次 | 31.794 秒 | 3.098 秒 |
| 第二次（重用已驗證的新版程式目錄） | 8.579 秒 | 3.186 秒 |

時間包含 PowerShell 啟動、清單核對與資料比對。上述兩輪來自同一次合成測試。Recall@5 基線在本機重跑為 24/24。

發行可重現性測試的兩份 ZIP 使用同一 SHA-256 `510e79a8f65ca34b9ce2626639603fe327e84c24ee16e869dd45e255af9e841f`，每個發行檔案通過清單核對。

## Phase 5D evidence

Build the standard ZIP with `npm run build:release` and the runtime-bundled ZIP with `npm run build:release -- --bundled`. Both ZIP hashes are recorded in `dist/SHA256SUMS` when built into the same directory. Run `npm run test:compliance` and `npm run test:release:determinism`. Repeat determinism with `OEP_TEST_BUNDLED=1` in the process environment to verify bundled runtime imports with a System32-only PATH. Point `OEP_TEST_RELEASE` at the bundled ZIP and set `OEP_TEST_BUNDLED=1` to exercise the bundled install and upgrade fixtures.

Keep the release ZIP and checksum file fixed throughout an upgrade test. Run `npm run test:release:bundled` with the same bundled test environment to exercise the installed launcher and synthetic workbook campaign. The test uses a temporary installation and data root and intercepts the browser handoff.

The hosted Windows runner may have Edge or Chrome at a standard installation path. CI tries the synthetic browser suite when it finds one, and the release checklist still requires the manual browser gate.

PowerShell 5.1 compatibility is deferred. The maintenance core uses `ConvertFrom-Json -AsHashtable`, `$IsWindows`, `Path.IsPathFullyQualified`, `Path.TrimEndingDirectorySeparator` and the overwrite overload of `File.Move`. PowerShell 7 is still needed for the Job supervisor. The bundled shortcut uses Windows Script Host to call the bundled Node executable in a hidden window.

Review the [license inventory](p5-license-review.md). The bundled Node distribution retains its aggregate LICENSE, including embedded dependency notices. The Python distribution retains LICENSE.txt. Owner review of their embedded terms is pending.
