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
