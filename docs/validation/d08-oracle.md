# D08 合成 SOP 與逐格 oracle 草案

**PROPOSED – awaiting owner approval**。目前僅為 Phase 0 提請核定的合成資料。Owner 本人核定後才可用於 Phase 1 E2E 驗收。Phase 1 編碼受 owner 核准修訂中的 Phase 0 gate 約束。

- [合成 SOP 文字](../../tests/fixtures/d08/sop.md) 與 [合成 SOP PDF](../../tests/fixtures/d08/sop.pdf) 以中、英文記錄相同資料和操作。
- [預期 XLSX](../../tests/fixtures/d08/expected.xlsx) 應依序包含 `Readings`、`Run`，共核對 13 格。 [機器可讀逐格 oracle](../../tests/fixtures/d08/oracle.json)
- 所有文字與布林值精確相等，數值的絕對容差為 0。`Readings` 電壓欄為小數，單位伏特，`Run` 計數欄為整數。額外工作表、欄列或公式均不屬提案。

Owner 請核對兩個 SOP 與 XLSX 的工作表順序、各格值及型別、電壓單位與容差，並確認皆為可公開的合成資料。 [可填寫範本](d08-oracle.template.md)
