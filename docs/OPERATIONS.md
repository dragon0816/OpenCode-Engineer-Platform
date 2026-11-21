# Windows 發行包

這是開發中的 Windows 11 x64 單使用者發行包。ZIP 未簽署，Windows SmartScreen 可能顯示警告。請先從交付者取得可信的 SHA-256，再比對 `SHA256SUMS` 與下載的檔案。發行包內的清單記錄各檔案的大小和 SHA-256，清單本身由 ZIP 的 SHA-256 涵蓋。

## 準備環境

使用官方的 Windows x64 Node.js 24、Python 3.12 和 PowerShell 7。Node.js 和 PowerShell 7 可解壓官方 ZIP 到自己的目錄並加入使用者 PATH。Python 可選擇僅為目前使用者安裝。

在下載目錄執行下列命令。路徑含空格時請保留引號。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\OEP-0.0.0-windows-x64.zip
```

比對完成後解壓，再從解壓後的目錄準備 Excel 所需的 Python 套件。

```powershell
python -m venv "$env:LOCALAPPDATA\Programs\OEP-Python"
& "$env:LOCALAPPDATA\Programs\OEP-Python\Scripts\python.exe" -m pip install --require-hashes -r tests/oracles/requirements.txt
$env:OEP_PYTHON = "$env:LOCALAPPDATA\Programs\OEP-Python\Scripts\python.exe"
& .\scripts\windows\Start-OEP.ps1
```

O-3b **WAIVED by owner – not tested**。在使用者於實際環境驗證前，OEP 對跨 Windows 睡眠或登出的排程正確性無保證。D06 的登入常駐、登出暫停、睡眠恢復對帳、24 小時補跑、RPO ≤24 小時與 RTO ≤30 分鐘均為 **UNVERIFIED**。


## 安裝與開啟

1. 使用官方 Node.js 24 x64、Python 3.12 x64、PowerShell 7。Python 可執行 winget install --id Python.Python.3.12 --exact，PowerShell 可執行 winget install --id Microsoft.PowerShell --exact。新開 PowerShell 7 視窗以讀取 PATH 的更新。 [Node.js 24](https://nodejs.org/dist/latest-v24.x/) [Python 3.12](https://www.python.org/downloads/windows/) [PowerShell 7](https://github.com/PowerShell/PowerShell/releases)
2. 核對 ZIP 的 SHA-256，將 ZIP 與 SHA256SUMS 放在同一資料夾。核對成功後，在檔案總管開啟 ZIP 的「內容」。若有「解除封鎖」選項，勾選並套用，再解壓一份以取得指令和 Python 套件清單。依前一節準備套件。如果使用虛擬環境，請將 OEP_PYTHON 存到 Windows 的使用者環境變數中，讓開始功能表也能找到同一個 Python。
3. 在解壓後的目錄執行以下命令。可加上 -DesktopShortcut 建立桌面捷徑，加上 -AutoStart 在登入時執行使用者排程。從開始功能表選擇 OEP。

~~~powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\scripts\windows\Install-OEP.ps1 -Source 'C:\下載\OEP-0.0.0-windows-x64.zip'
~~~

程式位於 %LOCALAPPDATA%\Programs\OEP\<版本>。current.json 記錄啟用版本、安裝時間和清單雜湊。安裝紀錄放在程式目錄，讓資料目錄保有原樣。也可傳入已解壓的發行資料夾。須指定 -AllowDowngrade 才能安裝較低版本。

## 停止與解除安裝

先在 OEP 網頁停止服務。關閉瀏覽器分頁後，服務仍可能執行。若顯示「偵測到正在執行的 OEP 或 OpenCode。請先停止服務。」請到正在執行的 OEP 停止它，再重試。

從解壓後的發行資料夾執行 Uninstall-OEP.ps1。-Version 移除單一版本，-All 移除全部版本。移除啟用版本時一併移除捷徑和排程。預設保留資料。請先備份。確定永久刪除資料才傳入 -RemoveData -ConfirmRemoveData "DELETE OEP DATA"。

## 備份、回復與憑證

- 先停止 OEP，維護完成後再啟動。Backup-OEP.ps1 預設在「文件」中的 OEP-Backups 建立備份資料夾。可用 -Destination 指定完整路徑。-KeepLast 14 保留最近 14 份由本工具建立且通過清單驗證的備份。
- 建議每天在使用者仍登入且 OEP 已關閉時備份。從安裝版本的 scripts\windows 內執行 Register-BackupTask.ps1 -At '20:00' 可登記每日排程。OEP 還在執行時，備份會拒絕開始。可在工作排程器檢查結果，並確認最新備份資料夾已建立。
- 執行 Restore-OEP.ps1 -Backup '備份資料夾完整路徑'。若顯示「資料目錄已有檔案」，請改用空目錄，或在確認要取代時加上 -Force -ConfirmReplaceData "REPLACE OEP DATA"。強制回復先在旁邊的 oep-safety-backups 目錄留一份備份，並保留重新命名的原資料目錄。
- 顯示「回復比對通過」後，按畫面名稱重新設定 Windows 的使用者環境變數。執行 Check-OEP-Credentials.ps1 查看各名稱的設定狀態，再開啟 OEP。備份流程沒有讀取使用者環境變數的值。請把備份放在只有自己有權讀取的位置。
- 如果回復中斷，保持 OEP 關閉，檢查資料目錄旁的 oep-restore-original 和 oep-restore-staging 目錄。若原資料目錄消失，將 oep-restore-original 改回原本的名稱，再重新執行回復。遇到「檔案大小或 SHA-256 不符。」時請改用完整備份。

## 資料位置與預演

資料預設位於 %LOCALAPPDATA%\OEP，web 下包含知識庫、Web 設定、Telegram 資料庫及執行紀錄，web\profile 保存 OpenCode 設定與工作階段。SQLite 使用線上備份。知識資料庫內的 blob、審核來源與發布資料隨快照保存。備份略過執行暫存、SQLite 日誌檔、auth.json 和 maintenance.log。maintenance.log 只記操作種類、時間和成功狀態。

維護指令需 PowerShell 7。原 Start-OEP.vbs 和 Start-OEP.ps1 支援 Windows PowerShell 5.1。使用 -WhatIf 預演。ZIP 預演和正式安裝都核對 ZIP 雜湊、項目路徑及發行清單。用 -InstallRoot 和 -DataRoot 指定完整測試路徑，或用 OEP_DATA_DIR 指定資料目錄。當 OEP_MAINTENANCE_TEST 為 1，腳本會拒絕與預設安裝或資料目錄重疊的測試路徑，並略過真實捷徑及排程。

## 升級與回退

使用一般使用者權限開啟 PowerShell 7。在新版發行資料夾執行下列命令。ZIP 旁須放同一批次的 `SHA256SUMS`。也可將 `-Source` 指向已解壓的完整發行資料夾。若安裝時指定過 `-InstallRoot` 或 `-DataRoot`，兩個命令都使用原來的完整路徑。

```powershell
pwsh -NoProfile -File .\scripts\windows\Upgrade-OEP.ps1 -Source .\OEP-1.2.0-windows-x64.zip -WhatIf
pwsh -NoProfile -File .\scripts\windows\Upgrade-OEP.ps1 -Source .\OEP-1.2.0-windows-x64.zip
pwsh -NoProfile -File .\scripts\windows\Rollback-OEP.ps1 -WhatIf
pwsh -NoProfile -File .\scripts\windows\Rollback-OEP.ps1
```

請依實際版本調整 ZIP 檔名。預設需提供較新的版本。若需修復同一安裝版本，使用原版套件並加上 `-AllowSameVersion`。套件的發行清單雜湊必須和目前版本相同。預演驗證輸入及顯示操作目標。升級會檢查程式路徑，要求這一套的啟動器正常停止，並保留舊版資料夾。看見「偵測到其他 OpenCode。請先停止該服務。」時，請確認該服務可以停止，再從原本的介面停止。尚未支援升級停止要求的舊版，請先在網頁停止服務。

安裝根目錄中的 `upgrade.journal.json` 記錄前後版本、資料根目錄、`upgrade-backups` 內的備份位置與清單 SHA-256，以及每個 SQLite 的前後 `user_version` 和筆數。成功訊息為「已升級至 <版本>。資料比對通過。」。維護日誌位於安裝根目錄的 `maintenance.log`。

若操作中斷，使用原本的資料及安裝根路徑重跑同一升級命令，或執行回退。看到「OEP 升級或回退尚未完成。請先執行回退。」時，先完成回退。回退會驗證備份、回復資料及 profile、切回發行目錄及其 OpenCode，再顯示「已回退至 <版本>。資料比對通過。」。重複執行會顯示「已完成回退，無需再回退。」。若找不到升級紀錄，可指定 `-Backup <備份的完整路徑>`，其版本必須仍安裝在同一根目錄。

回退會留下完整的 `oep-restore-original-*` 資料目錄。安裝根目錄內的 `rollback-*.json` 按資料庫及表格列出新增或變更的待處理工作列雜湊。雜湊可用報告中的欄位順序與保留資料對應。回退恢復備份當時的收件、寄件、通知及 BI 工作狀態，請先以保留的原資料核對已發送及待確認工作，再決定是否重做。

新版可開啟並前向遷移舊資料。升級保留既有列、修訂雜湊與引用。內建歷史遷移可加入已知的空表或新增欄位，既有欄位內容必須相符。含版本防護的舊版開啟超出支援的資料庫版本時會顯示「資料庫版本比程式新。請使用新版程式或先回退資料。」。請使用回退命令成套回復程式及資料。發現「ZIP 的 SHA-256 與 SHA256SUMS 不符。」或「備份清單與升級紀錄不符。」時，請取得正確的發行檔案或原備份再重試。
