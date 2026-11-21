# Phase 2 Windows 工作台

## 啟動與使用

部署者先準備 Windows 11 x64、Node.js 24 x64、Python 3.12、PowerShell 7、Git 與預設瀏覽器。以核准的方式套用 Windows 使用者範圍的 `OEP_LITELLM_BASE_URL` 和 `OEP_LITELLM_API_KEY`。程序環境中的值會優先使用。預設 alias 為 `gpt-5.4-mini`，可設定 `OEP_MODEL_ALIAS` 為另一核准 alias `claude-haiku-4-5-20251001`。請由部署者將工作區交給使用者，或在桌面建立 VBS 的捷徑。

1. 雙擊 `scripts/windows/Start-OEP.vbs`。首次啟動可透過網路安裝鎖定的 npm 依賴及下載 Windows 執行檔與 OpenAPI，檔案存於工作區。OpenCode 的執行檔、client、OpenAPI 與本機認證就緒後，預設瀏覽器會打開同源工作台。 [Windows 啟動器](../../scripts/windows/Start-OEP.vbs)
2. 選擇助理並新增會話。用「選擇檔案」或將檔案拖到附件區。上傳成功的檔案會先勾選，可取消勾選，或從同會話選取先前的附件。輸入問題並送出。
3. 若要產生 XLSX，選「Excel 工作表」助理並勾選「產生 Excel」。完成後從「產物」下載。工作簿支援固定值，最多四張工作表、每張 20 列與 12 欄。
4. 關閉瀏覽器會保留服務與會話；再雙擊啟動器會重新開頁。用右上角的「停止服務」停止本機服務與受管程序。

單檔上限 20 MiB。支援 PNG、JPG、PDF、XLSX 及 UTF-8 的 TXT、MD、CSV。每個會話的附件原檔及 CSV 投影合計上限 200 MiB。XLSX 的上限為 10 張工作表，每張 500 列與 50 欄，壓縮檔展開量合計 100 MiB，轉換逾時 10 秒。CSV 保留工作表名稱、列號與儲存格值，格式化日期保留底層儲存的數值，公式標成 `[formula omitted]`。PDF 交給核准模型讀取；掃描件的讀取能力依模型與 Gateway 而定。

每則訊息最多 10 個附件，原始媒體合計上限 40 MiB，文字與 CSV 合計上限 1 MiB。實際模型的上下文及 Gateway 限制仍可能低於這些本機上限。Gateway 逾時、空回覆或產物無法驗證時，「對話」顯示該次狀態與原因。若出現未確定狀態，等服務完成對帳後可重新送出新的請求。

## 資料位置與回復

預設 Web 資料目錄是 `%LOCALAPPDATA%\OEP\web`。OpenCode profile 在 `profile`，會話的 200 MiB 上傳工作區在 `sessions`，模型工作目錄在 `model-work`，驗證產物在 `artifacts`。`web.sqlite` 保存附件與 run 台帳，`launch-*` 留存去敏執行、模型請求及 turn 狀態。關閉服務後可備份上述資料。如有 SQLite v1 的 Web ledger，遷移前產生 `web.sqlite.before-v2-*` 一致快照。Phase 1 原執行入口及資料路徑可獨立使用。回退前保留 Web 台帳、profile 及不可變產物。

## 重現驗收

在原始碼根目錄由驗收人員執行。安裝依賴後，Chromium 測試預設使用已安裝的 Edge 或 Chrome；自訂瀏覽器路徑可只在驗收程序提供 `OEP_TEST_BROWSER`。

```powershell
npm ci --cache .phase0/npm-cache
pwsh -NoProfile -File scripts/phase0/fetch-pins.ps1 -WindowsOnly
npm run lint
npm run typecheck
npm test
npm run build
npm run scan
npm run test:contract
npm run test:e2e:web
npm run test:e2e:windows
npm run test:e2e:browser:real
```

`test:e2e:windows` 包含 WSH 腳本啟動、單實例、正常／強制停止、兩會話三次 SSE 斷線對帳，以及 Chromium 上傳與下載。WSH 測試捕捉瀏覽器交接，不開啟驗收者原本的瀏覽器設定檔。Chromium 測試使用另外建立的 profile，實際操作 DOM 及下載。真模式只送合成 fixtures。原始紀錄與去敏畫面留在命令開頭輸出的 OEP 資料目錄。 [Phase 2 驗收報告](../reviews/PHASE2_GATE_REPORT.md)
