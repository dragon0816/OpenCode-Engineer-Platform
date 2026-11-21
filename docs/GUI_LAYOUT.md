# OEP 工作台版面規格

2026-11-21（Asia/Taipei）。延續 Phase 2 的深藍頁首、淺底、圓角面板、系統字型與繁中操作文字。深色主題改用對應色票並保留相同的狀態層級。參考公開文件描述的操作方式，介面與資產由 OEP 獨立製作。

- Codex 以專案組織 threads，在工作時可檢視變更。 [Codex 發布說明](https://openai.com/index/introducing-the-codex-app/) · [Windows 版畫面說明](https://learn.chatgpt.com/docs/changelog?type=chatgpt-desktop-app)
- Claude Code Desktop 提供平行會話、輸入框附件、可切換的 diff 與工作區面板。 [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- T3 Code 提供 sidebar 專案篩選、輸入框的附件項目與可設定快捷鍵。 [Thread sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) · [Composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md) · [Keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md)

| 區域 | 從現有 Phase 2 介面演進 | 階段與驗收 |
|---|---|---|
| 左側導覽 | 將 `#sessions` 轉成依專案分組的 thread／session 清單，保留 `#new-session`，加入知識、工作、設定入口。窄螢幕可收合。 | 3a 加入知識入口。2b 用鍵盤建立並切換兩個專案的會話，重開保留選擇，跨會話附件與事件為零。 |
| 中央對話 | 延用 `.conversation` 與 `#messages`。串流逐步顯示，同一工具呼叫以可摺疊卡呈現開始、完成、失敗。 | 2b 用合成串流驗證逐步呈現、工具卡展收、重連對帳後事件無重複，以及切頁返回後可繼續追蹤。 |
| 底部輸入框 | 延用 `#composer`。把附件入口和已選檔案移到輸入區，加入 agent／model 選擇、送出與停止當回合。頂部的停止服務保有獨立語意。 | 2b 鍵盤操作附件、模型、送出與停止。停止後另一會話與服務仍可用。中文輸入法組字期間按 Enter 不送出。 |
| 右側或底部面板 | 由 `.files` 擴充檔案、產物、diff、工作。窄螢幕使用底部面板。 | 2b 從同一會話檢視附件、下載產物、展開合成 diff 與工作，核對 hash 和會話隔離。3b／4 以實際帳本替代示範狀態。 |
| 知識 | 左側進入、中央顯示版本概覽及 Ask，答案旁顯示來源、定位、引文及修訂。回到對話可繼續當前 session。 | 3a 驗證一個發布 vault 的有效回答、空庫與拒答，另以鍵盤操作 vault 選擇及返回對話。 |
| 設定與主題 | 設定由左側固定入口進入，依 [AEP 功能矩陣](AEP_GUI_PARITY.md) 收納。設定提供系統／淺色／深色。 | 2b 三種選項切換後核對可讀性與重開持久化。Tab 順序包含導覽、內容、輸入、面板。焦點可見，Esc 關閉浮層後回到開啟控制項。 |
