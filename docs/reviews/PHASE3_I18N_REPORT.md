# Phase 3 工作台介面語言切換

2026-11-22（Asia/Taipei）。基準為 `main` 的 `6c280d4`，交付分支為 `phase-3/ui-i18n`。

## 已交付

- 工作台頁面、選單、提示、對話框、狀態及無障礙標籤使用繁體中文與英文語言檔。日期、數字、相對時間及檔案大小依介面語言格式化。用語與 [工作台詞彙表](../GUI_LAYOUT.md#用語) 一致。
- 設定的「外觀」和頂列「更多」提供語言選單。預設繁體中文，選擇保存在 `localStorage` 的 `oep.locale`。切換會更新原有節點，保留目前頁面、附加資料分頁、尚未送出的文字、焦點及選取範圍。
- 工作台 HTTP 錯誤、回合、連線測試、儲存庫診斷與收件提示帶有穩定代碼及必要參數，並保留繁體中文回應文字供舊用戶端使用。既有回合與收件紀錄在讀取時對應代碼。Telegram 回覆及對話、知識、檔名與使用者輸入名稱沿用原有資料。
- 英文樣張使用合成工作台測試資料。每個畫面提供 1440 × 900 與 390 × 844 的淺色、深色版本。 [GUI 樣張](../GUI_LAYOUT.md#英文樣張)

## 測試調整與理由

| 檔案 | 調整與理由 |
|---|---|
| `tests/contract/web-i18n.test.ts` | 驗證兩份語言檔鍵值相同、字串非空、無重複鍵、無漏用或未使用的鍵、參數一致，以及英文語言檔沒有 CJK 字元。解析 HTML 屬性、JS 呼叫及後端代碼表，檢查繁中備援與參數格式。 |
| `tests/contract/local-api.test.ts` | 標題搬到語言檔後，原先比對 HTML 字面的斷言改為驗證標題鍵、兩份語言檔回應、MIME 類型與標題。保留原有 CSP、路由及配對斷言。語言檔也加入憑證查漏範圍，並檢查未配對的狀態碼、訊息代碼與繁中備援。 |
| `tests/contract/workspace.test.ts` | Excel 轉換格式、工作區容量與工作簿格式錯誤，改用既定 HTTP 狀態及穩定訊息代碼比對，取代先前的英文錯誤文字正規表示式。保留原有檔案內容、限制和清理斷言。 |
| `tests/e2e/gui-locales.ts` | 新增同一畫面切換兩種語言的輔助方法，檢查可見介面文字和可及性名稱。核對英文介面沒有 CJK，繁中介面只接受既定產品名、資料格式、模型名、命令與技術縮寫。原文、檔名、輸入名稱與資料識別碼依其所在欄位辨識。 |
| `tests/e2e/forbidden-shell-text.ts` | 保留原有禁用詞、進階用語及對話框斷言，在雙語、雙主題執行。辨識兩種語言的進階摘要，並用對應的選單名稱開啟原生對話框。檔名在禁用詞檢查保留原樣，混語檢查只檢查對話框的介面提示。 |
| `tests/e2e/gui-contrast.ts`、`tests/e2e/gui-mapping.ts` | 每個既有對比樣本與控制項對照在繁中、英文各跑一次。沿用對比門檻、定位及覆蓋列數，文字定位依語言使用對應的字串。 |
| `tests/e2e/web-browser.test.ts` | 保留原有 390、768、1440 px 的頁面寬度斷言，在雙語重跑並加入控制項及選單截斷檢查。新增英文瀏覽器仍預設繁中、雙分頁與草稿焦點保存、後端錯誤切換、重新載入後英文偏好，以及外觀選單切換驗證。重新載入仍以新文件與連線文案確認。加入同狀態工作合計，避免在語言切換後將同組拆開。補回復原視窗寬度等待，讓原有附加資料寬度斷言仍比對相同寬度。保留既有下載、檔案預覽、設定及快捷鍵斷言。 |
| `tests/e2e/knowledge.test.ts` | 知識庫、建置、審核和排程的可見文字、對比與既有控制項群組在雙語檢查。前後端功能與原有計時門檻保留。 |
| `tests/e2e/custom-mcp-browser.ts` | 保留憑證欄位、按鈕可用性、重啟與查漏斷言。憑證欄位及操作加入雙語對照，動態編輯器或連線結果沿用雙語文字檢查。 |

啟用 `OEP_CAPTURE_GUI_EN=1` 執行瀏覽器與知識庫測試，可重新擷取英文樣張。擷取時沿用各自的合成資料與就緒檢查，拍攝後返回原先流程的繁中狀態。窄版對話畫面從最後一則合成回覆開始顯示。

## 新增字串

1. 同一變更在 `apps/web/src/i18n/zh-TW.js` 與 `apps/web/src/i18n/en.js` 新增同名鍵。使用作業或畫面名稱命名，全文使用一致用語。兩份語言檔使用相同的參數名，例如 `{name}`，數量用可適用於零、一及多筆的句型。
2. 靜態 HTML 使用 `data-i18n` 或對應屬性，例如 `data-i18n-aria-label`。若控制項內含圖示或欄位，把 `data-i18n` 放在文字的子節點。
3. 動態節點使用 `message(key, params)` 搭配 `setText`、`setAttribute` 或 `optionText`，讓顯示中的節點在切換時更新。原生對話框在開啟時可用 `t(key, params)`。日期或數字使用既有格式化函式。
4. 後端訊息在 `apps/adapter/src/http/messages.ts` 宣告穩定代碼與繁中備援，並在兩份前端語言檔加上 `server.<code>`。參數只帶前端現有權限可見的值。

## 驗收輸出

每個指令循序執行，使用各自新建的暫存 `OEP_DATA_DIR`。Excel 驗證在子程序設定虛擬環境的 PATH 和 `OEP_PYTHON`。環境是 Windows 11 x64、Node 24.14.1 與 PowerShell 7。工作樹已啟用 Phase 0 Git hooks。

| 指令 | 結果 | 實際輸出摘要 |
|---|---|---|
| `npm run lint` | 通過 | `Checked 202 source and configuration files.` |
| `npm run typecheck` | 通過 | `tsc --noEmit`，exit 0 |
| `npm test` | 通過 | 57 通過，0 失敗 |
| `npm run build:release` | 通過 | `OEP-0.0.0-windows-x64.zip`，SHA-256 `7c1583546f93ca51fa8b9ba0a9716cfd486a2006b2f7781d7b966d9d49e77b19`，敏感資料掃描通過 |
| `npm run test:e2e:browser` | 通過 | 三輪皆通過，50.5、66.4、50.5 秒。每輪 `supervisorExit: 0`、`childExit: 0`、`orphans: 0` |
| `npm run test:e2e:knowledge` | 通過 | 1 通過，0 失敗，含合成樣張 |
| `npm run test:ingest` | 通過 | 16 通過，0 失敗 |
| `npm run test:telegram` | 通過 | 5 通過，0 失敗 |
| `npm run test:e2e:mcp` | 通過 | `Chromium MCP add, catalog test, apply, persistence, edit, disable, and remove verified.` |
| `npm run test:compliance` | 通過 | 2 通過，0 失敗 |
| `npm run test:release:determinism` | 通過 | 1 通過，0 失敗。兩次 ZIP 完全相同，檔案清單完整 |
| `npm run scan` | 通過 | `"hits":0` |

開發中，舊標題與錯誤文字斷言曾導致 4 個單元測試失敗。改成核對標題鍵、語言檔資源與後端訊息契約後重跑。排版檢查也發現英文模型選單、預設助理介紹與會話列名稱可能截斷。縮短英文用語、允許預設會話標籤換行，並在瀏覽器檢查其實際寬度。合成檔案的試算表名稱、參考來源與使用者輸入保留原文。

## 待審核者驗收

- `npm run test:e2e:web`、`npm run test:e2e:excel`、`npm run test:install`、`npm run test:upgrade`、`npm run test:backup` 由擁有者使用可取得本機執行或維護鎖的環境驗收。
- 原生選檔視窗和原生確認對話框按鈕由瀏覽器提供。瀏覽器驗收涵蓋工作台提供的字串與合成操作。
