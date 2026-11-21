# Phase 2b Slice 4A 驗收紀錄

設定的 MCP 頁顯示內建知識庫狀態、固定 BI 查詢工具名稱及管理入口。管理入口移動焦點至既有開關。畫面補上操作按鈕間距，並說明變更僅適用於新會話。

## 固定版本

**VERIFIED** OpenCode v2.3.2 的本機 MCP 使用命令陣列、工作資料夾與環境變數。遠端 MCP 使用 URL、標頭與選用 OAuth 設定。兩者都有停用旗標和啟動、目錄、執行的逾時值。固定 API 有狀態清單與 experimental 新增、移除、連線和中斷。OpenCode stdio 透過執行環境啟動程序，連線層在握手後讀取工具目錄。OEP 已透過 `OPENCODE_CONFIG_CONTENT` 注入內建知識 MCP，並用會話權限規則控制新增會話的 BI 工具。 [固定 API](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/protocol/openapi.json) · [stdio 原始碼](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/mcp/stdio.ts)

## 截圖

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
| --- | --- | --- | --- | --- |
| 內建知識 MCP | [PNG](../validation/gui/slice4a-mcp-light-wide.png) | [PNG](../validation/gui/slice4a-mcp-dark-wide.png) | [PNG](../validation/gui/slice4a-mcp-light-narrow.png) | [PNG](../validation/gui/slice4a-mcp-dark-narrow.png) |

## 仍開放的功能矩陣項目

- **UNVERIFIED** 通用 stdio 與遠端 MCP 的新增、編輯、移除、測試、個別工具、連線防護、憑證、備份及重啟。
- **UNVERIFIED** 郵件替代設定的資料範圍說明與專案允許清單。
- **UNVERIFIED** 能力清單、專案設定、有效工具摘要、技能草稿驗證、啟用及移除。
- 其他切片仍開放的項目包括 Atlas 嵌入、Telegram 語音、記憶與聯絡人、完整工作及案例回顧、進階工作流程參數、串流逐字顯示及事件缺漏補齊、進階 BI／Wiki 建置、題目草擬及多人同步。各子項與驗收狀態見功能矩陣及個別驗收紀錄。 [功能矩陣](../AEP_GUI_PARITY.md) · [Slice 2D](PHASE2B_SLICE2D_REPORT.md) · [Slice 3A](PHASE2B_SLICE3A_REPORT.md)

## 驗證

- **VERIFIED** Chromium 顯示停用的內建知識 MCP。按 Enter 可開啟設定並將焦點移至 BI 查詢開關。停用後，新會話送至合成模型的工具清單不含 BI 查詢工具。 [測試](../../tests/e2e/knowledge.test.ts)
- **VERIFIED** lint、typecheck、test 54/54、scan 零命中、Web HTTP 3/3、Chromium、Knowledge E2E 1/1、Excel 合成 5/5、ingest 16/16、knowledge 12/12、Telegram 5/5、backup 1/1、compliance 2/2、release determinism 1/1、Recall@5 24/24。
- **UNVERIFIED** 完整模型 benchmark。基準指令先完成檢索，接著以合成問題進入模型階段。已停止該程序。
- **VERIFIED** 建立發行 ZIP 並使用既有 Python 3.12 虛擬環境後，安裝 1/1、升級與回退 2/2。維護測試在其他測試所啟動的 OpenCode 關閉後依序通過。
