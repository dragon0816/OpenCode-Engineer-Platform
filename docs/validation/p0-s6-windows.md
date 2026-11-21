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

原始測試中，睡眠／喚醒、登出／再登入、登入自啟、鎖屏常駐和恢復時序均為 **UNVERIFIED**。`powercfg /a` 只證實測試主機的電源能力。當時規劃私有 VM 補證，現依 owner 修訂免測 O-3b。 [Owner 修訂](../IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)

部署成本觀察。Node 實測 `node.exe` 約 91.4 MB，Job Object bridge 由現有 PowerShell `Add-Type` 編譯。S3 目前使用 Python 3.12 和四個固定 wheel。第 2 輪修正前的三個 wheel 展開約 5.16 MB，四個 wheel 的展開容量尚未重測。部署另需負擔 worker、逾時與錯誤傳遞成本。主體維持 TypeScript/Node.js。
## 第 2 輪　合成 Job 與 O-3a 原生基本驗收

測試主機為 Windows 11 Pro build 26200，64 位元，Node 為 x64。`pwsh -NoProfile -File scripts/phase0/windows-job.ps1` 用 `STARTUPINFOEX` 的 Job list 將 worker 在建立時納入 Job。三案例均驗不同目錄的同 SID 啟動遭拒、核心回報的 Job membership、實際 listeners、退出碼與殘留。最終重測正常停止為 137 ms、強制停止 71 ms、readiness 前停止 70 ms，三者殘留均為 0。已就緒的兩案例各計 worker、grandchild 與兩個 console helper。Readiness 前案例刻意不 resume worker，當時 listener 為 0。

另執行 `node scripts/phase0/windows-native-probe.ts`，固定 Windows `.exe` SHA-256 通過，並在同 SID 的 Job supervisor 斷言 worker 與原生 OpenCode 皆為 Job 成員。獨立暫存 profile/data、啟用密碼、拒絕本機 redirect、只允許合成 loopback relay。`/api/info` 回 `2.3.2`，未認證 HTTP 401；合成 prompt 完成且 SSE 先發開始、再發完成。雙地址族列舉得到 IPv4 loopback 1、IPv6 0。關閉 `serve --stdio` 的 stdin 後，原生 child 與 supervisor 均 exit 0，4 個 Job 成員殘留 0。這是 owner 核准的本機基本測試，profile/data 隔離與 Job 程序樹管理不提供 OS 檔案系統沙箱。O-3b 為 **WAIVED by owner – not tested**。 [Owner 修訂](../IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)
