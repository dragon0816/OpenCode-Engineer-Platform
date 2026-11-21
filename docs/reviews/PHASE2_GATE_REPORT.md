# Phase 2 Gate 報告

2026-11-21（Asia/Taipei） · `phase-2/web-gui` · 起點 `e616e6a`

## 優先複核的 10 個檔案

| 順序 | 檔案 | 複核重點 |
|---:|---|---|
| 1 | [auth.ts](../../apps/adapter/src/http/auth.ts) | Host／Origin、一次性配對、cookie 與 CSRF |
| 2 | [workspace.ts](../../apps/adapter/src/runs/workspace.ts) | Windows reparse 屬性、開檔 handle、身份及雜湊重驗 |
| 3 | [attachments.ts](../../apps/adapter/src/runs/attachments.ts) | 檔名與 MIME、配額、暫存登錄、會話歸屬及安全投影 |
| 4 | [chat.ts](../../apps/adapter/src/http/chat.ts) | 一次派送、重連對帳、工具權限、Gateway 結果及產物授權 |
| 5 | [main.ts](../../apps/adapter/src/main.ts) | Loopback listener、API 路由白名單、瀏覽器政策及關閉 |
| 6 | [events.ts](../../apps/adapter/src/http/events.ts) | 上游 SSE 重連、會話過濾及背壓處理 |
| 7 | [xlsx_to_text.py](../../workers/office/xlsx_to_text.py) | XLSX 限額、格式與公式處理 |
| 8 | [web-workbook.ts](../../apps/adapter/src/runs/web-workbook.ts) | 模型 JSON、當次來源、固定值編碼及產物收據 |
| 9 | [web.ts](../../apps/launcher/src/web.ts) | Profile 隔離、單實例、重新開頁及停止 |
| 10 | [runtime-job.ps1](../../scripts/windows/runtime-job.ps1) | 每使用者 mutex、Job 成員及強停清理 |

## Gate 判定

**Phase 2 gate 為 UNVERIFIED。** 本機 Windows、乾淨原始碼副本、兩個真模型 alias 及 Chromium 工作台已有實測。最終真 Gateway 瀏覽器重測 3/3 通過，完整歷史 14/15 通過。乾淨 Windows 11 x64 VM、額外路徑負例與獨立複核仍待完成。環境為 Windows 11 Pro x64（10.0.26200）、Node 24.14.1、npm 11.11.0、Python 3.12.7 與 Edge 157.0.4341.60。

| 驗收項 | 結果 | 命令與精簡輸出 |
|---|---|---|
| 本機 Windows WSH 單鍵、三重 pin、隔離資料 | **PASS** | 以 `git archive 117d5b2` 取乾淨副本，在含中文及空格的程式與資料路徑執行 `node --disable-warning=ExperimentalWarning --test tests/e2e/windows-launch.test.ts`。退出 0，1/1，總耗時 43.3 秒。WSH 首次補齊 npm 與 pin 檔案，兩次交接共用同一 PID 與 origin。測試接收器在最後瀏覽器交接取用一次性票證。 |
| 乾淨 Windows 11 x64 VM 及實際預設瀏覽器交接 | **UNVERIFIED** | Dell 實體工作站的乾淨原始碼副本已驗。現有環境無可用的目標 VM。WSH 與隔離 Chromium 各有獨立證據。 |
| 同源、身份驗證及 LAN 邊界 | **PASS** | `npm run test:contract` 13/13，驗 Host、Origin、Fetch Metadata、CSRF、401、一次性票證重放、Cookie 設定、路由白名單及靜態資產去敏。Windows 啟動測試錄得 OEP 與 relay 共兩個 loopback listener，OpenCode 啟動時核對受認證的獨立 loopback listener。 |
| 路徑及會話檔案界線 | **PASS** | `npm run test:contract` 拒絕 URI、`..`、UNC、ADS、硬編址、實際 junction 與 handle 開啟競態。異會話附件及產物 ID 拒件。先核對已開啟的 handle，再讀取同一 handle，驗身份及 SHA-256。 |
| Windows 檔案 symlink 與其他 reparse 標籤 | **UNVERIFIED** | 檔案 symlink 建立權限不足，實際 junction 已驗。開檔前查 Windows reparse 屬性，其他現場標籤保留驗證。 |
| 上傳格式與配額 | **PASS** | 合法合成 TXT、PNG、PDF、XLSX 成功登錄。超過 20 MiB 回 413，未知類型或不符 MIME 回 415，無效 UTF-8 回 422。SQLite 計入原檔及投影，200 MiB 邊界拒件，暫存清理保留已登錄檔案。模型工作目錄與驗證產物在上傳工作區之外。 |
| XLSX 轉換與主要限制 | **PASS** | 合成兩 sheets 15 格與列 locator 核對。501 列、51 欄、11 sheets、超過 100 MiB 的展開宣告、DTD、壞 ZIP 均拒絕。公式顯示 `[formula omitted]`。實作 worker 的 10 秒 timeout。 |
| XLSX worker 實際逾時、掃描 PDF | **UNVERIFIED** | 案例驗拒超限及一般 PDF 唯一值。保留實際 worker 逾時與掃描 PDF 的模型能力供後續核對。 |
| Chromium UI、BI 待審 stub、產物下載 | **PASS** | `npm run test:e2e:windows` 的 Chromium 套件以選檔、拖放及工作簿工具驗 3/3。BI 示範顯示待審，SSE 顯示工具完成，瀏覽器下載 SHA-256 與 manifest 一致。HTTP 合成測試另驗異會話 404 和改檔 409。 |
| 兩會話、三次 SSE 斷線及重送對帳 | **PASS** | `npm run test:e2e:windows` 3/3。用 client 中斷事件流，含斷線期間完成。恢復時重讀會話狀態，依序 50、49、50 ms。重送同一 ID 只回傳既有 run，模型請求重送與跨會話事件皆 0。 |
| 真上游 SSE overflow | **UNVERIFIED** | 具背壓斷流與重讀狀態，三次證據均為實際 client 斷線。 |
| 單實例與停止程序樹 | **PASS** | `npm run test:e2e:windows` 兩次啟動共用一個 supervisor。正常及強停後，4 個 Job 成員及 Job supervisor 分別在 280 ms、21 ms 內消失，殘留 0。輸出目錄為 `phase1-141LTF`。 |
| SQLite 向前遷移 | **PASS** | `npm run test:contract` 核對 v1 歷史 run 與 v2 migration 前的一致備份。 |
| 真模型 PNG／PDF／XLSX 與下載 | **PASS** | 五輪共 15 筆，14 筆通過。最後一輪 Chromium 通過 3/3。四份成功 XLSX 另由 openpyxl 重開，兩張工作表的順序、範圍、15 格型別及值全符。 |
| 模型首次輸出與錯誤呈現 | **FAIL** | 五輪中一次模型寫出結尾缺括號的 JSON。OEP 判 run failed，UI 顯示錯誤，下載產物 0。補上完整 JSON 範例及具體錯誤原因後重測通過。Gateway 另有 2 筆逾時，皆在 OpenCode 有界重試後完成。 |
| Phase 1 產品回歸 | **PASS** | `npm run test:contract:native` exit 0，`native=2.3.2 auth=401 maxConcurrent=2 matchedToolResults=6 duplicateSubmissions=0`。使用鎖定的 Python oracle 依賴執行 `npm run test:e2e:excel:synthetic`，exit 0，`attempts=5 longestConsecutive=5`，每份 13 格。執行目錄為 `phase1-SHZynM`、`phase1-9fhENx`。 |
| 品質檢查與憑證掃描 | **PASS** | `npm run lint` 檢查 100 檔，`npm test` 38/38，`npm run typecheck`、`npm run build`、`npm run scan`、`git diff --check` exit 0。既有 hooks 啟用且每筆提交前掃描命中 0。 |
| Claude Code 輕量複核 | **UNVERIFIED** | 交由 Claude Code 複核本報告及分支差異。 |

## 全部真 Gateway 嘗試

五輪均由 OpenCode v2.3.2 經 OEP relay 送合成資料。每輪開放同源本機入口，第一輪用 HTTP 驗 API，其他由 Chromium DOM 操作。以下依執行順序列出所有 15 筆 turn 及其 22 筆 Gateway 請求。時間單位為毫秒。請求標記為「本機狀態／上游狀態，耗時」。完整 token 用量與 run／session／submission IDs 見各輪原始紀錄。

| 輪次、alias | 輸入 | Turn 結果／耗時 | 所有 Gateway 請求 |
|---|---|---|---|
| A · GPT · HTTP | PNG | PASS · 41004 | #1 502／null，35003，逾時。#2 200／200，1757，文字 |
| A · GPT · HTTP | PDF | PASS · 2873 | #3 200／200，1180，文字 |
| A · GPT · HTTP | XLSX | PASS · 8427 | #4 200／200，5131，工具。#5 200／200，1427，文字 |
| B · Haiku · Chromium | PNG | PASS · 5599 | #1 200／200，3561，文字 |
| B · Haiku · Chromium | PDF | PASS · 2907 | #2 200／200，1661，文字 |
| B · Haiku · Chromium | XLSX | PASS · 9256 | #3 200／200，5256，工具。#4 200／200，1821，文字 |
| C · GPT · Chromium | PNG | PASS · 47598 | #1 502／null，35014，逾時。#2 200／200，8480，文字 |
| C · GPT · Chromium | PDF | PASS · 2608 | #3 200／200，1047，文字 |
| C · GPT · Chromium | XLSX | FAIL · 5602 | #4 200／200，2269，工具。#5 200／200，1422，文字 |
| D · GPT · Chromium | PNG | PASS · 7007 | #1 200／200，5312，文字 |
| D · GPT · Chromium | PDF | PASS · 3015 | #2 200／200，1460，文字 |
| D · GPT · Chromium | XLSX | PASS · 4565 | #3 200／200，1512，工具。#4 200／200，931，文字 |
| E · GPT · Chromium | PNG | PASS · 21594 | #1 200／200，19862，文字 |
| E · GPT · Chromium | PDF | PASS · 2923 | #2 200／200，1305，文字 |
| E · GPT · Chromium | XLSX | PASS · 4523 | #3 200／200，1373，工具。#4 200／200，1008，文字 |

GPT 為 `gpt-5.4-mini`，Haiku 為 `claude-haiku-4-5-20251001`。PNG 辨識值為 `ORBIT-7349`，PDF 為 `PRINT-2746`，XLSX 的 `量測` 工作表首筆為 `SYN-48B`。A、B、D、E 命令 exit 0。C 命令 exit 1（2/3），模型 JSON 的 SHA-256 為 `ee50f53b61b621dda58e9c7f2a337d8f675bca827a64310a09fba3c27e49e3a3`，保存在該會話的 `generated/5b175c77-6ee9-438e-8c49-98fa55fed990.json`。

### 本機證據位置與 SHA-256

目錄相對於 `%LOCALAPPDATA%\OEP`。所有模型嘗試均留存在 attempts、turn 及 relay 日誌。每個成功下載比對 `X-OEP-SHA256` 或 Chromium 所見的 run manifest。

| 輪次、命令 | 目錄 | 產物及 SHA-256 |
|---|---|---|
| A · `npm run test:e2e:web:real` | `phase1-dyhcqB/Phase 2 合成資料/launch-pzHdgp` | `downloaded.xlsx` · `2dc476f1c98fa3a50916ce90f3049f3c7b9079b1e6e2608eca4a6165dec7e171` |
| B · `npm run test:e2e:browser:real` | `phase1-TS8Rjh/OEP 瀏覽器驗收/launch-YfbulE` | `downloads/output.xlsx` · `ec44a689adf8359de5e6e2d2fdbccb471ef70d63cd66decebf704cc0dc6ac59e` |
| C · `npm run test:e2e:browser:real` | `phase1-Hzainx/OEP 瀏覽器驗收/launch-VyQ2rz` | 錯誤畫面 `table.xlsx.screenshot.png` · `7f795931c56d12453152cef54de3b93ac3a53bdd8d02eb4f329d038411e6656b` |
| D · `npm run test:e2e:browser:real` | `phase1-YOXTbJ/OEP 瀏覽器驗收/launch-50nCFh` | `downloads/output.xlsx` · `e6ad8c136e8c51d540d1267d73b007cd56eee283b2cb88a2fc8fd30a2797cf2b` |
| E · `npm run test:e2e:browser:real` | `phase1-JLRuQx/OEP 瀏覽器驗收/launch-LyEuEZ` | `downloads/output.xlsx` · `fbe9ca580a4729c92a37363d9f7002699368d0876b1e0a02064bbc24d7c09391` |

| 輪次 | `web-attempts.jsonl`／`browser-attempts.jsonl` | `gateway.jsonl` |
|---|---|---|
| A | `79761561367df64c3a3ef14537605a7663df47cf5180d4e162985b4c937426ba` | `2a6a7919fafbc2f54d50f8344d8e9ae6ef205d832f1d383a55a68983fcff3e9f` |
| B | `d322821370c273897eab2728c1e2a4522a03c22f73e48f124fcad0d2c3620a63` | `dd277bf0644f73827aea438d433610c2af677a3208a692cc594c5dc7eb3cba14` |
| C | `f484f4ecc2df28ee160cca824ae27f98be3b5455f9ef5618a6843071c62b4aae` | `f267f086c89f1ef33a05440fe328cb072489fed1936b31fc332875efa812c554` |
| D | `56c134a0ed4eff27ed16193846e09cc3440e15ed1e37a02990f996bb694fc6e4` | `a4be67be486c85d8ad496a174e2b7f421a087eb9fcfafd77fb1aeff7ee4c4faf` |
| E | `f87980a2817bacbad0e2bea1cc8637c817ca91e708f7253ae63d84f0585caafb` | `c635abca9a437986b3320cf209006c0a8da3aadb261e6025a04aad8b1bd11632` |

E 輪工作台畫面在同目錄。PNG、PDF、XLSX 的 `.screenshot.png` 畫面雜湊依序為 `d1fdfa9839936e937a46d7cb51d5f5b55201e61141a1146b3cba54e4a82736f5`、`23c43e5d39a7e4a34e334ec24032660e520f52462e64c5bb3d6a03caa83df420`、`a860303c63bb6b481cf47fa9a34285fa0a8ed232caba0ae701a1955cf90cc888`。所有輸入使用既有合成 fixtures，PNG、PDF、XLSX 的 SHA-256 依序為 `8397795d271a42d4476c826c69f98cd4a63b7ee91a6d124b8b05be6dd6e8b69f`、`a4add5602420ebf584e4f4a601d4cbe932c2060bdb0fb0fce5686a6241f641ba`、`6919616d6ed1da164a1e7da9f74e07e2810f68016e363964a5ab66848535cc4c`。

合成 HTTP 重測 exit 0，3/3，`phase1-PZ8c0l/Phase 2 合成資料/launch-hWzYr3/downloaded.xlsx` 的 SHA-256 為 `14d25e6ea87bce017cd66831c3807bc076863083a005430c034c8a877e2b6136`。合成 Chromium 的同一驗收下載位於 `phase1-QssJgL/OEP 瀏覽器驗收/launch-rBt0Jx/downloads/output.xlsx`，SHA-256 為 `e8b283208d1133f8c436b9ca13446aba1605702b290cb61cd453ad2e010514b7`。

## 偏差、風險及 Owner 待辦

- 以現有套件與瀏覽器交付靜態 HTML、CSS、JavaScript。實際入口使用 VBS 與隱藏 PowerShell，辦公室轉換器使用 Python 標準函式庫。BI 只呈現待審 stub。 [實作決策](../DECISIONS.md)
- 本機開發期間的 WSH 測試曾因 PATH 內兩份 Node 導致啟動失敗。改用 PATH 第一個 Node 並核對版本後通過。手動重跑 pin 下載與原生 runtime 並行時曾遇執行檔鎖定。已改為重用既有已驗執行檔，乾淨副本的下載與驗證也通過。
- 乾淨原始碼副本證實本機一鍵補依賴並啟動。Owner 提供乾淨 Windows VM 驗收環境後，須由實際桌面雙擊、確認預設瀏覽器前景交接，再驗檔案 symlink 和目標 VM 邊界。Windows 的命令測試可在該 VM 重跑。 [操作](../validation/p2-windows-web.md)
- Gateway 仍有逾時與空回覆風險。兩次觀察到逾時後恢復，實際 worker timeout、掃描 PDF、真上游 SSE overflow、VM 網路旁路及 Phase 0 的 O-1／O-2 證據待補。LAN HTTP 取捨、key scope 與 retention 延用先前紀錄。 [決策](../DECISIONS.md)
- 上傳工作區配額覆蓋索引的原檔與投影。每次工作產生的模型 JSON 和已驗產物各有單檔驗證，長期保留策略依 Windows 發行計畫處理。
- Claude Code 進行一次輕量複核。依結果及剩餘驗收項由 owner 判定 Phase 2 gate。

## 提交與差異

| Commit | 內容 |
|---|---|
| `db1dcbb` | Record the owner decision to start Phase Two |
| `58a9d09` | Store and verify session attachments and workbooks |
| `250f3c4` | Expose a paired local chat API and reconcile live sessions |
| `c12ea23` | Add the OEP browser workbench |
| `9af1b30` | Launch OEP from the Windows desktop |
| `83dc7e2` | Exercise browser uploads and Windows lifecycle contracts |
| `03f7b60` | Measure Windows shutdown from the stop request |
| `117d5b2` | Report malformed model workbook data clearly |
| `15a71dd` | Check loopback ownership and workbook expansion limits |
| `6606dd6` | Isolate model staging from the session upload quota |
| 本報告所在提交 | Record Phase Two results and remaining validation |

`git diff --stat e616e6a..HEAD` 為 47 檔、+2999／−44 行。提交所在分支為 `phase-2/web-gui`。
