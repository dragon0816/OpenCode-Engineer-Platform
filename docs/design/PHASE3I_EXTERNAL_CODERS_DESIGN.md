# Phase 3I 外部程式開發幫手設計

2026-11-23 · Windows 11 單人工作台 · 設計基準 `main` `cdfa78a`

Claude Code CLI 與 Codex CLI 各自預設關閉，只承接程式碼閱讀、修改與修補提案。使用者用自己的供應商帳號，資料只限已確認公開的公司資料。未分級與機密資料留在 OEP。Copilot 等條款確認後另案處理。3I 在 3B2 之後、3E 之前交付。外部幫手不取得對話模型、通道、排程、工作流程、系統管理或 Skill 執行的身分與權限。 [Phase 3 需求 §4.3、§7 D2、§10](../PHASE3_REQUIREMENTS.md) · [擁有者決議](../DECISIONS.md#2026-11-22-phase-3-擁有者決議)

## 1. 從主助理交辦

建議在現有交辦路徑加入兩個由 OEP 設定的 `specialist` 目標，用獨立的執行類型 `claude_code`、`codex_cli` 選擇後端。3B 的單一 OpenCode runtime 繼續服務既有助理，外部 CLI 由 `DelegationService` 的專用 worker 接手。比照 BI 的領域執行分支，每件有獨立的 `origin=delegation` 會話、子 run、租約和收據，無需呼叫 `chat.submit()` 或建立 OpenCode upstream session。派送、去重、預算、取消、恢復、通知與匯出共用 3B 機制。若另開模型工具直接跑 CLI，就要另外實作同一套資料核准、耐久工作與結果對帳，也容易讓外送與既有一層交辦使用不同的授權規則。 [3B 設計 §3、§5、§6](PHASE3B_MULTI_AGENT_DESIGN.md) · [切片 5 驗收](../reviews/PHASE3B_SLICE5_REPORT.md) · [DelegationService](../../apps/adapter/src/runs/delegation.ts)

- 保留 `agents.role`，以 OEP 管理的設定關聯目標 ID、執行類型與版本。`oep_list_specialists` 只向 Web 主助理列出可用的外部目標，並標明外送。`oep_delegate_to_specialist` 新增僅限外部目標的封閉參數 `{specialistId, publicInputId, requestKey}`。現行一般專職及 BI 的 `task`／`attachmentIds` 契約照常使用。目標類型由伺服器判定，外部分支拒收自由文字、任意 CLI 旗標、路徑或額外資料。
- 沿用 SSE broker 的一次性工具票券、活躍主助理角色、持久化父 run、直接工作租約及本回合範圍檢查。`publicInputId` 由已配對的 Web 擁有者建立，須綁定本次父會話／run、供應商與固定內容。Telegram、排程、通知和外部子 run 都無法發起外部交辦。外部目標也不接受直接對話、通道綁定或後續轉交。
- 工具只回接單收據。需要逐次確認時，意圖及確認狀態先留在父對話的交辦卡，依 `queueMs` 到期，確認前不可領取租約。已配對擁有者確認後方可派送。一次性確認綁定供應商、run、來源清單摘要與設定 revision。重送依既有父 run 與 `requestKey`／內容去重，內容摘要包含 `publicInputId` 的已核准版本和來源雜湊。更換任何內容須建立新版本，舊核准失效。 [broker](../../apps/adapter/src/opencode/broker-mcp.ts) · [權限](../../apps/adapter/src/opencode/permissions.ts) · [交辦台帳](../../apps/adapter/src/runs/delegation-ledger.ts)

## 2. CLI 契約與安裝狀態

下列為 2026-11-23 核對官方文件後的候選契約。固定版的旗標組合、Windows 隔離下的登入與輸出格式，均須在實作時驗證。

| 幫手 | 非互動執行 | 登入檢測 |
| --- | --- | --- |
| Claude Code | `claude --print --input-format text --output-format json --no-session-persistence --safe-mode --restricted --permission-mode dontAsk --tools Read,Glob,Grep,Edit,Write --allowedTools Read,Glob,Grep,Edit,Write --disallowedTools "mcp__*" --max-turns <n>`。從 `stdin` 讀入固定任務，停用 Shell、子代理及瀏覽器工具。`--restricted` 約束檔案工具範圍，`--safe-mode` 停用自訂內容且保留原生登入。受管 hooks 仍可能生效，啟用前要驗證有效設定。`--bare` 會略過訂閱 OAuth 與系統金鑰圈，故此執行方式採 `--safe-mode`。`--max-budget-usd` 可在已核准計費方式加上估算上限，實際費用仍取決於供應商。 [非互動模式](https://code.claude.com/docs/en/headless) · [CLI 參考](https://code.claude.com/docs/en/cli-reference) | 使用者在專用 Windows 身分下以原版 `claude auth login` 登入。`claude auth status` 回傳 JSON，登入為 exit `0`，未登入為 `1`。OEP 僅採已知登入狀態及核准的驗證類型，丟棄其他欄位。 [驗證方式](https://code.claude.com/docs/en/iam) · [CLI 參考](https://code.claude.com/docs/en/cli-reference) |
| Codex | `codex --ask-for-approval never exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox workspace-write --skip-git-repo-check -`。`-` 從 `stdin` 讀入任務，`--json` 用 JSONL。透過固定 `-c` 組合停用 hooks、plugins、apps、memories、goals、multi-agent 和 web search，設定 `sandbox_workspace_write.network_access=false`，驗證 MCP、Skill 與專案設定皆未載入。停用命令提權，Windows sandbox 只接受驗證過且能阻擋工作區外讀取和命令連網的設定。 [非互動模式](https://learn.chatgpt.com/docs/non-interactive-mode) · [CLI 參考](https://learn.chatgpt.com/docs/developer-commands?surface=cli) · [設定參考](https://learn.chatgpt.com/docs/config-file/config-reference) · [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) | 使用者以原版 `codex login` 登入自己的 ChatGPT 帳號。需要時可在供應商允許的帳號上使用 `codex login --device-auth`。`codex login status` 以 exit `0` 表示已有驗證資料，並報告類型。固定版以相同專用 `CODEX_HOME` 和 `cli_auth_credentials_store="keyring"` 檢測與執行，核對 ChatGPT 模式。 [驗證方式與憑證儲存](https://learn.chatgpt.com/docs/auth) · [CLI 參考](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |

- 可從受信任安裝位置偵測候選程式，或由擁有者選取官方原生 `.exe`。只用經驗證的絕對路徑與獨立 argv，拒用 PATH 上的 shim、`.cmd`、任意 shell 或工作資料夾內的程式。比對 Windows 架構、來源、版本和發行雜湊／簽章，將通過驗證的版本與參數規格固定在 adapter 支援清單。探測 `--version`，在驗收機比對 `--help` 與真實輸出格式。執行前重驗檔案身分與版本，即使登入仍有效，版本或位元組改變也須再驗證。OEP 由擁有者自行安裝或更新的版本中辨識合格版本，執行期間停用更新流量。
- 版本及狀態探測使用乾淨的空白目錄、同一隔離身分和有限輸出／時間。原始 JSON、stdout、stderr、帳號名稱、登入 URL、使用者路徑及憑證皆不寫入 OEP 診斷。OEP 不開啟 `auth.json`、Claude 憑證檔或 Windows Credential Manager 查詢憑證。檢測僅表示 CLI 報告有登入狀態，權限、到期、訂閱額度以實際執行的受控錯誤碼處理。
- Claude 上架需核對 Anthropic 對產品內執行原版 binary 的 Commercial Terms，以及原生登入與用量歸屬是否適用於 OEP。官方允許的原版使用者自行登入，與第三方代登入、代付或中介請求有不同條件。OEP 僅呼叫原版 CLI，靠供應商原生流程完成登入和計費。若這個使用情境尚未確認，該幫手保持停用。Codex 也使用原生登入與官方非互動入口，依使用者的方案條款。 [Anthropic 使用條件](https://code.claude.com/docs/en/legal-and-compliance) · [OpenAI 使用條款](https://openai.com/policies/terms-of-use/) · [Codex 非互動驗證](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)

## 3. 外送前分級檢查

在擁有者工作台建立一份固定輸入清單，項目含原樣任務、專案所選檔案、附件、指定的已驗證知識引用與衍生內容。OEP 用檔案 ID、工作區 ID、內容雜湊與來源關係解析資料。CLI 只收到核准位元組和必要的相對路徑，不載入父對話、系統提示、摘要歷史、其他助理資料、知識庫目錄或機器路徑。檔名、引用顯示文字、任務標題等附帶文字也屬於核准內容。

| 輸入 | 必須查核的證據 |
| --- | --- |
| 工作區與檔案 | 來源工作區及外部目標的受管工作區須具 `agent_workspaces.classification=public`。每份選取的工作檔以 `file_classifications(file_kind, file_id, workspace_id, sha256)` 核對當前版本，任何工作區或檔案標記未達 `public` 就拒絕。用 owner-selected 專案清單匯入；目錄標公開不涵蓋未檢查的檔案。 |
| 附件、產物、交接副本 | 用 `AttachmentService`／驗證匯出核對本回合的存取權、來源與位元組；沿來源鏈檢查每個工作區與檔案。衍生投影是獨立位元組，核對其雜湊與原始來源，權限取交集。不得藉匯入到公開區改寫原分類。 |
| 知識引用 | `vault_classifications.vault_id` 必須是 `public`，且父會話有讀權、發布與模型使用同意有效。以已驗證的活躍發布版本、引用 ID、摘錄雜湊和原始來源核對，只匯入已選的摘錄與必要出處。少一項證據或來源便擋下。 |
| 任務、摘要、轉譯與其他衍生內容 | 任務以擁有者輸入或審閱的定稿建立本機不可變文字紀錄，以 `artifact` 分類索引相同雜湊，引用已知來源。任何從模型、工具、舊訊息或其他資料衍生的內容須有可追溯的來源集合，遞迴檢查到根。來源缺漏、未知或循環均擋下。任務由模型起草時，未證明來源前不得把草稿當成擁有者原創內容。 |

有效標記採 `confidential > unclassified > public`，缺列、舊資料、格式未知、讀取失敗與雜湊不符視同未分級或不合格。3B 目前已有工作區與附件合併判定以及知識分類表，3I 補齊工作檔／文字 ID、衍生來源、引用與外送快照，不能沿用一般交辦的結果標記直接放行。擁有者可透過已配對工作台對選定來源版本執行「標記為公開」，畫面顯示範圍、內容與警示。只可用於確認可公開的資料，無法用此動作覆寫機密來源或為來源缺漏的內容補一張通行證。重新分類既有機密資料需在 OEP 外先完成公司的正式解密或公開發布程序，再選那個可公開版本。 [3B 分級設計](PHASE3B_MULTI_AGENT_DESIGN.md#6-直接對話共享資料與機密欄位) · [工作區及檔案 schema](../../apps/adapter/migrations/003_agent_ledger.sql) · [知識 schema](../../packages/knowledge/src/store.ts) · [切片 2b 驗收](../reviews/PHASE3B_SLICE2B_REPORT.md)

1. 建立快照時先核對權限、來源與分級，以固定位元組和標記版本產生清單摘要。任何選取項目不合格就整筆擋下，在本機列出原因，擁有者移除不合格資料或更新來源後再送。
2. 領取後再開檔、核對檔案身分／SHA-256、發布版本與分級，並核對供應商啟用及確認 revision。準備好副本後，啟動前在 Adapter 內序列化「檢查並啟動」與分級、來源授權及供應商設定變更。用分類／授權版本與已固定的副本避免以舊快照放行。先寫入持久啟動意圖及 `pass` 收據才開放 `stdin` 和執行；任何失敗先記 `blocked` 和原因碼，CLI 不接收任務。執行中撤銷時立即撤銷 egress、停止 Job 並記錄是否可能已送出。已送出的資料無法收回。
3. 在 `delegation_events` 記檢查階段、結果、原因碼、分類項目數、policy revision 和關聯 ID。詳細清單、來源 ID／雜湊及確認收據在擁有者專用台帳，診斷日誌不寫清單內容、檔名、任務、引用全文、絕對路徑或機密值。 [現有稽核與交接](../../apps/adapter/src/runs/delegation-ledger.ts)

## 4. 每次執行的工作副本與交付

在目標助理的 managed root 下為每個 `runId` 建立 `external/<runId>/`。以經 `scopedPath()`、Windows handle-based 查核及 SHA-256 驗證的新副本建立 `work/`，由 OEP 另外保存私有基線 manifest 與必要的基線位元組，供差異與衝突判定。首版選擇逐檔複製；Git worktree 會連回原始 `.git` 並可能讀取物件、歷史、其他 refs 與設定。只複製通過清單的資料，排除 `.git`、供應商啟動設定、指示檔、hooks、MCP 設定、憑證檔與未選取的隱藏檔。`work/` 作為 `cwd`，只授權讀取其快照、唯讀附件／引用目錄及必要 runtime，寫入只在 `work/` 的輸出範圍與此 run 的 scratch。ACL 固定工作根與附件區，父目錄與其他 run 不可列舉。拒絕重解析點、junction、symlink、hard link、ADS、UNC、保留名、短名別名與大小寫碰撞。 [Workspace 路徑驗證](../../apps/adapter/src/runs/workspace.ts) · [Windows 寫入](../../apps/adapter/src/runs/workspace-write.ts)

1. 正常退出、結束訊號核對且 Job 無成員後，OEP 以保存的基線和 handle 驗證的最終檔案計算新增、修改及刪除。首版只支援 UTF-8 文字。更名以刪除加新增表示，拒絕二進位、特殊檔與被保留路徑的變更。檔案身分、大小、類型與雜湊由 OEP 驗證，CLI 的自報檔名或 patch 只當說明。
2. 透過 `DelegationHandoff.export()`、outbound manifest 和 `readExport()` 回傳 `changes.patch`、`changed-files.json` 與至多 2,000 字元摘要。前者是 unified diff，後者是相對路徑、操作、前後 SHA-256 及新增／修改檔的完整 UTF-8 文字，保留原始換行及 BOM，刪除只留操作與原始雜湊。兩份匯出是已驗證的 `text/plain`，沿用單檔 20 MiB 及每件 4 份／40 MiB 上限，計入 JSON 編碼開銷。超限整件回錯誤，無部分交付。無改動須能產生空的變更清單與明確摘要。外部結果以來源集合及 `unclassified` 保存，重新外送前須再次審閱及分級。核對過的摘要與檔案 ID 才可出現在原工作台對話，後續回合不得直接把它們當作已准外送資料。 [驗證匯出](../../apps/adapter/src/runs/delegation-handoff.ts) · [切片 6 結果](../reviews/PHASE3B_SLICE6_REPORT.md)
3. 擁有者在右區看 diff、逐檔下載或下載 patch，再在自己的目標工作區明確套用。首版建議手動套用，由畫面顯示基線雜湊與目標變動警示，便於擁有者先確認一致。任何未來的工作台套用功能須另外做目的地授權、基線衝突檢查與全有或全無的提交。CLI 路徑本身無法修改原工作區、git refs 或匯出副本。

## 5. Windows 隔離、連線與生命週期

- **OS 權限。** 每個供應商有獨立非管理員 Windows 身分和乾淨登入設定檔。工作程序用 restricted token 的額外限制 SID、ACL 和受控桌面啟動，檔案允許清單僅含已驗證的系統 runtime、唯讀 CLI、該供應商原生登入所需狀態和本次資料夾。普通帳戶或 `cwd` 遇到主機開放讀權仍可能讀到資料，因此須實測 OEP 根、Vault、宿主設定檔、其他助理路徑、Registry、程序 handle、具服務權限的 IPC 及網路共享均不可讀。Codex 的 model shell 另由可驗證的 Windows sandbox 限讀寫及斷網，自己的登入儲存也不得由 model shell 取得。Claude 首版僅用檔案工具，且封鎖繼承 hook 或受管設定的額外執行。任何 ACL、登入儲存或沙箱證據不成立，該 adapter 禁用。 [Windows restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens) · [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- **程序與環境。** 參考現有 launcher supervisor，替每次執行用 `CREATE_SUSPENDED` 建立程序，加入帶 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job 後再恢復。禁止 breakaway，只繼承指定 pipes，限制成員數、CPU、記憶體、輸出與 scratch 大小。若需獨立 Windows 身分與 egress 授權，由管理員配置受控 launcher，透過設 ACL 的 IPC 只受理已配對 OEP 身分的既定供應商／run 動作，由 launcher 驗證範圍、組裝固定 argv、持有 Job 並監看 Adapter 結束。介面不接受任意執行檔、命令或環境，OS 身分交由 Windows 管理。若已有上層 Job，需先驗證巢狀 Job 與 Codex Windows sandbox 啟動的子程序都在受控邊界內。環境從空集合建立，只給 `SystemRoot` 等必要 OS 值、固定唯讀 `PATH`、本次 `TEMP`／`TMP`、專用 Windows 設定檔及對應 `CLAUDE_CONFIG_DIR`／`CODEX_HOME`。不繼承 OEP 變數、Gateway key、MCP 票券、Telegram／Git／SSH／雲端憑證、代理設定或另一供應商的登入資料。登入由供應商 CLI 在獨立設定檔處理，與 OEP 的工作程序及資料庫分離。 [現有 launcher](../../apps/launcher/src/job-object.ts) · [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- **網路。** 首版僅在可部署且驗證 OS egress 規則的 Windows 11 主機啟用。以 WFP 按專用 SID 與受信任 CLI 程序身分實施預設拒絕，所有子程序、Loopback、區網、SMB、未核准 DNS 和任意網路皆禁止。供應商 CLI 只可用 HTTPS／WSS 連固定版核准的供應商端點。以獨立的受管網路政策檢查 TLS 主機名，拒絕目的 IP 直連與共用 IP 上的其他主機名，僅允許核准的 DNS 解析。WFP 的 IP 條件本身不足以驗證主機名，選用的網路政策須有可驗證的主機名過濾。TLS 端到端由 CLI 和供應商處理，OEP 不終止 TLS、不代送要求或代管秘密。Claude 執行候選端點包括 `api.anthropic.com` 和更新登入所需的 `platform.claude.com`，Codex 包括 `chatgpt.com` 的 HTTPS／WSS 及必要的 OpenAI 驗證端點。依固定版實測縮減，互動登入所需的暫時額外通路與 run 分開。若端點、主機名或防火牆規則驗證失敗，顯示隔離未就緒。 [WFP](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-start-page) · [Anthropic 網路需求](https://code.claude.com/docs/en/network-config#network-access-requirements) · [OpenAI 網路需求](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)
- **預算。** 沿用 `delegationsPerMessage`、預留與結算、`queueMs`，自 worker 領取起套 `min(reservedMs, turnLimits.timeoutSeconds * 1000)` 毫秒，含驗證、複製、執行及輸出查核。預設 3 件、每件 300 秒預留，既有 105 秒回合預設會先截斷。首版每件僅一次 CLI 啟動，禁止自動重試／續跑。在開放程序執行前以同一持久啟動意圖將該件全部預留的請求／工具額度記為扣抵，與內部交辦共用父訊息配額。確認未啟動才釋出未用額度。回合工具上限為零時不啟動。Claude 另外以 `--max-turns` 採請求預留與回合工具上限的較低值。CLI 內部模型請求、工具與自動重試無法像 3B relay 一樣逐次事前計量，輸出事件只供觀測，不能當成硬限額或帳單。若產品要求逐請求硬上限，須先有供應商可驗證的控制能力再啟用該 adapter。 [交辦預算欄位](../../apps/adapter/src/runs/delegation-ledger.ts) · [回合限制](../../apps/adapter/src/opencode/turn-limits.ts) · [決策紀錄](../DECISIONS.md#2026-11-23-交辦切片-5-的執行與-bi-歸屬)
- **取消與恢復。** 取消、逾時、停用、撤銷或關閉服務，都先停止送入資料並撤銷該 run 的連線權限，再終止 Job 並確認活程序數為零。已驗證且已落地的成果沿用 3B 的 late cancel 保留語意。程序／網路狀態或交付不確定時以 `indeterminate` 保留租約；重開後核對持久啟動意圖、Job 收據、匯出 manifest 和 run 綁定，避免重送。未完成或遭破壞的輸出不發布。已證實停止後由 OEP 依受管根、run ID 及目錄身分回收副本和 scratch。清理遇到不一致即隔離，不能沿連結刪除，不能憑回收的 PID 終止其他程序。核對並保存清理結果後才釋放租約。
- **稽核。** 只留所需的 run／交辦 ID、CLI 版本、設定／gate revision、時間、固定錯誤碼、配額、Job 成員與清理結果。對 CLI stdout／stderr 做有上限的記憶體解析，僅擷取白名單狀態與有界摘要，拒絕控制碼與主機私有路徑。保留的摘要和 diff 走擁有者受控記錄，原始代理對話、命令、模型推理、token、憑證及私人內容不進診斷。 [切片 5 驗收](../reviews/PHASE3B_SLICE5_REPORT.md)

## 6. 工作台與雙語

- **設定 > 外部幫手。** Claude Code、Codex 各有啟用開關、固定版和已安裝版本、重新檢查及登入說明。狀態區分未安裝、版本不支援、未登入、登入檢查失敗、隔離未就緒與可用。啟用時提醒「選取並核准的公開資料會傳送至 {provider}。使用你自己的帳號，可能耗用訂閱額度或產生費用。」每個幫手可設定「每次送出前確認」，預設開啟。關閉確認只省略額外對話框，選取、分級和版本檢查仍必須通過。
- **主對話。** 透過已配對 Web 建立及預覽公開輸入清單。確認卡顯示供應商、定稿、相對檔名與數量、引用選取範圍、容量、用途、核准或取消。也可在原畫面查看已擋下的項目，並在適用時「標記為公開」。完成卡呈現送出狀態、摘要、變更數、下載與「查看差異」。沿用切片 6 的原會話結果卡、未讀、SSE 更新與持久重讀。
- **右區。** 沿用只讀 run detail 的「差異」頁籤，提供新增／修改／刪除狀態、逐檔 unified diff、核對基線及已驗證下載。以純文字渲染不可信內容，窄畫面使用現有 overlay 與焦點管理。確認與取消沿用已配對工作台及 CSRF 驗證。 [切片 6 驗收](../reviews/PHASE3B_SLICE6_REPORT.md) · [結果介面](../../apps/web/src/delegations.js)
- **i18n。** `zh-TW.js` 與 `en.js` 同時加入 `externalHelpers.settings.title`、`externalHelpers.settings.enabled`、`externalHelpers.settings.confirmEachRun`、`externalHelpers.warning`、`externalHelpers.status.{missing,unsupported,signedOut,probeFailed,isolationUnavailable,ready}`、`externalHelpers.confirm.{title,send,cancel,expired}`、`externalHelpers.gate.{unclassified,confidential,changed,provenanceMissing,markPublic}`、`externalHelpers.result.{diff,downloadPatch,downloadFile,noChanges,baseChanged}`。共用 `delegations.status.*`，新增外部原因碼的雙語映射。 [繁中語言檔](../../apps/web/src/i18n/zh-TW.js) · [英文語言檔](../../apps/web/src/i18n/en.js)

## 7. 驗收與測試計畫

自動化只用合成來源、獨立臨時資料根、fake Claude／Codex 和可控網路替身。假 CLI 按固定版協定產生輸出並記錄測試觀察值。網路和 Windows 權限用真實 Windows 11 隔離路徑執行合成探測。測試不載入真實帳號、憑證、資料根或 OEP 程序。

| 測試 | 驗收條件 |
| --- | --- |
| 權限與分類 | 只有有效 Web 主助理票券能使用本回合的 `publicInputId`。一般交辦與 BI 的測試照常通過。缺分類、任一機密來源、過期發布、未知衍生內容、附檔換位元組、啟動前撤銷及過期確認都先留下原因碼，假 CLI 工作程序啟動計數和供應商端點呼叫均為零。跨父會話或以原始 `task` 繞過須失敗。 |
| Windows 邊界與旗標 | 合成探測可讀本次公開快照、可寫 `work/`，拒絕讀原根、其他 run／帳號、私人 Registry／管線、憑證和各種連結。假 CLI 用測試標記驗證環境白名單、`stdin`、旗標、失敗退出碼、破損 JSON、輸出洪流。嘗試被拒的主機、直連 IP、同 IP 不同主機名、子程序網路、IPv6、loopback 和設定覆寫均不得通行。只允許核准的合成端點。 |
| 租約、恢復與成果 | 同鍵和同內容只啟動一次，滿額與排隊逾期均不啟動。覆蓋取消、逾時、撤銷、父程序崩潰、子程序留存、交付與取消競態、重啟清理及未知狀態不重送。拒收越界、競態替換、非 UTF-8、超限與雜湊遭改的輸出。驗證 patch、完整檔內容、刪除、基線和無變更情況。所有終止情境須確認零孤兒，未知狀態不得偽報為已清理。 |
| 工作台雙語 | 兩幫手獨立開關、提示、阻擋原因、取消、確認後才啟動與關閉額外確認的行為均驗證。從同一父對話重連後開結果卡與右區 diff，雜湊一致，未配對或跨會話請求拒絕。寬／窄視窗鍵盤可操作。下載或預覽原始工作區維持基線雜湊。 |

選做真帳號驗證時，只在擁有者同意的獨立 Windows 11 測試環境，用經條款確認的自有帳號與全公開合成程式。逐一確認原生登入、狀態探測、固定旗標、驗證續期端點、單一小修補、下載、手動套用與登出。僅保存版本、結果、耗時、狀態碼與必要端點名稱。可用於帳號的功能若尚未經隔離與條款驗證，維持停用。Fake CLI 只能證明 OEP 契約與測得的 OS 邊界，原生版本組合與登入相容性須另外以供應商 CLI 驗證。

## 8. 實作切片

| 切片 | 交付與完成條件 |
| --- | --- |
| 3I-1 分級與交辦接單 | 加入唯擁有者可操作的分類、來源清單與快照版本、外部目標、封閉 schema 和預算接單。以假 worker 證實每個已擋下的輸入零啟動，核准挑戰綁定正確，3B 舊資料升級仍為未分級且內部交辦可用。 |
| 3I-2 Windows supervisor 與兩家 CLI | 在合成環境完成專用身分、Job、環境、端點、版號、登入探測及額度契約。實測 ACL、網路負例、崩潰清理與無自動重送。每個供應商分開驗收與解鎖，缺任一隔離或版本相容證據時維持停用。 |
| 3I-3 結果匯出與雙語工作台 | 完成兩幫手設定、確認卡、分級操作、已驗證匯出、右區 diff、稽核與恢復。使用兩款 fake CLI 從 Web 主對話完成全流程，驗證原檔不變以及已完成結果可重新讀取。依各供應商的隔離、原生 CLI 相容與條款結果決定上架狀態。 |

## 9. 風險與擁有者待決

- 分級取決於人員、來源記錄與所選版本的正確性。預覽實際外送位元組、使用保守繼承、拒絕未知來源，並對常見憑證檔及敏感模式作額外阻擋。撤銷可停止後續通訊，無法撤回既有外送。
- CLI 更新可能改變自動載入、沙箱、登入、端點或事件格式。個別固定版本，升級須重跑該供應商驗收。使用者帳號有供應商計費與保留規則，OEP 能限制本機時間及配額，無法承諾遠端成本或立即刪除資料。外部結果仍需擁有者審閱，可能包含不正確或不安全的程式碼。

| 擁有者待決 | 建議預設 |
| --- | --- |
| 是否接受初次啟用需 Windows 管理員或 IT 配置獨立執行身分、ACL 與可驗證的網路政策？ | 接受一次性配置。無法完成配置的主機保持停用。 |
| 額外的逐次確認應預設開啟，還是由擁有者自行開啟？ | 每家預設開啟，允許明確關閉。關閉也需指定資料並通過原有分級和版本檢查。 |
| 首版是否提供工作台內「套用」？ | 首版只交付可檢視和下載的差異，由擁有者手動套用。若日後需要在工作台套用，再實作基線與交易寫入。 |
| Claude Code 在 OEP 的使用依哪種供應商商業安排與自有帳號方案？ | 先確認原版 CLI、自行登入、直接計費適用的商業安排與方案；未確認前 Claude 維持停用，Codex 可獨立驗收。 |
