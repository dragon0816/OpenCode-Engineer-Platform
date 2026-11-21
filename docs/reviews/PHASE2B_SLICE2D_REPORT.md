# Phase 2b Slice 2D 驗收

## 交付範圍

- 輸入框提供固定八個斜線指令。知識指令使用原有 Ask 端點、拒答規則及已核對引用的呈現。
- SQLite 加入會話訊息註記、回覆連結、會話刪除決定及專案唯讀資料夾。回覆引用取自同一會話的伺服器投影，最多 8,000 字，以 JSON 字串置於明確的引用界線中。筆記匯出在瀏覽器執行。
- OpenCode v2.3.2 的協定有 permission 查詢和回覆。OEP 既有策略拒絕待核准工具。本輪動作卡處理 OEP 自己的會話刪除，接受與拒絕寫入 Web 執行台帳資料庫。接受的決定與隱藏會話使用同一交易。
- 瀏覽器支援語音辨識時，聽寫會將文字填入輸入框。設定、權限拒絕、轉錄錯誤及版本資訊使用繁中介面。
- 每個專案顯示 OEP 管理的工作根。唯讀資料夾由 OEP 驗證並可明確附加檔案副本，OpenCode 繼續在隔離的工作根執行。**未交付** 通用 OpenCode 工具直接瀏覽唯讀資料夾及 Telegram 語音。

[Chromium 驗收程式](../../tests/e2e/web-browser.test.ts) · [功能矩陣](../AEP_GUI_PARITY.md)

## 仍開放的功能矩陣項目

- 設定與管理包含通用 MCP、郵件、能力與安裝管理、BI 查詢工具、Atlas 外部連結與嵌入、Telegram 語音。
- 操作包含記憶、偏好、聯絡人、名片與組織圖、完整工作與案例回顧表單、進階工作流程參數、逐 token 顯示及 SSE 遺漏補齊。
- 知識包含卡片詳細瀏覽與篩選、固定唯讀 BI 預覽與排序、示範載入、BI 建置與 Wiki sandbox 的其餘表單、可編輯 benchmark、多人同步。各階段已驗證的子項見功能矩陣與歷史報告。
- **UNVERIFIED** 完整 WCAG AA 稽核及實體麥克風／系統語音供應商。

## 驗收與迴歸

- **VERIFIED** 合成 Windows Chromium 驗證斜線清單鍵盤操作、未知指令、回覆引用送往合成模型與重載還原、訊息複製、評價和筆記、只匯出選取的筆記、兩專案路由隔離及會話刪除決定。Knowledge E2E 驗證斜線 Ask 顯示原有引用。
- **VERIFIED** 合成語音成功只填入輸入框，拒絕與轉錄失敗顯示繁中狀態。驗證版本與授權、唯讀路徑接受及拒絕案例、跨專案拒絕、合成工具寫入未改變原始檔。
- **VERIFIED** lint、typecheck、test 53/53、scan 零命中、Web HTTP 3/3、Chromium、Knowledge E2E 1/1、Excel 合成 5/5、ingest 16/16、knowledge 11/11（Recall@5 24/24）、Telegram 5/5。

## 截圖

合成驗收使用固定示範路徑顯示資料目錄。視覺檢查後縮短指令項目間距、捲動至輸入框以呈現選單、關閉其他畫面的選單、調整動作卡內距與遮罩，並重新載入專案頁以確認唯讀資料夾列入畫面。

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 斜線指令 | [PNG](../validation/gui/slice2d-slash-light-wide.png) | [PNG](../validation/gui/slice2d-slash-dark-wide.png) | [PNG](../validation/gui/slice2d-slash-light-narrow.png) | [PNG](../validation/gui/slice2d-slash-dark-narrow.png) |
| 訊息操作 | [PNG](../validation/gui/slice2d-message-menu-light-wide.png) | [PNG](../validation/gui/slice2d-message-menu-dark-wide.png) | [PNG](../validation/gui/slice2d-message-menu-light-narrow.png) | [PNG](../validation/gui/slice2d-message-menu-dark-narrow.png) |
| 回覆引用 | [PNG](../validation/gui/slice2d-reply-light-wide.png) | [PNG](../validation/gui/slice2d-reply-dark-wide.png) | [PNG](../validation/gui/slice2d-reply-light-narrow.png) | [PNG](../validation/gui/slice2d-reply-dark-narrow.png) |
| 筆記 | [PNG](../validation/gui/slice2d-notes-light-wide.png) | [PNG](../validation/gui/slice2d-notes-dark-wide.png) | [PNG](../validation/gui/slice2d-notes-light-narrow.png) | [PNG](../validation/gui/slice2d-notes-dark-narrow.png) |
| 動作卡 | [PNG](../validation/gui/slice2d-action-light-wide.png) | [PNG](../validation/gui/slice2d-action-dark-wide.png) | [PNG](../validation/gui/slice2d-action-light-narrow.png) | [PNG](../validation/gui/slice2d-action-dark-narrow.png) |
| 輸入設定 | [PNG](../validation/gui/slice2d-input-light-wide.png) | [PNG](../validation/gui/slice2d-input-dark-wide.png) | [PNG](../validation/gui/slice2d-input-light-narrow.png) | [PNG](../validation/gui/slice2d-input-dark-narrow.png) |
| 專案設定 | [PNG](../validation/gui/slice2d-projects-light-wide.png) | [PNG](../validation/gui/slice2d-projects-dark-wide.png) | [PNG](../validation/gui/slice2d-projects-light-narrow.png) | [PNG](../validation/gui/slice2d-projects-dark-narrow.png) |
| 關於 | [PNG](../validation/gui/slice2d-about-light-wide.png) | [PNG](../validation/gui/slice2d-about-dark-wide.png) | [PNG](../validation/gui/slice2d-about-light-narrow.png) | [PNG](../validation/gui/slice2d-about-dark-narrow.png) |
