const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const BASE = __dirname;
const BANK_ROOT = path.join(BASE, "題庫");
const MOEX_BASE_URL = "https://wwwq.moex.gov.tw/exam/";
const MOEX_SEARCH_URL = "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx";
const MOEX_OPENDATA_CSV_URL = "https://wwwc.moex.gov.tw/main/Exam/wHandExamQandA_CSV.ashx";
const DEFAULT_MOEX_URL = "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx?y=2025&e=114090";

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeYear(y) {
  const n = parseInt(String(y || "").trim(), 10);
  if (!n || Number.isNaN(n)) return "";
  return String(n < 1911 ? n + 1911 : n);
}

function yearFromExamCode(examCode) {
  const code = String(examCode || "").trim();
  if (!/^\d{5,6}$/.test(code)) return "";
  const roc = parseInt(code.slice(0, code.length === 5 ? 2 : 3), 10);
  return String(roc + 1911);
}

function parseTargetInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return { mode: "exam", y: "2025", e: "114090", url: DEFAULT_MOEX_URL };

  if (/^https?:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`無法解析網址：${raw}`);
    }
    if (!/(^|\.)moex\.gov\.tw$/i.test(u.hostname)) {
      throw new Error(`僅支援考選部官方網域（*.moex.gov.tw），收到：${u.hostname}`);
    }
    if (/wHandExamQandA_CSV\.ashx/i.test(u.pathname)) {
      return { mode: "opendata", url: u.href };
    }
    const e = (u.searchParams.get("e") || "").trim();
    const yParam = normalizeYear(u.searchParams.get("y"));
    const y = yParam || yearFromExamCode(e);
    if (e) {
      if (!/^\d{5,6}$/.test(e)) throw new Error(`考試代碼格式不正確：${e}`);
      return { mode: "exam", y, e, url: `${MOEX_SEARCH_URL}?y=${y}&e=${e}` };
    }
    if (y) {
      return { mode: "year", y, url: `${MOEX_SEARCH_URL}?y=${y}` };
    }
    throw new Error(`網址缺少考試年度 y 或考試代碼 e 參數：${raw}`);
  }

  if (/^\d{5,6}$/.test(raw)) {
    const y = yearFromExamCode(raw);
    return { mode: "exam", y, e: raw, url: `${MOEX_SEARCH_URL}?y=${y}&e=${raw}` };
  }

  if (/^\d{2,4}$/.test(raw)) {
    const y = normalizeYear(raw);
    return { mode: "year", y, url: `${MOEX_SEARCH_URL}?y=${y}` };
  }

  throw new Error(`不支援的輸入格式：${raw}`);
}

function fetchBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === "https:" ? https : http;
    const req = client.get(
      u,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": MOEX_SEARCH_URL,
          "Accept": "text/html,application/pdf,text/csv,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, u).href;
          resolve(fetchBuffer(nextUrl, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} 下載失敗：${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`連線逾時：${url}`));
    });
    req.on("error", reject);
  });
}

function parseExamListFromYearPage(html) {
  const exams = [];
  const selectMatch = html.match(/<select[^>]*id="ctl00_holderContent_ddlExamCode"[^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) return exams;
  for (const m of selectMatch[1].matchAll(/<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const e = m[1].trim();
    const title = decodeHtmlEntities(m[2]).replace(/\s+/g, " ").trim();
    if (title.includes("物理治療師")) {
      exams.push({ e, y: yearFromExamCode(e), title });
    }
  }
  return exams;
}

function parseMoexExamPage(html, fallbackExamCode = "") {
  const level1Match = html.match(/<td class="level1">[\s\S]*?<td class="link_1Ua"><\/td><td[^>]*>([\s\S]*?)<\/td>/i);
  const examTitle = level1Match ? decodeHtmlEntities(level1Match[1]).replace(/\s+/g, " ").trim() : "";

  const categories = [];
  for (const m of html.matchAll(/<label\s+for="ctl00_holderContent_chk_(\d+)_(\d+)">([\s\S]*?)<\/label>/gi)) {
    const examCode = m[1];
    const classCode = m[2];
    const categoryTitle = decodeHtmlEntities(m[3]).replace(/\s+/g, " ").trim();
    if (categoryTitle.includes("物理治療師")) {
      categories.push({ examCode, classCode, categoryTitle });
    }
  }

  if (!categories.length) {
    return { examTitle, examCode: fallbackExamCode, categories: [], subjects: [] };
  }

  const subjects = [];
  for (const cat of categories) {
    const rowRe = new RegExp(
      `id="ctl00_holderContent_chk_${cat.examCode}_${cat.classCode}_(\\d+)"([\\s\\S]*?)<\\/tr>`,
      "gi"
    );
    for (const rm of html.matchAll(rowRe)) {
      const subCode = rm[1];
      const rowHtml = rm[2];
      const labelMatch = rowHtml.match(/class="exam-title">([\s\S]*?)<\/label>/i);
      const subject = labelMatch ? decodeHtmlEntities(labelMatch[1]).replace(/\s+/g, " ").trim() : "";
      const links = {};
      for (const lm of rowHtml.matchAll(/href="(wHandExamQandA_File\.ashx\?t=([QSM])[^"]*)"/gi)) {
        const type = lm[2].toUpperCase();
        if (!links[type]) {
          links[type] = new URL(decodeHtmlEntities(lm[1]), MOEX_BASE_URL).href;
        }
      }
      if (subject && links.Q && links.S) {
        subjects.push({
          examCode: cat.examCode,
          classCode: cat.classCode,
          categoryTitle: cat.categoryTitle,
          subCode,
          subject,
          qUrl: links.Q,
          sUrl: links.S,
          mUrl: links.M || null,
        });
      }
    }
  }

  return {
    examTitle,
    examCode: categories[0].examCode || fallbackExamCode,
    categories,
    subjects,
  };
}

function parseOpenDataCsv(csvText) {
  const clean = csvText.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows[0] || [];
  const idxOf = (name, fallback) => {
    const i = header.findIndex((h) => h.trim() === name);
    return i >= 0 ? i : fallback;
  };
  const iYear = idxOf("考試年度", 0);
  const iCode = idxOf("考試代碼", 1);
  const iTitle = idxOf("考試名稱", 2);
  const iCat = idxOf("類科組別", 7);

  const found = new Map();
  for (let idx = 1; idx < rows.length; idx++) {
    const r = rows[idx];
    const cat = String(r[iCat] || "");
    if (!cat.includes("物理治療師")) continue;
    const e = String(r[iCode] || "").trim();
    const y = normalizeYear(r[iYear]) || yearFromExamCode(e);
    const title = String(r[iTitle] || "").trim();
    if (/^\d{5,6}$/.test(e) && y && !found.has(e)) {
      found.set(e, { y, e, title });
    }
  }
  return [...found.values()].sort((a, b) => Number(a.e) - Number(b.e));
}

function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "").trim();
}

function resolveExamHtmlDir(examTitle, examCode) {
  fs.mkdirSync(BANK_ROOT, { recursive: true });
  const entries = fs.readdirSync(BANK_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());

  const candidateDirs = (dirName) => [
    path.join(BANK_ROOT, dirName, "考畢題答"),
    path.join(BANK_ROOT, dirName),
  ];

  // 1. Reuse directory whose files already contain <examCode>_
  for (const dir of entries) {
    for (const htmlDir of candidateDirs(dir.name)) {
      if (!fs.existsSync(htmlDir)) continue;
      if (fs.readdirSync(htmlDir).some((f) => f.startsWith(`${examCode}_`))) return htmlDir;
    }
  }

  // 2. Reuse directory with matching session prefix (e.g. "114年第二次") if empty or uncoded
  const prefix = examTitle.match(/^\d+年第[一二三四]次/)?.[0];
  if (prefix) {
    for (const dir of entries) {
      if (!dir.name.startsWith(prefix)) continue;
      for (const htmlDir of candidateDirs(dir.name)) {
        if (!fs.existsSync(htmlDir)) continue;
        const existingPdfs = fs.readdirSync(htmlDir).filter((f) => f.endsWith(".pdf"));
        if (!existingPdfs.length || existingPdfs.some((f) => f.startsWith(`${examCode}_`))) {
          return htmlDir;
        }
      }
    }
  }

  // 3. Create directory using concise exam title matching existing folders
  const baseName = sanitizeFilenamePart(examTitle.split("、")[0]) || `${examCode}物理治療師考試`;
  return path.join(BANK_ROOT, baseName, "考畢題答");
}

function readExistingFilenames(htmlPath) {
  const map = new Map();
  if (!fs.existsSync(htmlPath)) return map;
  const html = fs.readFileSync(htmlPath, "utf8");
  const rowRe = /<UL class='link_3'><LI><table[^>]*><tr>\s*<td><div>([^<]+)<\/div><\/td>([\s\S]*?)<\/tr><\/table>/g;
  for (const rm of html.matchAll(rowRe)) {
    const subject = rm[1].trim();
    const links = rm[2];
    map.set(subject, {
      qPdf: links.match(/href='([^']+)'[^>]*>試題<\/a>/)?.[1] || null,
      ansPdf: links.match(/href='([^']+)'[^>]*>答案<\/a>/)?.[1] || null,
      modPdf: links.match(/href='([^']+)'[^>]*>更正答案<\/a>/)?.[1] || null,
    });
  }
  return map;
}

function escapeHtmlAttr(s) {
  return String(s || "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function buildExamHtml({ examTitle, categoryTitle, rows }) {
  const bodyRows = rows.map((r) => {
    const escSub = escapeHtmlAttr(r.subject);
    const modCell = r.modPdf
      ? `<td  width='12%' align='right' style='vertical-align:text-top;'><a target ='_blank' title = '另開視窗，開啓${escSub}更正答案檔(Pdf)' href='${escapeHtmlAttr(r.modPdf)}'>更正答案</a></td>`
      : `<td  width='12%' align='right' style='vertical-align:text-top;'>&nbsp;</td>`;
    return [
      `<tr><td><div style='padding-left: 40px;'><UL class='link_3'><LI><table border = '0' cellpadding = '0' cellspacing = '0'><tr>`,
      `<td><div>${escSub}</div></td>`,
      `<td  width='8%' align='right' style='vertical-align:text-top;'><a target ='_blank' title = '另開視窗，開啓${escSub}試題檔(Pdf)' href='${escapeHtmlAttr(r.qPdf)}'>試題</a></td>`,
      `<td  width='8%' align='right' style='vertical-align:text-top;'><a target ='_blank' title = '另開視窗，開啓${escSub}答案檔(Pdf)' href='${escapeHtmlAttr(r.ansPdf)}'>答案</a></td>`,
      modCell,
      `</tr></table></LI></UL></div></td></tr>`,
    ].join("\n");
  }).join("\n");

  return `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="utf-8" />
    <title>考選部(Ministry of Examination,R.O.C(Taiwan))全球資訊網 - 考畢題答查詢 </title>
    <style type="text/css">
        .ULQandA { border: none; margin-left: auto; margin-right: auto; line-height: 140%; border-collapse: collapse; width: 100%; color:#5d5d5d; }
        .ULQandA td { border-top: solid 1px #b3b3b3; border-bottom: solid 1px #b3b3b3; border-left-style:none; border-right-style:none; padding: 5px; }
        .ULQandA table { width:100%; border:solid 0px; }
        .ULQandA table td { border: none; padding: 0; }
        .ULQandA table a:link, .ULQandA table a:hover { color:#2d6a98; }
        .level1 { background-color: #ebffc8; color: #267006; }
        .level2 { background-color: #f3f3f3; color: #5d5d5d; }
        .link_1, .link_2, .link_3 { list-style: none; margin: 0; padding: 0; }
    </style>
</head>
<body>
    <table cellpadding = '0' cellspacing = '0' class='ULQandA'>
<tr><td class='level1'><UL class='link_1'><LI><table border = '0' cellpadding = '0' cellspacing = '0'><tr><td><div>${escapeHtmlAttr(examTitle)}</div></td>
</tr></table></LI></UL></td></tr>
<tr><td class='level2'><div style='padding-left: 20px;'><UL class='link_2'><LI><div>${escapeHtmlAttr(categoryTitle)}</div></LI></UL></div></td></tr>
${bodyRows}
</table>
</body>
</html>
`;
}

function isValidPdfFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(5);
    const bytesRead = fs.readSync(fd, head, 0, 5, 0);
    return bytesRead === 5 && head.toString("latin1") === "%PDF-";
  } finally {
    fs.closeSync(fd);
  }
}

async function downloadPdfIfNeeded(url, outPath, force = false) {
  if (!force && isValidPdfFile(outPath)) {
    return { status: "cached", file: path.basename(outPath) };
  }
  const buf = await fetchBuffer(url);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`下載檔案非有效 PDF（${path.basename(outPath)}）：${url}`);
  }
  fs.writeFileSync(outPath, buf);
  return { status: "downloaded", file: path.basename(outPath), bytes: buf.length };
}

async function syncExam({ y, e, force = false }) {
  const searchUrl = `${MOEX_SEARCH_URL}?y=${encodeURIComponent(y)}&e=${encodeURIComponent(e)}`;
  console.log(`正在抓取考選部考畢試題頁面：${searchUrl}`);
  const html = (await fetchBuffer(searchUrl)).toString("utf8");
  const parsed = parseMoexExamPage(html, e);
  if (!parsed.subjects.length) {
    throw new Error(`於考選部頁面找不到「物理治療師」相關考科（y=${y}, e=${e}）`);
  }

  const htmlDir = resolveExamHtmlDir(parsed.examTitle || e, parsed.examCode);
  fs.mkdirSync(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, "考畢題答.html");
  const existing = readExistingFilenames(htmlPath);

  console.log(`考試名稱：${parsed.examTitle}`);
  console.log(`類科：${parsed.categories.map((c) => c.categoryTitle).join("、")}（共 ${parsed.subjects.length} 科）`);
  console.log(`目標資料夾：${htmlDir}`);

  const rows = [];
  let downloadedCount = 0;
  let cachedCount = 0;

  for (const sub of parsed.subjects) {
    const shortSub = sanitizeFilenamePart(sub.subject).slice(0, 10);
    const prev = existing.get(sub.subject) || {};
    const qPdf = prev.qPdf || `${sub.examCode}_${sub.subCode}_${shortSub}.pdf`;
    const ansPdf = prev.ansPdf || `${sub.examCode}_ANS${sub.subCode}_${shortSub}.pdf`;
    const modPdf = sub.mUrl ? (prev.modPdf || `${sub.examCode}_MOD${sub.subCode}_${shortSub}.pdf`) : null;

    const qRes = await downloadPdfIfNeeded(sub.qUrl, path.join(htmlDir, qPdf), force);
    const sRes = await downloadPdfIfNeeded(sub.sUrl, path.join(htmlDir, ansPdf), force);
    const mRes = sub.mUrl ? await downloadPdfIfNeeded(sub.mUrl, path.join(htmlDir, modPdf), force) : null;

    for (const r of [qRes, sRes, mRes].filter(Boolean)) {
      if (r.status === "downloaded") downloadedCount++;
      else cachedCount++;
    }

    const labels = [
      `試題:${qRes.status === "downloaded" ? "已下載" : "已快取"}`,
      `答案:${sRes.status === "downloaded" ? "已下載" : "已快取"}`,
      mRes ? `更正答案:${mRes.status === "downloaded" ? "已下載" : "已快取"}` : "更正答案:無",
    ].join(" | ");
    console.log(`  - [${sub.subCode}] ${sub.subject} (${labels})`);

    rows.push({ subject: sub.subject, qPdf, ansPdf, modPdf });
  }

  const htmlOut = buildExamHtml({
    examTitle: parsed.examTitle || `${y}年考試(${parsed.examCode})`,
    categoryTitle: parsed.categories[0]?.categoryTitle || "專技高考_物理治療師",
    rows,
  });
  fs.writeFileSync(htmlPath, htmlOut, "utf8");
  console.log(`已更新 ${htmlPath}（本次新下載 ${downloadedCount} 檔，沿用本地快取 ${cachedCount} 檔）`);

  return {
    examCode: parsed.examCode,
    examTitle: parsed.examTitle,
    htmlDir,
    subjectCount: rows.length,
    downloadedCount,
    cachedCount,
  };
}

async function runSync({ target, year, opendata = false, all = false, force = false, rebuild = true } = {}) {
  const results = [];

  if (opendata) {
    console.log(`正在查詢考選部 OpenData CSV：${MOEX_OPENDATA_CSV_URL}`);
    const csvBuf = await fetchBuffer(MOEX_OPENDATA_CSV_URL);
    let list = parseOpenDataCsv(csvBuf.toString("utf8"));
    if (year) {
      const yNorm = normalizeYear(year);
      list = list.filter((x) => x.y === yNorm);
    } else if (target) {
      const spec = parseTargetInput(target);
      list = list.filter((x) => (spec.e ? x.e === spec.e : x.y === spec.y));
    } else if (!all && list.length) {
      list = [list[list.length - 1]];
    }
    if (!list.length) {
      throw new Error("OpenData CSV 未解析到符合條件的「物理治療師」考試資料");
    }
    console.log(`自 OpenData CSV 探索到 ${list.length} 筆物理治療師考試：${list.map((x) => x.e).join(", ")}`);
    for (const item of list) {
      results.push(await syncExam({ y: item.y, e: item.e, force }));
    }
  } else {
    const spec = parseTargetInput(year ? String(year) : (target || DEFAULT_MOEX_URL));
    if (spec.mode === "opendata") {
      return runSync({ opendata: true, force, rebuild });
    }
    if (spec.mode === "year") {
      console.log(`正在查詢 ${spec.y} 年物理治療師考試清單：${spec.url}`);
      const yearHtml = (await fetchBuffer(spec.url)).toString("utf8");
      const list = parseExamListFromYearPage(yearHtml);
      if (!list.length) {
        throw new Error(`${spec.y} 年頁面查無包含「物理治療師」的考試`);
      }
      console.log(`探索到 ${list.length} 次考試：${list.map((x) => `${x.e}(${x.title.slice(0, 16)}...)`).join(", ")}`);
      for (const item of list) {
        results.push(await syncExam({ y: item.y, e: item.e, force }));
      }
    } else {
      results.push(await syncExam({ y: spec.y, e: spec.e, force }));
    }
  }

  let buildSummary = null;
  if (rebuild) {
    console.log("正在執行 build-bank.js 重新解析題庫並更新 data/manifest.json 與 data/chunks/*.json.gz ...");
    const { buildBank } = require("./build-bank");
    buildSummary = buildBank();
  }

  return { results, buildSummary };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".gz": "application/gzip",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function startServer(port = 3000) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "GET" && reqUrl.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, mode: "moex-sync-server" }));
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/sync-moex") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16384) req.destroy();
      });
      req.on("end", async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const summary = await runSync({
            target: payload.url || payload.target || DEFAULT_MOEX_URL,
            year: payload.year,
            opendata: Boolean(payload.opendata),
            force: Boolean(payload.force),
            rebuild: true,
          });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, ...summary }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    const relPath = decodeURIComponent(reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname);
    const fullPath = path.resolve(BASE, "." + relPath);
    if (!fullPath.startsWith(BASE + path.sep) && fullPath !== BASE) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" };
    const baseName = path.basename(fullPath);
    if (baseName === "manifest.json" || baseName === "sw.js") {
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers);
    fs.createReadStream(fullPath).pipe(res);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`物理治療師國考測驗與考選部 OpenData 同步伺服器已啟動：http://127.0.0.1:${port}/`);
  });
  return server;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let target = "";
  let year = "";
  let opendata = false;
  let all = false;
  let force = false;
  let rebuild = true;
  let serve = false;
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--opendata") opendata = true;
    else if (a === "--all") all = true;
    else if (a === "--force") force = true;
    else if (a === "--no-build") rebuild = false;
    else if (a === "--serve") serve = true;
    else if (a === "--port" && args[i + 1]) port = parseInt(args[++i], 10) || 3000;
    else if (a === "--year" && args[i + 1]) year = args[++i];
    else if (!a.startsWith("-")) target = a;
  }

  if (serve) {
    startServer(port);
  } else {
    runSync({ target, year, opendata, all, force, rebuild })
      .then((summary) => {
        const totalSubs = summary.results.reduce((s, r) => s + r.subjectCount, 0);
        const totalDl = summary.results.reduce((s, r) => s + r.downloadedCount, 0);
        const totalQuestions = summary.buildSummary ? summary.buildSummary.totalQuestions : "(未執行 build-bank)";
        console.log(`完成！共處理 ${summary.results.length} 次考試、${totalSubs} 科（新下載 ${totalDl} 檔），目前題庫共 ${totalQuestions} 題。`);
      })
      .catch((err) => {
        console.error("同步失敗：", err.message);
        process.exit(1);
      });
  }
}

module.exports = {
  parseTargetInput,
  parseExamListFromYearPage,
  parseMoexExamPage,
  parseOpenDataCsv,
  resolveExamHtmlDir,
  buildExamHtml,
  runSync,
  startServer,
};
