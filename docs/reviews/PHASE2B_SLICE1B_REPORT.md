# Phase 2b Slice 1b 工作台驗收

## 已驗收

- **VERIFIED** 專案側欄、新增會話、搜尋、切換、改名、取消與確認刪除、重載後恢復會話、窄版抽屜。專案各有工作根目錄，側欄只列出目前專案的會話。
- **VERIFIED** Chromium 在第二個專案建立會話後看不到第一個專案的會話列、附件或產物。以另一專案的會話 ID 請求狀態、事件、附件上傳與產物下載均回 404。原有 PNG、PDF、XLSX 及下載雜湊斷言通過。 [驗收程式](../../tests/e2e/web-browser.test.ts)
- **VERIFIED** lint 138 檔、typecheck 通過、test 49/49、scan 0 命中、Web HTTP 3/3、Chromium 附件案例 3/3、合成 Excel 5/5、Knowledge E2E 1/1、ingest 16/16、knowledge 11/11（Recall@5 24/24）、Telegram 5/5。

[淺色寬版](../validation/gui/workbench-light-wide.png) · [深色寬版](../validation/gui/workbench-dark-wide.png) · [淺色窄版](../validation/gui/workbench-light-narrow.png) · [深色窄版](../validation/gui/workbench-dark-narrow.png)

## 開放列

- **UNVERIFIED** 完整鍵盤流程、對話串流、工具與事件卡、停止個別回合。
- **UNVERIFIED** 檔案預覽、工作與差異分頁。
- **UNVERIFIED** 頭像驗證與重設、核准模型選擇與健康、回合限制、執行環境及麥克風。
- **UNVERIFIED** 斜線選單、複製、指定回覆、評分與筆記、操作卡、鍵盤與對比驗收。
- **UNVERIFIED** 新會話套用助理指示提示及上游歷史驗證。
- 其餘 2b 開放列沿用 [Slice 1 開放清單](PHASE2B_SLICE1_REPORT.md#開放列)。會話列的模型切換仍開放。
