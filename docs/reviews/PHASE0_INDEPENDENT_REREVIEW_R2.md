# Phase 0 獨立複審（round 2 修復後）— Codex `gpt-6.2-astra`（非開發者、非 Claude）

審查版本 `cb8af3d`。所有執行與故障注入在 repo 外暫存副本；未使用公司 Gateway/key。此檔為 Claude Code 存檔的忠實摘要。

## 結論
- (A) 本機合併 `phase-0/spikes` → `main`：**FAIL**（阻擋項 R-2、R-3、R-4、R-5、R-8、R-9）。
- (B) Phase 0 gate：**FAIL**（(a) 修正與負例未全數成立；(b) 仍有 Important；(c) **O-3a PASS**）。
- Critical：未確認。

## 仍待修（Important）
| 項目 | 位置 | 失敗情境 | 建議 |
|---|---|---|---|
| R-2 部分修復 | `model-probe.ts:49` | 工具結果只要**包含**預期 token，即使完整內容錯誤仍回 200；獨立負例預期 409 而失敗 | 解析工具結果，精確比對允許的內容與形狀 |
| R-3 部分修復 | `opencode-probe.ts:130,361,442` | 在 300 ms 案例提前注入無關 `TypeError`，fault probe 仍 exit 0 | 區分 deadline／傳輸錯誤／程式例外，核對觸發原因 |
| R-4 部分修復 | `opencode-probe.ts:192`、`probe-assertions.ts:38` | 在同一個 `audit.send` 內把同一 B 操作送兩次，第二次也取得 admission，S4 **exit 0 且 duplicateSubmissions=0**（OpenCode 實際收到重複送件） | 在實際送出 prompt 的 transport 邊界按 operation ID 計數，核對 A、B |
| R-4 永久等待 | `opencode-probe.ts:204,215,240` | 重連串流在 `server.connected` 前正常 EOF → `ready` 永遠 pending；5 秒期限無效，由 15 秒外層 watchdog 終止 | EOF 與 abort 都要 reject 尚未完成的 `ready` |
| R-5 部分修復 | `probe-listeners.ts:37`、`windows-native-probe.ts:83` | PID/listener 快照與後續 `fetch` 建連是兩步；期間 listener 換手則無法證明收到 Basic 認證的程序身分（僅程式碼確認） | 驗證已建立連線的對端，並在同一連線送認證 |
| R-8 部分修復 | `ooxml_probe.py:122`、`attachment_probe.py:43` | 預檢只走 `sheetData/row`；openpyxl `_reader.py:166` 依 row 標籤解析，兩者接受節點集合不同；寬列可能在應用層檢查前配置 | 拒絕結構外的 row/cell，在配置前限制欄寬 |
| R-9 部分修復 | `secret-scan.mjs:70`、`install-hooks.mjs:16`、`.githooks/pre-merge-commit:2` | 同一 canary 存成 **UTF-16**，真實 commit **exit 0、hits 0**；`main` 未啟用 `.githooks`，fast-forward 合併不經過掃描 | 辨識文字編碼（UTF-16/BOM）並加真 hook 負例；由合併入口強制三掃 |

## Minor
- `attachment_probe_test.py:76`：乾淨環境無 `.phase0` 時 staging 測試 `FileNotFoundError` → 測試自建父目錄。
- `docs/validation/p0-s7-licensing.md:3`：wheel 數應由 3 更新為 4。
- R-7 文件的「2 秒」應標為 Windows 週期檢查的 user-time 配額（實測一次跑滿 4 秒、一次被 Job 終止）。

## 已確認修復
R-1（四種編碼與 mock/HTTP 負例）、R-6（STARTUPINFOEX Job list；struct 64/144/104/112/24；100 次建立 handle 不洩漏；三種停止路徑 0 殘留）、R-7（pypdf 6.21.4 為首個修補版，PyPI 最新 7.1.1；4 個 wheel SHA-256 與 PyPI 相符）、Minor 1–4。
D08 通過（hash 相符、PDF=MD=JSON=XLSX 13 格；改 B2 為 1.20 → hash 與 PDF 語意檢查同時失敗）。
**O-3a 通過**（build 26200；固定 exe；認證 /api/info 2.3.2、未認證 401；SSE 順序正確；IPv4/IPv6 listener 1/0；Job 4 成員；11 個 PID 存活 0）。
重現：lint 38 檔、typecheck、Node 15/15、Python 7/7、build 11 JS、tree scan 78 檔 0 命中。舊真 Gateway 20 回合已在 gate 報告降為 UNVERIFIED。

## 未驗證
真 HTTPS Gateway、睡眠/登出、遠端 CI、Win32 配置/ResumeThread 失敗注入；ZIP/entity 僅有界樣本。暫存副本因政策未遞迴清除（OS temp）。
