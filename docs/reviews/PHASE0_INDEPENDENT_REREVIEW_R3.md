# Phase 0 獨立複審 round 3 — Codex `gpt-6.2-astra`（非開發者、非 Claude）

審查版本 `05c04d7`。唯讀；暫存副本做故障注入；未使用公司 Gateway/key。Claude Code 存檔的忠實摘要。

## 結論
(A) 合併 `phase-0/spikes` → local `main`：**FAIL**。(B) Phase 0 gate：**FAIL**（(a)(b) 未成立；(c) O-3a PASS）。Critical：無。

## 仍待修（Important）
| 項目 | 位置 | 獨立實測 | 修正 |
|---|---|---|---|
| I-A R-4 重複送件 PARTIAL | `opencode-probe.ts:89,191` | 同一送件函式用受觀察 client 重送 B → 正確 exit 1；改由一般 `server.client` 重送**同一 B operation ID**，三輪都收到第二筆 admission，`contract` 卻 exit 0（`trackedOperations=6, duplicateSubmissions=0`） | 在**所有 client 共用的 HTTP 邊界**計數，逐一核對 A、B operation ID；保留跨 client 負例 |
| I-B R-3 PARTIAL | `opencode-probe.ts:132` | 真逾時後的 `interrupt` 傳輸路徑注入 `TypeError`，空白 `catch` 吞掉，`contract` exit 0 | 清理只容許明列的預期錯誤；程式例外使驗收失敗；保留原始逾時原因 |
| I-C S2 一般工具回合 NOT FIXED | `model-probe.ts:100`、`opencode-probe.ts:298,339` | 把一般回合 MCP 工具結果改成**含正確 token 的錯誤字串**，兩 alias 仍各 10/10，`contract-relay` exit 0（fixture 用 substring 還原答案，只核對回傳 ID 與末則文字） | 每個 call ID 核對其 slot 對應的**完整結果與形狀**再計入連續成功 |
| I-D S4 握手後斷流 NOT FIXED | `probe-http.ts:118`、`opencode-probe.ts:245` | 三次都在讀到真實 `server.connected` **之後**立刻結束重連串流；HTTP 對帳仍成功，`contract` exit 0，三輪都算重連成功 | 對帳完成前，非主動關閉的 EOF 使該輪失敗；加握手後斷流負例 |
| I-E R-9 合併保護 PARTIAL | `merge-check.mjs:35`、`.githooks/pre-merge-commit:2` | 受檢入口可擋；但相同來源直接 `git merge --ff-only` exit 0、事後掃描命中 1；首次受檢合併模擬 Git 設定鎖 → 入口 exit 1 但 `main` 已前進、hooks 未啟用 | 先完成並驗證 hook 設定，**再**更新目標 ref；直接 fast-forward 也須在 ref 更新前被擋（Git 對 ff 不觸發 pre-merge-commit；可考慮 install script 設 `merge.ff=false` 使合併一律產生 merge commit 而觸發 hook，並驗證）；文件明示哪些入口有預掃 |

## Minor
- `p0-s6-windows.md:20` 仍寫 3 個 wheel → 更新為 4，並標明舊容量量測的版本。
- `windows-native-probe.ts:137` 的 12 秒 timer 在 supervisor 先退出後仍存活，成功報告後 Node 多等約 11.7 秒 → supervisor 結束時取消 timer。

## 已確認修復
R-2 forced 結果（精確文字與單一 text item 200；尾綴錯字/錯欄位/多 item 409）、R-4 握手前永久等待（EOF/abort <1 ms 拒絕；忽略 signal 的停滯 5,001 ms 拒絕）、R-5（Windows：第二程序持有 listener 時錯誤 PID 只收 2-byte、HTTP 請求數 0；每例單一 TCP 連線、專用 Agent 回傳該 socket）、R-8（結構外 row/cell、過多 cell、超寬座標預檢即拒）、R-9 編碼（UTF-16/32 LE/BE、有無 BOM、Base64、百分比編碼、拆字串皆命中）、乾淨 staging 與 2 秒標示、wheel 清冊 4 個。
重現：lint 40 檔、typecheck、Node 21/21、Python 6+2、build 12 JS、tree scan 81 檔 0 命中；Windows Job 129/73/76 ms 0 orphan；O-3a build 26200 PASS（雜湊相符 v2.3.2、401 對照、prompt、SSE、IPv4/IPv6 1/0、8 個程序存活 0）。
未驗證：真 HTTPS Gateway 20 回合、遠端 CI、上游 SSE overflow、Windows 三輪重連時序、Win32 配置/ResumeThread 失敗、listener 即時換手、任意不可信附件。
