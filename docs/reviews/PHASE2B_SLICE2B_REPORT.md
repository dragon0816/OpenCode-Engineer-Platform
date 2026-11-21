# Phase 2b Slice 2B 驗收

## 已驗收

- **VERIFIED** Chromium 驗證方向鍵移動及選取分頁、重載後還原會話分頁、窄版開關與 Escape 還原焦點。工作頁顯示會話執行紀錄及 BI 工作與排程摘要，並可開啟完整頁面。
- **VERIFIED** 合成附件可拖曳或選檔上傳。下載檔案的 SHA-256 和面板值相同。移除後，原下載網址回 404。以其他會話的附件或產物 ID 存取下載、預覽和移除皆回 404，保留原有專案隔離測試。
- **VERIFIED** 純文字、Markdown、CSV、XLSX、PNG、JPEG 和 HTML 預覽。驗證 CSV 前 200 列及顯示更多、XLSX 工作表切換、HTML 的空白 sandbox 屬性及指令碼保持惰性。PDF 顯示檔案資料和下載提示。合成的同名 XLSX 產物有一個變更儲存格，可看見前後值。
- **VERIFIED** 慢速合成回合執行時顯示等候秒數，取消及工具流程仍可用。原本的遮蔽規則在原始及雙層百分比編碼標記的每個 SSE 切分位置皆通過。
- **VERIFIED** lint、typecheck、test、scan、Web HTTP 3/3、Chromium、合成 Excel 5/5、Knowledge E2E 1/1、ingest 16/16、knowledge 11/11、Telegram 5/5。知識基線 Recall@5 24/24。

[Chromium 驗收](../../tests/e2e/web-browser.test.ts) · [Relay 遮蔽測試](../../tests/contract/poc-gateway.test.ts)

## 截圖

檢查深色與淺色、窄版與寬版後，將分頁列固定在捲動區上方，讓預覽在同一位置開啟，縮短檔案類型顯示，並將差異版本時間分列，避免截斷。

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 檔案與產物 | [PNG](../validation/gui/right-panel-files-light-wide.png) | [PNG](../validation/gui/right-panel-files-dark-wide.png) | [PNG](../validation/gui/right-panel-files-light-narrow.png) | [PNG](../validation/gui/right-panel-files-dark-narrow.png) |
| 工作 | [PNG](../validation/gui/right-panel-work-light-wide.png) | [PNG](../validation/gui/right-panel-work-dark-wide.png) | [PNG](../validation/gui/right-panel-work-light-narrow.png) | [PNG](../validation/gui/right-panel-work-dark-narrow.png) |
| 差異 | [PNG](../validation/gui/right-panel-diff-light-wide.png) | [PNG](../validation/gui/right-panel-diff-dark-wide.png) | [PNG](../validation/gui/right-panel-diff-light-narrow.png) | [PNG](../validation/gui/right-panel-diff-dark-narrow.png) |
| 純文字 | [PNG](../validation/gui/right-panel-text-light-wide.png) | [PNG](../validation/gui/right-panel-text-dark-wide.png) | [PNG](../validation/gui/right-panel-text-light-narrow.png) | [PNG](../validation/gui/right-panel-text-dark-narrow.png) |
| Markdown | [PNG](../validation/gui/right-panel-markdown-light-wide.png) | [PNG](../validation/gui/right-panel-markdown-dark-wide.png) | [PNG](../validation/gui/right-panel-markdown-light-narrow.png) | [PNG](../validation/gui/right-panel-markdown-dark-narrow.png) |
| CSV | [PNG](../validation/gui/right-panel-csv-light-wide.png) | [PNG](../validation/gui/right-panel-csv-dark-wide.png) | [PNG](../validation/gui/right-panel-csv-light-narrow.png) | [PNG](../validation/gui/right-panel-csv-dark-narrow.png) |
| XLSX | [PNG](../validation/gui/right-panel-xlsx-light-wide.png) | [PNG](../validation/gui/right-panel-xlsx-dark-wide.png) | [PNG](../validation/gui/right-panel-xlsx-light-narrow.png) | [PNG](../validation/gui/right-panel-xlsx-dark-narrow.png) |
| PNG | [PNG](../validation/gui/right-panel-png-light-wide.png) | [PNG](../validation/gui/right-panel-png-dark-wide.png) | [PNG](../validation/gui/right-panel-png-light-narrow.png) | [PNG](../validation/gui/right-panel-png-dark-narrow.png) |
| JPEG | [PNG](../validation/gui/right-panel-jpeg-light-wide.png) | [PNG](../validation/gui/right-panel-jpeg-dark-wide.png) | [PNG](../validation/gui/right-panel-jpeg-light-narrow.png) | [PNG](../validation/gui/right-panel-jpeg-dark-narrow.png) |
| PDF 資料 | [PNG](../validation/gui/right-panel-pdf-light-wide.png) | [PNG](../validation/gui/right-panel-pdf-dark-wide.png) | [PNG](../validation/gui/right-panel-pdf-light-narrow.png) | [PNG](../validation/gui/right-panel-pdf-dark-narrow.png) |
| HTML | [PNG](../validation/gui/right-panel-html-light-wide.png) | [PNG](../validation/gui/right-panel-html-dark-wide.png) | [PNG](../validation/gui/right-panel-html-light-narrow.png) | [PNG](../validation/gui/right-panel-html-dark-narrow.png) |

## 開放項目

- **UNVERIFIED** 逐 token 串流及與非串流輸出的對照驗收。現有遮蔽器在最多八輪解碼後，會用標記取代整個欄位，包括敏感片段出現前原本可讀的文字。若尾端才出現標記，固定視窗釋出的前綴已被送出，無法維持既有欄位行為。Relay 保留完成框架驗證和完整欄位遮蔽，介面顯示生成狀態及等候秒數。
- **UNVERIFIED** 已發布文字產物的整合流程。現有產物發布器只產出 XLSX，文字行差異顯示未經產物端到端驗收。
- **UNVERIFIED** PDF 首頁。現有瀏覽器功能無跨環境的單頁呈現方式，使用檔案資料和下載提示。
- **UNVERIFIED** 完整 WCAG AA 稽核及有資料的 BI 排程摘要。面板延用側欄色票，Chromium 驗證空摘要、執行紀錄與焦點行為。
