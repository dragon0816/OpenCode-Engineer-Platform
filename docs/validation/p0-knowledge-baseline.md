# Phase 0　知識文字匹配基線

固定資料集為 [`gold.v1.json`](../../tests/fixtures/knowledge/gold.v1.json)，LF SHA-256 `e5466242f9ab65846045389032eb9ed40e1a699db164deea29a57d29068b08b3`。30 個自製 passage 和 48 題，分為可答 24、無證據 20、互相矛盾 2、注入 2。題型含繁中、英文、中英混合、精確料號與短查詢。每段有合成 revision 與 locator。可答題記錄預期值和支持 passage。另三類預期不產生答案，矛盾及注入題保留相關 passage 供後續 verifier 測試。

執行 `node scripts/phase0/knowledge-baseline.ts`。字詞比對採 Unicode NFKC 和小寫，保留含連字號的英數 token，繁中取一字和兩字片段。段落分數為相同詞項的字元數總和，零分剔除，同分依 passage ID 排序。Recall@5 對每題用「前五名中預期 passage 數／全部預期 passage 數」計算，再平均 24 題。

| 量測 | 結果 |
|---|---:|
| Recall@5 | 100.00%（24/24），漏題 0 |
| 排序延遲 p50 | 0.0047 ms |
| 排序延遲 p95 | 0.0113 ms |

Windows 11 x64、Node 24.14.1，同程序暖機一輪後以記憶體索引循環 200 次，共 9,600 次查詢。延遲從切詞到 top 5 排序，排除讀檔、建索引與模型。此合成資料基線含直接文字重疊，不能推估真實檢索品質。拒答、引用、可用率、unsupported claim 及正式服務延遲依各 phase 驗收，AEP 對照需要核准的相同資料及可比的私有環境。
