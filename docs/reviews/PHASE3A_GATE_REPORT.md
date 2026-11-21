# Phase 3a　驗收報告

2026-11-21（Asia/Taipei）。`phase-3/knowledge-read`，基線 `a6aa863`。**合成資料功能與最終真 Gateway 問答達標，整體 gate 為 UNVERIFIED**。目標 VM 與 owner 核准的 AEP 實際快照仍缺驗證。

| 優先 | 敏感檔案 | 核對重點 |
|---:|---|---|
| 1 | [ask.ts](../../packages/knowledge/src/ask.ts) | 檢索先於模型，拒絕偽造引文字串、異庫、索引過期、無支持輸出，送出後重驗發布指標。 |
| 2 | [store.ts](../../packages/knowledge/src/store.ts) | 交易內寫入、索引與發布指標，證據從固定 revision 與內容 hash 讀取。 |
| 3 | [convert-aep.ts](../../packages/knowledge/src/convert-aep.ts) | 本機輸入、gzip 上限、唯讀文件、Wiki 三種 digest、schema 與關係映射。 |
| 4 | [snapshot.ts](../../packages/knowledge/src/snapshot.ts) | 發布狀態、身份唯一性、欄位參照、schema 與引文 hash。 |
| 5 | [retrieval.ts](../../packages/knowledge/src/retrieval.ts) | 繁中單字與雙字、料號與規格正規化、參數化 FTS5。 |
| 6 | [knowledge-mcp.ts](../../apps/adapter/src/opencode/knowledge-mcp.ts) | loopback、每次啟動獨立憑證、拒絕瀏覽器 Origin、共用 Ask。 |
| 7 | [knowledge-model.ts](../../apps/adapter/src/opencode/knowledge-model.ts) | 核准 alias、只送本次檢索證據、取消與有界模型回應。 |
| 8 | [knowledge.ts](../../apps/launcher/src/knowledge.ts) | OEP 資料目錄、唯讀 runtime、模型 audit 與聊天 audit 分開。 |
| 9 | [main.ts](../../apps/adapter/src/main.ts) | 知識 API 遵循配對、Host、Origin 與 CSRF，禁止由 Web 匯入。 |
| 10 | [supervisor.ts](../../apps/launcher/src/supervisor.ts) | 只准呼叫內建知識工具，OpenCode 仍驗固定版與 listener。 |

## 逐項門檻

| 項目 | 狀態 | 證據 |
|---|---|---|
| Part A 計畫、盤點、版面、時序及 ADR 一致性 | PASS | `3c769c0` 先提交 6 份文件。固定版 AEP `c9961b2d0d66eef3892375213ce305883ebde960`。Phase 2b 收尾為 Phase 5 打包前置。 [計畫修訂](../IMPLEMENTATION_PLAN_V2.md#phase-2b-gui-parity) |
| Source、card、關係、schema、revision、blob/evidence 清點，shadow 與原子切版 | PASS | 兩份合成快照皆通過乾跑、匯入與重建。BI 2 來源、2 卡、1 關係、3 段。Wiki 2 來源、2 卡、1 關係、2 段。兩邊輸入 hash 保持相同，無有效項拒收。 |
| 一致備份與還原對帳 | PASS | 測試從備份另開唯讀 DB，比對兩版本完整快照、定位與關係。另以 CLI 備份兩個合成庫，重開確認索引、版本、卡片與授權狀態。 |
| 固定 48 題及 Recall@5 ≥85%，同語料不低於 baseline | PASS | 24/24（100%），相同 40 段語料的簡單比對亦為 24/24。涵蓋繁中短查、近似料號與大小寫／全形。 |
| 本機 1,000 段暖機，至少 100 次，p95 ≤1 秒 | PASS | Windows 11 Pro 10.0.26200 x64 實體主機，Node 24.14.1。144 次，`npm test` 的 p95 為 13.918 ms，另一次專用測試為 14.748 ms。 |
| 在計畫指明的 Windows 11 x64 VM 重做量測 | UNVERIFIED | 目前證據來自實體主機。 |
| 明確 Ask 跳過檢索、跨庫／修訂、過期索引、草稿、偽造引文皆封鎖 | PASS | 合約測試涵蓋無模型呼叫、發布指標與 hash、拒答，以及空回覆最多重試一次。 |
| Chromium 知識頁與原生 OpenCode MCP | PASS | 測試實際 Chromium 顯示空庫與通過的引用，以鍵盤進入後返回對話。OpenCode v2.3.2 在兩次合成聊天收到驗證成功與偽造引文拒絕結果。 |
| 真 Gateway 不可答拒答 ≥95%、可答可用 ≥90%、引用重現 100%、關鍵無支持 0 | PASS | 最終兩個 alias 各 24/24、24/24、24/24、0。第一輪 Haiku 未達標，明細保留如下。 |
| 真資料 AEP 遷移品質差異與真模型聊天選擇 MCP | UNVERIFIED | 現有資料為獨立合成 fixture。真模型直接 Ask 已驗。工具調用測試使用原生 OpenCode 與合成 Gateway。 |
| lint、typecheck、test、build、既有 hooks 與秘密掃描 | PASS | lint 118 檔，測試 42/42，typecheck 與 build exit 0，各次提交的 tree、index 與新 ref 掃描皆 0 命中。 |

## 重現命令與輸出摘錄

| 命令 | 摘錄 |
|---|---|
| `node scripts/phase0/install-hooks.mjs`、`npm run scan` | 已安裝；實作提交 tree 與 ref 各掃描 173 檔、0 命中。 |
| `npm run lint`、`npm run typecheck`、`npm run build` | `Checked 118 source and configuration files.`，`tsc --noEmit`、`tsc --outDir .phase0/build` 成功。 |
| `npm test`、`npm run test:knowledge` | `tests 42, pass 42, fail 0`；專用契約 4/4。 |
| `npm run test:e2e:knowledge` | `tests 1, pass 1, fail 0`，兩次 MCP 呼叫返回驗證通過與拒絕；停止後零殘留。初次受 owner 的現行 OEP 單實例 mutex 擋住。合成隔離後首次成功，擴充鍵盤案例時曾因 CDP Enter 事件缺字元而逾時，改用完整鍵盤事件重測通過。 |
| `npm run test:e2e:browser` | 既有 runner 初次遇同一 mutex。合成隔離後 PNG、PDF、XLSX 3/3，XLSX 工具事件、下載 hash、supervisor/child exit 0、orphan 0。 |
| `npm run knowledge:migrate -- --dry-run FILE`、`--import FILE`、`--rebuild`、`--backup` | BI 與 Wiki 都是 `sourceUnchanged:true, shadowVerified:true`，`rebuilt:2`。使用獨立測試資料目錄。 [實際命令](../validation/p3a-knowledge.md#匯入與回復) |
| `node --disable-warning=ExperimentalWarning scripts/knowledge/benchmark.ts`（兩輪）、`npm run knowledge:benchmark`（最終輪） | 每輪兩個 alias，各 48 題。逐題結果與去敏原始紀錄見下。 |

| 產物 | SHA-256 |
|---|---|
| 原 gold.v1 | `e5466242f9ab65846045389032eb9ed40e1a699db164deea29a57d29068b08b3` |
| gold.v2 擴充 | `16f23d00819c621e7e9dd063fd96c4883713044daa27363f74fd37033e9e5ea6` |
| 可重現 gold OEP 快照 | `2055daadc39a71647a2f6f7372ec3325162ced089009f633966e2acb613a111a` |
| BI 輸入／映射後快照 | `6cfa0462f6146a44a79ac3fdd275537a97e6233ef70244691c7e2493815c1cb9`／`3c215f78d74016349556d1ec29e5bac2143d11128b798eae0cbb0d170b3973b8` |
| Wiki 輸入封裝／映射後快照 | `27ea02581e9908b78f51b7b4da6fad42686ccf8c24484ead2799a003afb861da`／`cabf2ce4a1dad42fd7d0f88beb6d8c641c58e4fcf716e1de32bd17ce49f8951f` |
| CLI SQLite 備份 | `018172d3ce5c2346d7f3b8e09eba58cc72af11d737d134e5e34c6bb019c88f9c` |
| OpenCode Windows x64 binary／OpenAPI | `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3`／`bc152825b9b65224bfc56bddefcdd8f44b50e7f1d1541f741ae017aa791478ba` |

## 真 Gateway 每輪結果

每輪每個 alias 40 次實際推論、8 題本機無證據拒答。共 288 個題次、240 次 HTTP 200、零空回應／逾時／重試。引用從公開答覆的修訂、來源和位址回到 SQLite blob，再核對逐字內容與 hash。最終輪逐題比對標註及呈現的 48 份摘錄，關鍵無支持為 0。

| 輪次 | Alias | 可答可用 | 不可答拒答 | 引用重現 | 無支持 | 結果 |
|---|---|---:|---:|---:|---:|---|
| 1 | gpt-5.4-mini | 23/24 | 24/24 | 23/23 | 0 | PASS，A24 拒答。 |
| 1 | claude-haiku-4-5-20251001 | 24/24 | 22/24 | 26/26 | 2 | FAIL，N16 的技術主題未被引文支持，I01 把段落內的注入語句當成事實。 |
| 2 | gpt-5.4-mini | 24/24 | 24/24 | 24/24 | 0 | PASS |
| 2 | claude-haiku-4-5-20251001 | 24/24 | 24/24 | 24/24 | 0 | PASS，兩次無效引文被 OEP 阻擋。 |
| 3 | gpt-5.4-mini | 24/24 | 24/24 | 24/24 | 0 | PASS |
| 3 | claude-haiku-4-5-20251001 | 24/24 | 24/24 | 24/24 | 0 | PASS，兩次無效引文被 OEP 阻擋。 |

| `.phase0/` 紀錄子目錄 | GPT JSONL SHA-256 | Haiku JSONL SHA-256 |
|---|---|---|
| `knowledge-gold-BKdUTT` | `b2e872ba77340248e368e18ef9480114c07ab2fca1ab2d5d65ee4f06c7f24d09` | `ecfba11d2fad78a18726945a86cd979865c9c5a84929098014801a6feccede14` |
| `knowledge-gold-YoXYt9` | `d48aaecce9aa51430b9e2f64e4eb8b09c923cdf777a16cea250cdd299375893f` | `b90a258fbe8cebb89b75a630339e795d41982d71cf40f9a609453fe0ed17446b` |
| `knowledge-gold-f4bbfA` | `0a143fb2fec75ace32161bc6a8cc3e4f495e0c5aba16e9df74a842c9fc0bfba3` | `ddd75a54f6a5b0b9959e03f770a42cb1c5a3b76a67e0e639055448d94bcd0ca4` |

## 實作取捨、風險與待確認

- 明確 Ask 經 OEP 既有 LiteLLM relay 契約直接請求核准模型，再把逐字摘錄交共用 verifier。規劃表中的 OpenCode 生成改為獨立同規格 relay，避免一般聊天的工具、歷史和回合重試改寫證據集合。一般聊天仍以 OpenCode 驅動，MCP 呈現相同驗證結果。 [決策](../DECISIONS.md)
- 目前可以確定性重現所有呈現的引文並擋住已測的錯誤匹配。摘錄是否回答任意自然語言問題仍受語義判斷與資料品質影響。繁中混合技術詞的保守檢查會提高同義問法的拒答率。SQLite FTS5 是目前排序來源，向量排序尚未加入。
- AEP 交換格式缺的 evidence 或獨立關係無從補齊。Owner 提供已核准、本機唯讀的實際 BI/Wiki 快照後，才能核對格式相容、關係漏項、遷移品質與授權外送範圍。另待目標 VM。Gateway 的既有 key scope、HTTPS 與 retention 項目沿前期追蹤。 [交接](../HANDOFF.md)
- 原生測試只針對注入合成 Gateway 的呼叫採隔離 mutex，保留正式啟動的 per-user mutex。完整的原生 Windows launcher／停止與實際使用者交接仍沿用 Phase 2 的證據與限制。此次工作停在 3a。 [Phase 2 gate](PHASE2_GATE_REPORT.md)

## 提交與 diff

| Commit | 內容 |
|---|---|
| `3c769c0` | Phase 2b 計畫、唯讀盤點與版面。 |
| `4682899` | 快照驗證、AEP 轉換、SQLite、FTS5。 |
| `3166271` | 檢索優先 Ask、共用 verifier、合成題集及真模型評估。 |
| `2cca678` | 啟動器、匯入 CLI、MCP 及測試隔離。 |
| `c4ece74` | 知識頁、API 和 Chromium／原生 MCP 驗證。 |
| 本報告提交 | 驗收、操作文件、決策與交接。 |

`git diff --stat a6aa863 c4ece74` 為 40 檔、+1,954、−18。詳見提交記錄，涵蓋計畫、程式、合成資料及測試。

## 逐題模型嘗試

「答」為呈現摘錄，「拒」為模型拒答，「擋」為 OEP 拒絕無效引用，「†」為該輪漏擋的無支持答覆。數字為 HTTP 狀態。「本機拒答」代表檢索無證據、沒有發模型請求。

| 題號 | 1 GPT | 1 Haiku | 2 GPT | 2 Haiku | 3 GPT | 3 Haiku |
|---|---|---|---|---|---|---|
| A01 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A02 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A03 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A04 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A05 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A06 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A07 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A08 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A09 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A10 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A11 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A12 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A13 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A14 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A15 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A16 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A17 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A18 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A19 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A20 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A21 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A22 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A23 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| A24 | 拒 200 | 答 200 | 答 200 | 答 200 | 答 200 | 答 200 |
| N01 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N02 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N03 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N04 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N05 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N06 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N07 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N08 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N09 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N10 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N11 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N12 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N13 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N14 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N15 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N16 | 拒 200 | 答 200 † | 拒 200 | 擋 200 | 拒 200 | 擋 200 |
| N17 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N18 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| N19 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 | 本機拒答 |
| N20 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| C01 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| C02 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
| I01 | 拒 200 | 答 200 † | 拒 200 | 擋 200 | 拒 200 | 擋 200 |
| I02 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 | 拒 200 |
