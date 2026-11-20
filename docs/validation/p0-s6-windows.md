# S6　Windows 生命週期與 Job Object

實測平台為 Windows 11 Pro x64 25H2 build 26200，Node.js 24.14.1 x64、Python 3.12.7 x64。主機為實體 Windows，未有可用的私有 Windows VM。OpenCode Windows x64 官方二進位已驗 hash，實際執行在 Linux 容器，未加入 Windows Job Object 實測。 [S1](p0-s1-version.md)

```powershell
pwsh -NoProfile -File scripts/phase0/windows-job.ps1
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object DisplayVersion,CurrentBuildNumber,EditionID
powercfg /a
```

```json
{"mode":"normal","managed":2,"orphan":0,"elapsedMs":138,"mutex":23,"conflict":"EADDRINUSE","loopbackOnly":true,"unicodeAndSpace":true}
{"mode":"forced","managed":2,"orphan":0,"elapsedMs":70,"mutex":23,"conflict":"EADDRINUSE","loopbackOnly":true,"unicodeAndSpace":true}
```

PowerShell 與小型 Win32 bridge 在 worker resume 前使用 `AssignProcessToJobObject`，最後一個 Job handle 關閉會停止整棵程序樹。核對已持有 handle 的 Node worker／grandchild。兩次各於 10 秒內剩餘 0，`Get-NetTCPConnection` 查得 loopback，第二個 supervisor 同一使用者／同一 mutex 拒絕，衝突保留原 listener 且回 `EADDRINUSE`。工作目錄含中文及空格。

睡眠／喚醒、登出／再登入、登入自啟、鎖屏常駐和恢復時序為 **UNVERIFIED**。`powercfg /a` 顯示可用 S0 與休眠，此證據只涵蓋主機電源能力。此共用 Windows 使用者工作階段保持登入，沒有觸發電源或登入狀態改變。私有 VM 重跑時需保存啟動、睡前、喚醒、登出、再登入的 OS 事件時間與兩種關閉後的程序樹數量。D06 的 24 小時補跑、RPO/RTO 等後續服務驗收依原 phase 保留。

部署成本觀察。Node 實測 `node.exe` 約 91.4 MB，Job Object bridge 由現有 PowerShell `Add-Type` 編譯。S3 Python 另需 Python 3.12 執行環境及三個 wheels，實際展開依賴約 5.16 MB，另有 worker 執行、timeout 與錯誤傳遞成本。主體維持 TypeScript/Node.js。
