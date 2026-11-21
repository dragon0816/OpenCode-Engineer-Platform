
# Phase 5B 乾淨 Windows 驗證

狀態 **UNVERIFIED**。開發機無可用 VM 或 Windows Sandbox。

1. 在乾淨的 Windows 11 x64 VM 使用一般使用者帳號。準備官方先決條件，核對發行 ZIP 的 SHA-256。 [操作文件](../OPERATIONS.md)
2. 先用 -WhatIf 執行安裝，再正式安裝。核對開始功能表、選用桌面捷徑及登入排程。從開始功能表啟動，建立合成資料。從網頁停止服務。
3. 執行 Backup-OEP.ps1 並記錄耗時。核對清單含檔案雜湊、資料筆數、發布雜湊與憑證名稱。記錄合成資料的內容及狀態。
4. 將備份回復到獨立空目錄並記錄耗時。核對「回復比對通過」，用回復資料啟動 OEP，檢查合成工作階段和 Ask 引用。確認修改過的備份檔會遭拒絕。
5. 解除安裝時核對資料仍存在、捷徑及排程已移除。留存 Windows 版本、指令結果、測試時間和遇到的錯誤。

## Phase 5C 升級與回退

準備兩個經核准的連續版本，舊版已完成前述安裝驗收。以下以 1.1.0 和 1.2.0 為例。把兩版發行 ZIP 與各自的 `SHA256SUMS` 分開放在使用者文件目錄中的 `OEP-validation\v1` 與 `OEP-validation\v2`。由解壓的新版資料夾執行：

```powershell
$root = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OEP-validation'
$program = Join-Path $root 'program'
$data = Join-Path $root 'data'
$oldZip = Join-Path $root 'v1\OEP-1.1.0-windows-x64.zip'
pwsh -NoProfile -File .\scripts\windows\Install-OEP.ps1 -InstallRoot $program -DataRoot $data -Source $oldZip
$zip = Join-Path $root 'v2\OEP-1.2.0-windows-x64.zip'
pwsh -NoProfile -File .\scripts\windows\Upgrade-OEP.ps1 -InstallRoot $program -DataRoot $data -Source $zip -WhatIf
pwsh -NoProfile -File .\scripts\windows\Upgrade-OEP.ps1 -InstallRoot $program -DataRoot $data -Source $zip
Get-Content -LiteralPath (Join-Path $program 'upgrade.journal.json')
pwsh -NoProfile -File .\scripts\windows\Rollback-OEP.ps1 -InstallRoot $program -DataRoot $data -WhatIf
pwsh -NoProfile -File .\scripts\windows\Rollback-OEP.ps1 -InstallRoot $program -DataRoot $data
Get-Content -LiteralPath (Join-Path $program 'current.json')
```

安裝應顯示「OEP 安裝完成。」。正式升級前以舊版建立合成資料，記錄已發布修訂及引用，再從網頁停止舊版。預演顯示操作，`current.json` 及資料維持原狀。正式升級顯示「已升級至 1.2.0。資料比對通過。」且 journal 為 `committed`。回退顯示「已回退至 1.1.0。資料比對通過。」、原資料保存位置與工作比對報告；`current.json` 為 1.1.0。再執行回退應顯示「已完成回退，無需再回退。」。記錄兩次演練的時間、備份清單雜湊、資料庫前後版本與筆數、修訂雜湊、引用、待處理工作報告及重開後的 OpenCode 與 profile。手動中斷須另用拋棄式複本驗證。乾淨 VM 的結果仍為 **UNVERIFIED**。
