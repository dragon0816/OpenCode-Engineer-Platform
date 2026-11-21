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
