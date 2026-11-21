# Phase 2b Slice 4C 驗收紀錄

## 已驗證

- **VERIFIED** 設定 API 使用本機配對、同源及 CSRF 檢查。支援新增、更新、啟用、停用、移除、儲存憑證及讀取狀態。Windows User-scope 環境變數保存憑證值。設定與備份僅保存參照。 [API](../../apps/adapter/src/main.ts) · [合約測試](../../tests/contract/custom-mcp.test.ts)
- **VERIFIED** 合成模型請求顯示允許專案的新會話可見啟用的工具。另一專案、停用的伺服器與個別停用的工具皆未出現在清單。 [模型請求測試](../../tests/e2e/custom-mcp.ts)
- **VERIFIED** 連線測試使用獨立 Windows Job 及暫存工作資料夾。stdio 驗證成功、找不到執行檔、提早結束、握手逾時及需要憑證。測試只送握手與讀取目錄請求。HTTPS 驗證憑證錯誤與位址拒絕。信任合成憑證的程序直接驗證 SSE 回應、驗證要求及拒絕跨來源重新導向。 [stdio](../../tests/e2e/custom-mcp-probe.ts) · [HTTPS](../../tests/e2e/custom-mcp-remote.mjs)
- **VERIFIED** Chromium 驗證新增、修改、停用、移除、工具清單、執行中拒絕重啟及資料重開後保留。畫面在淺色、深色、寬版與 390 px 窄版驗收。鍵盤測試涵蓋以空白鍵開啟表單、初始焦點、Tab 順序、專案選取與儲存。 [Chromium 測試](../../tests/e2e/custom-mcp-browser.ts)
- **VERIFIED** Windows 啟動器以合成模型服務驗證重新啟動後載入定義、完整結束後再開啟仍保留定義，以及三次 Windows Job 清理均為零孤立程序。測試攔截最後的瀏覽器交接。 [啟動器測試](../../tests/e2e/custom-mcp-launcher.ts)
- **VERIFIED** 合成憑證由子程序驗證雜湊。掃描測試資料目錄的 SQLite、設定檔與記錄，並檢查設定 API、HTML、測試結果、工具卡片與子程序命令列。合成工具刻意回傳憑證，工具輸出在送入模型前已遮蔽。備份測試另以實際寫入的合成憑證驗證整個備份與清單，再測試回復定義。合成 Windows 環境變數於測試結束刪除。 [外洩檢查](../../tests/e2e/custom-mcp-browser.ts) · [備份回復](../../tests/e2e/backup-restore.test.ts)

## 截圖

修整表單輸入框高度與邊框，將逾時欄位收合，讓窄版測試結果中的工具名稱與說明捲入可視區域。移除等待重啟時重複的等待連線標籤。

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
| --- | --- | --- | --- | --- |
| 清單 | [PNG](../validation/gui/slice4c-mcp-list-light-wide.png) | [PNG](../validation/gui/slice4c-mcp-list-dark-wide.png) | [PNG](../validation/gui/slice4c-mcp-list-light-narrow.png) | [PNG](../validation/gui/slice4c-mcp-list-dark-narrow.png) |
| 新增 | [PNG](../validation/gui/slice4c-mcp-add-light-wide.png) | [PNG](../validation/gui/slice4c-mcp-add-dark-wide.png) | [PNG](../validation/gui/slice4c-mcp-add-light-narrow.png) | [PNG](../validation/gui/slice4c-mcp-add-dark-narrow.png) |
| 測試結果 | [PNG](../validation/gui/slice4c-mcp-result-light-wide.png) | [PNG](../validation/gui/slice4c-mcp-result-dark-wide.png) | [PNG](../validation/gui/slice4c-mcp-result-light-narrow.png) | [PNG](../validation/gui/slice4c-mcp-result-dark-narrow.png) |
| 重新啟動 | [PNG](../validation/gui/slice4c-mcp-restart-light-wide.png) | [PNG](../validation/gui/slice4c-mcp-restart-dark-wide.png) | [PNG](../validation/gui/slice4c-mcp-restart-light-narrow.png) | [PNG](../validation/gui/slice4c-mcp-restart-dark-narrow.png) |

## 回歸驗證

| 檢查 | 結果 |
| --- | --- |
| lint、typecheck、test、scan | 通過。56/56 測試，掃描零命中，Recall@5 24/24。 |
| test:e2e:web、test:e2e:browser | 通過。HTTP 3/3，Chromium 合成情境通過。 |
| test:e2e:excel:synthetic、test:e2e:knowledge | 通過。Excel 5/5，知識瀏覽器 1/1。 |
| test:ingest、test:knowledge、test:telegram | 通過。依序為 16/16、12/12、5/5。 |
| test:e2e:mcp、test:backup、test:compliance | 通過。MCP 模型、stdio、HTTPS、Chromium 與獨立 Windows 啟動器測試通過，備份 1/1，合規 2/2。 |
| build:release、test:install、test:upgrade、test:release:determinism | 通過。安裝 1/1、升級 2/2、重現建置 1/1。重跑以每次新資料目錄、Python 驗證環境與固定的發行來源依序完成。 |

## 開放項目

- **UNVERIFIED** 成功的 HTTPS 回應和跨來源重新導向在傳輸層驗證。完整的 Chromium 遠端成功流程及全部失敗原因各自透過按鈕驗證仍開放。
- 遠端支援以 IPv4 建立具靜態憑證標頭的 Streamable HTTP POST，支援 POST 回應為 JSON 或 SSE。OAuth、舊式 SSE 傳輸與持續 GET SSE 串流仍開放。可直接映射的工具名稱提供個別權限，其它名稱以唯讀方式顯示。
- Email 維持以 MCP 資料範圍與專案清單替代。能力與技能管理仍屬後續切片。 [功能矩陣](../AEP_GUI_PARITY.md)
