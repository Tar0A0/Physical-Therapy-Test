# 物理治療師國考題庫練習系統 — 詳解規則、專案規範與避坑紀錄

本文件集中記錄本專案的**離線詳解規範**、開發過程中**必須避免的問題（避免的東西）**與**已確立的標準架構（固定的東西）**，供後續更新題庫、補齊詳解或調整前端功能時依循。

---

## 一、避免的東西（禁止事項與已排除的踩坑問題）

### 1. 不串接外部 AI API／不要求使用者輸入 API Key
- **禁止**在前端（`index.html`、`app.js`）要求使用者填寫 API Key 或即時呼叫 Vertex AI / Google AI Studio API。
- **原因**：使用者申請金鑰常遇到金鑰前綴差異（`AQ...` 與 `AIza...`）、GCP 專案未啟用 `aiplatform.googleapis.com`、或 IAM 缺少 `aiplatform.endpoints.predict` 權限等問題，導致測驗途中解析失敗。
- **替代作法**：全面改為離線內建逐選項詳解，並於交卷後及錯題簿提供「問問 Gemini（自動帶入詢問）」與「Gemini App（複製貼上）」外連輔助（見下方「固定的東西」）。

### 2. 避免圖片被水平分割或殘留深灰黑框
- **禁止水平分割呈現**：部分考選部 PDF（例如 115 年第一次、第二次）將單張附圖拆成多段水平條狀 XObject；嚴禁讓同一張圖片以多組 `[IMG:...]` 換行標籤分別渲染，否則畫面會產生斷裂、圓角切塊與上下空白間隙。
- **禁止殘留深灰陰影邊框**：部分圖片轉檔後四邊帶有深灰色背景與陰影（`rgb(22..42)`）；嚴禁未裁邊就直接拼接或顯示，必須先裁除四邊深灰邊框，並將混合縮放比例的條帶對齊寬度後，垂直無縫合併成單一張完整 PNG。

### 3. 避免 PDF 向量表格文字黏連、遺失格線
- **禁止**直接輸出 PDF 原始萃取出的黏連表格文字（例如 `<153153-170171-191>191`、`4555 65 75`）。
- **原因**：考選部試題 PDF 常以向量線段繪製表格框線，純文字擷取只會抓到沒有邊界分隔的文字。必須補回結構化表格語法並以格線表格呈現。

### 4. 避免採用未更正的原始答案
- **禁止**在考選部已公告「更正答案（MOD）」的情況下仍使用原始「答案」PDF 作為唯一標準答案，亦不可忽略「一律給分」或「多選均給分」規則。

### 5. 避免重建題庫時覆寫已修復的圖檔
- **禁止**在 `build-bank.js` 執行時無條件以 PDF 原始碎片覆寫 `img/` 資料夾內已經去框或拼接完成的 PNG 檔案（`extractImages()` 必須先檢查目標檔案是否已存在）。

---

## 二、固定的東西（詳解規則與標準架構）

### 1. 題庫範圍與標準答案規範
- **題庫規模**：收錄 **108 年第一次～115 年第二次**專技高考物理治療師考試共 16 次考試、6 大科目、合計 **7,680 題**（拆分為 96 個年度／科目 gzip 分塊）。
- **答案優先序**：`build-bank.js` 優先讀取「更正答案（MOD）」PDF；若無更正檔案才讀取「答案（ANS）」PDF。
- **多解與送分格式**：支援 `answers` 陣列儲存多個正確選項索引（包含全對一律給分），並於 `explain` 欄位固定註明考選部更正說明（例如 `考選部更正答案：...`）。

### 2. 離線逐選項詳解規則（`optionExplains`）
- **覆蓋規模**：全題庫 **7,680 題**、每題 4 個選項（共 **30,720 條**）皆配備繁體中文選項解析。
- **來源檔格式**：集中維護於 `option-explains.json`，鍵值格式為 `${exam}||${subject}||${num}`（例如 `115年第二次||神經疾病物理治療學||1`），值為長度 4 的字串陣列 `[optA解說, optB解說, optC解說, optD解說]`。
- **順序對齊**：陣列內的 4 條解析必須嚴格對應**原始試卷 A–D 選項順序**；前端啟用「選項順序也打亂」時，會由 `app.js` 依相同隨機索引 `order` 同步重排 `options` 與 `optionExplains`，確保批改時解析不會錯位。
- **寫作準則**：
  - 統一使用繁體中文，明確指出該選項為何正確或錯誤（包含核心機轉、鑑別診斷、治療原則或數值依據）。
  - 選項解析內若需附圖或數學式，沿用 `[IMG:...]`／`[IMG_INLINE:...]` 標籤，由 `fmt()` 統一渲染並過濾 HTML 跳脫。
  - 若遇更正多選或一律給分題，各選項解說應與最終公告答案及 `explain` 欄位一致，避免矛盾。
- **建置整合**：執行 `node build-bank.js` 時自動併入每題物件的 `optionExplains` 欄位，再輸出為 `data/chunks/*.json.gz` 與 `data/manifest.json`。

### 3. 交卷後顯示與測驗介面行為
- **作答期隱藏解析**：作答過程中不顯示任何對錯提示或選項詳解。
- **允許空白交卷與頁面內提示**：
  - 選項不設 `required` 限制，可跳過不會的題目；交卷時若有未作答題目，於頁面內橫幅 `#noticeBar` 提示「還有 N 題未作答」，並提供「前往第 X 題」與「仍要交卷」按鈕；空白題一律計為答錯並加入錯題簿。
  - 全站不使用原生 `alert()`／`confirm()`，統一透過 `#noticeBar` 顯示非阻斷式訊息與確認操作。
- **交卷後統一揭露**：按下「交卷」後，於每個選項下方顯示 `.opt-note` 區塊與標籤（`✔ 正解選項` 或 `✘ 選項解析`）及對應詳解；題目下方顯示整體對錯（或未作答）、更正備註與出處（`考試別・科目・第 N 題`），並提供「問問 Gemini（自動帶入詢問）」按鈕透過 `https://www.google.com/search?udm=50&q=...` 直接於 Google AI Mode（Gemini）自動帶入題目、選項、個人作答與正確答案發問，另提供「Gemini App（複製貼上）」按鈕同時複製題目至剪貼簿。
- **使用者舊資料提醒**：若使用者曾匯入自訂 CSV 題庫於 `localStorage`，點選「使用考畢題答題庫」即可重新載入內建分割題庫（`data/manifest.json` 與 `data/chunks/*.json.gz`）。

### 4. 圖片與表格固定處理機制
- **圖片標籤、解碼與合併**：
  - `build-bank.js` 支援 `/Indexed` 調色盤轉換、`/SMask` 透明遮罩疊合白底，以及過濾純白無意義的小型佔位圖（`<=40x40` 全白點陣圖），並透過 `collapseImgStrips()` 將題幹或單一選項內連續的 `[IMG:...]` 合併為首張 `[IMG:檔名.png]`（對應 `img/` 中已完成拼接與去框的單一完整 PNG）。
  - `app.js` 的 `fmt()` 同樣保留連續 `[IMG:...]` 合併處理作為防護，再轉為 `<img class="q-img">` 或 `<img class="q-img-inline">`。
- **表格語法與樣式**：
  - 向量表格題固定在 `build-bank.js` 的 `TABLE_OVERRIDES` 中以 Markdown 管線表格格式（`| 欄1 | 欄2 |`）維護（例如 `114年第一次 神經疾病物理治療學 Q12`、`115年第一次 神經疾病物理治療學 Q77`）。
  - `app.js` 的 `fmt()` 自動將管線表格區塊轉為 `<table class="q-table"><tbody>...</tbody></table>`，並套用 `style.css` 的 `.q-table` 實線邊框樣式渲染。

### 5. 題組綁定、隨機抽題與分塊按需載入
- **題組綁定**：題幹包含 `承上題`、`呈上題`、`同上題`、`依上題` 且同考試別與同科目者，在 `app.js` 的 `startQuiz()` 中固定以完整題組抽取，避免題目失去前題情境；錯題模式下也會自動載入同分塊並附上【前題題幹】。
- **避免重複抽題**：預設為「同份考卷／範圍抽完前不重複」，亦可選擇 1 小時～30 天或自訂小時數之時效內不重複，以及「不限制」。已抽題目時間戳記儲存於 `localStorage`（`seenQuestions`），首頁直接依 `data/manifest.json` 計算剩餘未抽題數（不需下載分塊），按「返回重選」中止測驗時自動還原該次已抽紀錄。
- **分塊與 PWA 快取策略**：
  - `data/manifest.json` 記錄所有 `(exam, subject)` 分塊索引與 `buildId`；各分塊以 gzip level 9 壓縮存放於 `data/chunks/*.json.gz`，瀏覽器透過 `DecompressionStream("gzip")` 即時解壓。
  - `sw.js` 對 `data/chunks/*.json.gz`（含 `?v=buildId`）與 `img/*` 採 Cache-First，對 App Shell 與 `data/manifest.json` 採 Network-First 並支援離線回退。

---

## 三、標準建置與同步維護流程

### 重建題庫標準指令
更新 `option-explains.json`、`TABLE_OVERRIDES` 或 PDF 題庫後，執行：
```powershell
node build-bank.js
```
執行後會自動保留 `img/` 中已處理完成的圖片，並重新輸出 `data/manifest.json` 與 `data/chunks/*.json.gz`。

### 自動串聯考選部 OpenData / 考畢試題平臺指令
直接指定考選部網址、考試代碼、年度或 OpenData CSV 自動抓取「專技高考_物理治療師」試題、答案與更正答案 PDF 並重建分割題庫：
```powershell
node sync-moex.js "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx?y=2025&e=114090"
# 亦支援年度自動探索、OpenData CSV 或整合 build-bank.js --sync：
node sync-moex.js --year 114
node sync-moex.js --opendata
node build-bank.js --sync "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx?y=2025&e=114090"
# 啟動本地同步與網頁伺服器（支援於網頁介面上直接一鍵同步）：
node sync-moex.js --serve
```
