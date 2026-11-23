const $ = (id) => document.getElementById(id);
let manifest = null;
let chunkByPair = new Map();
const chunkCache = new Map();
const inFlightChunks = new Map();
let customBank = null;
let picked = [];
let lastMode = "normal";
let isLoadingQuiz = false;

async function fetchJsonMaybeGzip(url, fetchOpts = {}) {
  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} 載入失敗：${url}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error("此瀏覽器不支援 gzip 解壓縮（DecompressionStream），請更新瀏覽器後再試。");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).json();
}

async function loadManifest(bustCache = false) {
  const url = bustCache ? `data/manifest.json?t=${Date.now()}` : "data/manifest.json";
  const data = await fetchJsonMaybeGzip(url, { cache: "no-cache" });
  const rawChunks = Array.isArray(data?.chunks) ? data.chunks : [];
  const exams = Array.isArray(data?.exams) ? data.exams : [];
  const subjects = Array.isArray(data?.subjects) ? data.subjects : [];
  chunkByPair = new Map();
  const hydratedChunks = rawChunks.map((c) => {
    const exam = exams[c.e] || "";
    const subject = subjects[c.s] || "";
    const entry = {
      ...c,
      exam,
      subject,
      key: `${exam}||${subject}`,
    };
    chunkByPair.set(entry.key, entry);
    return entry;
  });
  manifest = {
    version: data?.version || 1,
    buildId: data?.buildId || "",
    total: Number(data?.total) || hydratedChunks.reduce((s, c) => s + (c.count || 0), 0),
    exams,
    subjects,
    chunks: hydratedChunks,
  };
  return manifest;
}

async function loadChunk(chunk) {
  if (!chunk) return [];
  if (chunkCache.has(chunk.file)) return chunkCache.get(chunk.file);
  if (inFlightChunks.has(chunk.file)) return inFlightChunks.get(chunk.file);
  const ver = manifest?.buildId || manifest?.version || "";
  const url = ver ? `data/chunks/${chunk.file}?v=${encodeURIComponent(ver)}` : `data/chunks/${chunk.file}`;
  const p = fetchJsonMaybeGzip(url)
    .then((arr) => {
      chunkCache.set(chunk.file, arr);
      return arr;
    })
    .finally(() => {
      inFlightChunks.delete(chunk.file);
    });
  inFlightChunks.set(chunk.file, p);
  return p;
}

async function loadChunks(chunks, onProgress) {
  const unique = [];
  const seenFiles = new Set();
  for (const c of chunks) {
    if (c && !seenFiles.has(c.file)) {
      seenFiles.add(c.file);
      unique.push(c);
    }
  }
  const total = unique.length;
  let done = 0;
  const toFetch = [];
  for (const c of unique) {
    if (chunkCache.has(c.file)) done++;
    else toFetch.push(c);
  }
  if (onProgress) onProgress(done, total);
  if (!toFetch.length) return unique.map((c) => chunkCache.get(c.file));

  const concurrency = Math.min(6, toFetch.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < toFetch.length) {
      const chunk = toFetch[nextIdx++];
      await loadChunk(chunk);
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return unique.map((c) => chunkCache.get(c.file));
}

function getMatchingChunks(exam = $("exam").value || "全部", subject = $("subject").value || "全部") {
  if (!manifest) return [];
  return manifest.chunks.filter(
    (c) => (exam === "全部" || c.exam === exam) && (subject === "全部" || c.subject === subject)
  );
}

function forEachChunkNum(chunk, fn) {
  if (chunk.nums) {
    for (let i = 0; i < chunk.nums.length; i++) fn(chunk.nums[i]);
  } else {
    for (let num = 1; num <= chunk.count; num++) fn(num);
  }
}

function getChunkQuestionKey(chunk, num) {
  return `${chunk.exam}||${chunk.subject}||${num}`;
}

function maybePrefetchSelection() {
  if (customBank || !manifest) return;
  const chunks = getMatchingChunks();
  if (chunks.length === 1) {
    loadChunk(chunks[0]).catch(() => {});
  }
}

// ---------- 題庫：內建（分割 gzip 分塊）or 匯入的 CSV（存在瀏覽器 localStorage） ----------
async function loadBank() {
  const saved = JSON.parse(localStorage.getItem("examBank") || "null");
  if (saved && saved.length) {
    customBank = saved;
    $("bankInfo").textContent = `目前題庫：匯入的 CSV（${customBank.length} 題）`;
    const exams = ["全部", ...new Set(customBank.map((q) => q.exam).filter(Boolean))];
    $("exam").innerHTML = exams.map((x) => `<option>${esc(x)}</option>`).join("");
    $("exam").closest("label").hidden = exams.length <= 1;
    const subjects = ["全部", ...new Set(customBank.map((q) => q.subject))];
    $("subject").innerHTML = subjects.map((s) => `<option>${esc(s)}</option>`).join("");
    $("start").disabled = false;
    updateRepeatInfo();
    renderWrongBook();
    return;
  }

  customBank = null;
  if (!manifest) {
    $("bankInfo").textContent = "目前題庫：正在載入題庫索引…";
    $("start").disabled = true;
    try {
      await loadManifest();
    } catch (err) {
      const isFile = typeof location !== "undefined" && location.protocol === "file:";
      $("bankInfo").textContent = isFile
        ? "目前為 file:// 本機檔案模式，瀏覽器安全性限制無法直接讀取分割題庫，請改用 node sync-moex.js --serve 開啟。"
        : `題庫索引載入失敗：${err.message}`;
      $("repeatInfo").textContent = "";
      renderWrongBook();
      return;
    }
  }

  $("bankInfo").textContent = `目前題庫：考畢題答（${manifest.total} 題）`;
  const exams = ["全部", ...manifest.exams];
  $("exam").innerHTML = exams.map((x) => `<option>${esc(x)}</option>`).join("");
  $("exam").closest("label").hidden = exams.length <= 1;
  const subjects = ["全部", ...manifest.subjects];
  $("subject").innerHTML = subjects.map((s) => `<option>${esc(s)}</option>`).join("");
  $("start").disabled = false;
  updateRepeatInfo();
  maybePrefetchSelection();
  renderWrongBook();
}

// 簡易 CSV 解析（支援雙引號包住含逗號/換行的欄位）
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

// CSV 欄位：科目,題目,選項A,選項B,選項C,選項D,答案(A~D),解說
function csvToQuestions(text) {
  const rows = parseCSV(text).slice(1); // 跳過標題列
  const letters = "ABCDEFGH";
  const out = [], errors = [];
  rows.forEach((r, idx) => {
    const [subject, q, ...rest] = r.map((f) => f.trim());
    const explain = rest.pop();
    const ans = rest.pop()?.toUpperCase();
    const options = rest.filter(Boolean);
    const answer = letters.indexOf(ans);
    if (!q || options.length < 2 || answer < 0 || answer >= options.length) {
      errors.push(idx + 2); // Excel 列號
    } else {
      out.push({ subject: subject || "未分類", q, options, answer, explain });
    }
  });
  return { out, errors };
}

$("csvFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const { out, errors } = csvToQuestions(await file.text());
  e.target.value = "";
  if (!out.length) return alert("沒有讀到任何題目，請確認 CSV 格式（存成「CSV UTF-8」）。");
  localStorage.setItem("examBank", JSON.stringify(out));
  loadBank();
  alert(`匯入 ${out.length} 題` + (errors.length ? `\n略過格式錯誤的列：${errors.join(", ")}` : ""));
};

$("resetBank").onclick = () => {
  localStorage.removeItem("examBank");
  loadBank();
};

// ---------- 抽題 ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmt(s) {
  return esc(s)
    .replace(/(\[IMG:[^\]]+\])(?:\s*\[IMG:[^\]]+\])+/g, "$1")
    .replace(/(?:^|\n)((?:\|[^\n]+\|(?:\n|$))+)/g, (_, block) => {
      const rows = block
        .trim()
        .split("\n")
        .map((r) => "<tr>" + r.slice(1, -1).split("|").map((c) => `<td>${c.trim()}</td>`).join("") + "</tr>")
        .join("");
      return `<table class="q-table"><tbody>${rows}</tbody></table>`;
    })
    .replace(/\n/g, "<br>")
    .replace(/\[IMG:([^\]]+)\]/g, '<img src="img/$1" class="q-img" alt="附圖" />')
    .replace(/\[IMG_INLINE:([^\]]+)\]/g, '<img src="img/$1" class="q-img-inline" alt="符號" />');
}

function loadSeenMap() {
  try {
    return JSON.parse(localStorage.getItem("seenQuestions") || "{}") || {};
  } catch {
    return {};
  }
}

function saveSeenMap(map) {
  localStorage.setItem("seenQuestions", JSON.stringify(map));
}

function getRepeatWindowMs() {
  const mode = $("noRepeatMode")?.value || "paper";
  if (mode === "off") return null;
  if (mode === "paper") return Infinity;
  const table = {
    "1h": 3600e3,
    "6h": 6 * 3600e3,
    "24h": 24 * 3600e3,
    "3d": 3 * 86400e3,
    "7d": 7 * 86400e3,
    "30d": 30 * 86400e3,
  };
  if (table[mode]) return table[mode];
  return Math.max(1, +$("noRepeatHours")?.value || 12) * 3600e3;
}

function isKeySeen(key, seenMap, now, winMs) {
  if (winMs === null) return false;
  const ts = seenMap[key];
  if (!ts) return false;
  if (winMs === Infinity) return true;
  return now - ts < winMs;
}

function isQuestionSeen(q, seenMap, now, winMs) {
  return isKeySeen(getQKey(q), seenMap, now, winMs);
}

function getFilteredCustomPool() {
  if (!customBank) return [];
  const exam = $("exam").value || "全部";
  const subject = $("subject").value || "全部";
  return customBank.filter((q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject));
}

function updateRepeatInfo() {
  if (!$("noRepeatMode")) return;
  const mode = $("noRepeatMode").value;
  $("customHoursWrap").hidden = mode !== "custom";
  const seenMap = loadSeenMap();
  const now = Date.now();
  const winMs = getRepeatWindowMs();
  let totalCount = 0;
  let seenCount = 0;
  let everSeenCount = 0;

  if (customBank) {
    const basePool = getFilteredCustomPool();
    totalCount = basePool.length;
    for (const q of basePool) {
      const key = getQKey(q);
      if (seenMap[key]) everSeenCount++;
      if (isKeySeen(key, seenMap, now, winMs)) seenCount++;
    }
  } else if (manifest) {
    for (const c of getMatchingChunks()) {
      totalCount += c.count;
      forEachChunkNum(c, (num) => {
        const key = getChunkQuestionKey(c, num);
        if (seenMap[key]) everSeenCount++;
        if (isKeySeen(key, seenMap, now, winMs)) seenCount++;
      });
    }
  } else {
    return;
  }

  const availCount = totalCount - seenCount;
  if (mode === "off") {
    $("repeatInfo").textContent = `目前範圍共 ${totalCount} 題（未限制重複；此範圍曾抽過 ${everSeenCount} 題）`;
  } else if (mode === "paper") {
    $("repeatInfo").textContent = `目前考卷／範圍剩餘未抽：${availCount} / ${totalCount} 題（已抽過 ${seenCount} 題）`;
  } else {
    $("repeatInfo").textContent = `目前範圍於設定時效內可抽：${availCount} / ${totalCount} 題（時效內已抽過 ${seenCount} 題）`;
  }
  $("resetSeen").hidden = (mode === "off" ? everSeenCount : seenCount) === 0;
}

function buildQuestionGroups(questions) {
  const groups = [];
  for (const q of questions) {
    if (
      groups.length &&
      /[承呈同依]上題/.test(q.q) &&
      groups[groups.length - 1][0].subject === q.subject &&
      groups[groups.length - 1][0].exam === q.exam
    ) {
      const grp = groups[groups.length - 1];
      grp.push({ ...q, prevQ: grp.map((p) => p.q).join("\n") });
    } else {
      groups.push([q]);
    }
  }
  return groups;
}

function sampleDistinctIndices(total, k) {
  if (k >= total) return Array.from({ length: total }, (_, i) => i);
  if (k <= total / 2) {
    const used = new Set();
    for (let i = total - k; i < total; i++) {
      const r = Math.floor(Math.random() * (i + 1));
      used.add(used.has(r) ? i : r);
    }
    return [...used];
  }
  const arr = Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (total - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}

function attachPrevStemFromList(q, list) {
  if (!/[承呈同依]上題/.test(q.q) || !list || !list.length) return q;
  const idx = list.findIndex((x) => getQKey(x) === getQKey(q));
  const prev = idx > 0 ? list[idx - 1] : null;
  if (prev && prev.exam === q.exam && prev.subject === q.subject) {
    return { ...q, prevStem: prev.q };
  }
  return q;
}

async function startQuiz(mode = "normal") {
  if (isLoadingQuiz) return;
  isLoadingQuiz = true;
  lastMode = mode;

  const startBtn = $("start");
  const wrongBtn = $("startWrong");
  const retryBtn = $("retry");
  const origStartText = startBtn.textContent;
  const origWrongText = wrongBtn.textContent;
  const origRetryText = retryBtn.textContent;
  const activeBtn = mode === "wrong" ? wrongBtn : startBtn;

  const setLoadingState = (loading, done = 0, total = 0) => {
    startBtn.disabled = loading;
    wrongBtn.disabled = loading || !loadWrongBook().length;
    retryBtn.disabled = loading;
    if (loading) {
      const msg = total > 1 ? `載入題庫中 (${done}/${total})…` : "載入題庫中…";
      if (activeBtn) activeBtn.textContent = msg;
      if (!$("result").hidden) retryBtn.textContent = msg;
    } else {
      startBtn.textContent = origStartText;
      wrongBtn.textContent = origWrongText;
      retryBtn.textContent = origRetryText;
    }
  };

  try {
    if (!customBank && !manifest) {
      await loadBank();
      if (!manifest) return alert("題庫尚未載入，請確認網路或使用 node sync-moex.js --serve 開啟。");
    }

    const exam = $("exam").value || "全部";
    const subject = $("subject").value || "全部";
    const mixOptions = $("mixOptions").checked;
    const winMs = getRepeatWindowMs();
    const seenMap = loadSeenMap();
    const now = Date.now();
    let rawPicked = [];

    if (mode === "wrong") {
      let wrongAll = loadWrongBook();
      if (!wrongAll.length) return alert("目前錯題簿沒有題目");
      const filtered = wrongAll.filter(
        (q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject)
      );
      let chosenWrong = filtered.length ? filtered : wrongAll;

      if (!customBank && manifest) {
        const neededChunks = [];
        const seenFiles = new Set();
        for (const q of chosenWrong) {
          const chunk = chunkByPair.get(`${q.exam || ""}||${q.subject || ""}`);
          if (chunk && !seenFiles.has(chunk.file)) {
            seenFiles.add(chunk.file);
            neededChunks.push(chunk);
          }
        }
        if (neededChunks.length) {
          setLoadingState(true, 0, neededChunks.length);
          await loadChunks(neededChunks, (done, total) => setLoadingState(true, done, total));
        }
        wrongAll = loadWrongBook();
        const refreshedFiltered = wrongAll.filter(
          (q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject)
        );
        chosenWrong = refreshedFiltered.length ? refreshedFiltered : wrongAll;
      }

      const pool = chosenWrong.map((q) => {
        if (customBank) return attachPrevStemFromList(q, customBank);
        const chunk = chunkByPair.get(`${q.exam || ""}||${q.subject || ""}`);
        return attachPrevStemFromList(q, chunk ? chunkCache.get(chunk.file) : null);
      });

      const n = Math.min(Math.max(1, +$("count").value || 1), pool.length);
      let unseenWrong = winMs === null ? pool : pool.filter((q) => !isQuestionSeen(q, seenMap, now, winMs));
      if (!unseenWrong.length) {
        if (!confirm("錯題簿在此範圍內的題目於目前防重複條件下已全部抽過！是否重置此範圍錯題的已抽紀錄並繼續測驗？")) return;
        for (const q of pool) delete seenMap[getQKey(q)];
        saveSeenMap(seenMap);
        updateRepeatInfo();
        unseenWrong = pool;
      }
      rawPicked = shuffle(unseenWrong).slice(0, n);
    } else if (customBank) {
      const pool = getFilteredCustomPool();
      if (!pool.length) return alert("此篩選條件下沒有題目");
      const n = Math.min(Math.max(1, +$("count").value || 1), pool.length);
      const groups = buildQuestionGroups(pool);
      let unseenGroups = winMs === null ? groups : groups.filter((g) => g.some((q) => !isQuestionSeen(q, seenMap, now, winMs)));
      if (!unseenGroups.length) {
        if (!confirm("此考卷／範圍內的題目在目前防重複條件下已全部抽完！是否重置此範圍的已抽紀錄並重新抽題？")) return;
        for (const q of pool) delete seenMap[getQKey(q)];
        saveSeenMap(seenMap);
        updateRepeatInfo();
        unseenGroups = groups;
      }
      const shuffledGroups = shuffle(unseenGroups);
      for (const g of shuffledGroups) {
        if (rawPicked.length + g.length <= n) rawPicked.push(...g);
        if (rawPicked.length === n) break;
      }
      if (!rawPicked.length && shuffledGroups.length) rawPicked.push(...shuffledGroups[0]);
    } else {
      const matchingChunks = getMatchingChunks(exam, subject);
      if (!matchingChunks.length) return alert("此篩選條件下沒有題目");
      const totalInRange = matchingChunks.reduce((s, c) => s + c.count, 0);
      const n = Math.min(Math.max(1, +$("count").value || 1), totalInRange);

      const chunkUnseen = matchingChunks.map((c) => {
        let unseen = 0;
        forEachChunkNum(c, (num) => {
          if (!isKeySeen(getChunkQuestionKey(c, num), seenMap, now, winMs)) unseen++;
        });
        return { chunk: c, unseen };
      });
      let totalUnseen = chunkUnseen.reduce((s, x) => s + x.unseen, 0);
      if (totalUnseen === 0) {
        if (!confirm("此考卷／範圍內的題目在目前防重複條件下已全部抽完！是否重置此範圍的已抽紀錄並重新抽題？")) return;
        for (const c of matchingChunks) {
          forEachChunkNum(c, (num) => { delete seenMap[getChunkQuestionKey(c, num)]; });
        }
        saveSeenMap(seenMap);
        updateRepeatInfo();
        for (const x of chunkUnseen) x.unseen = x.chunk.count;
        totalUnseen = totalInRange;
      }

      const avail = chunkUnseen.filter((x) => x.unseen > 0);
      if (avail.length === 1) {
        setLoadingState(true, 0, 1);
        const [qs] = await loadChunks([avail[0].chunk], (done, total) => setLoadingState(true, done, total));
        const groups = buildQuestionGroups(qs);
        const unseenGroups = winMs === null ? groups : groups.filter((g) => g.some((q) => !isQuestionSeen(q, seenMap, now, winMs)));
        const shuffledGroups = shuffle(unseenGroups.length ? unseenGroups : groups);
        for (const g of shuffledGroups) {
          if (rawPicked.length + g.length <= n) rawPicked.push(...g);
          if (rawPicked.length === n) break;
        }
        if (!rawPicked.length && shuffledGroups.length) rawPicked.push(...shuffledGroups[0]);
      } else {
        const drawCount = Math.min(n, totalUnseen);
        const pickedIndices = sampleDistinctIndices(totalUnseen, drawCount).sort((a, b) => a - b);
        const quotaMap = new Map();
        let offset = 0;
        let ptr = 0;
        for (const entry of avail) {
          const end = offset + entry.unseen;
          let qCount = 0;
          while (ptr < pickedIndices.length && pickedIndices[ptr] < end) {
            qCount++;
            ptr++;
          }
          if (qCount > 0) quotaMap.set(entry.chunk.file, qCount);
          offset = end;
        }

        const initialChunks = avail.filter((x) => quotaMap.has(x.chunk.file)).map((x) => x.chunk);
        const remainingPool = shuffle(avail.filter((x) => !quotaMap.has(x.chunk.file)).map((x) => x.chunk));
        setLoadingState(true, 0, initialChunks.length);
        await loadChunks(initialChunks, (done, total) => setLoadingState(true, done, total));

        const selectedGroups = [];
        const spareGroups = [];
        let firstFallbackGroup = null;
        let pickedCount = 0;

        const processChunk = (chunk, targetBudget) => {
          const qs = chunkCache.get(chunk.file) || [];
          const groups = buildQuestionGroups(qs);
          const unseenGroups = winMs === null ? groups : groups.filter((g) => g.some((q) => !isQuestionSeen(q, seenMap, now, winMs)));
          const shuffled = shuffle(unseenGroups);
          let chunkPicked = 0;
          for (const g of shuffled) {
            if (!firstFallbackGroup) firstFallbackGroup = g;
            if (chunkPicked + g.length <= targetBudget && pickedCount + g.length <= n) {
              selectedGroups.push(g);
              chunkPicked += g.length;
              pickedCount += g.length;
            } else {
              spareGroups.push(g);
            }
          }
        };

        for (const chunk of initialChunks) {
          processChunk(chunk, quotaMap.get(chunk.file) || 0);
        }

        if (pickedCount < n && spareGroups.length) {
          for (const g of shuffle(spareGroups)) {
            if (pickedCount + g.length <= n) {
              selectedGroups.push(g);
              pickedCount += g.length;
            }
            if (pickedCount >= n) break;
          }
        }

        while (pickedCount < n && remainingPool.length) {
          const batchSize = Math.min(4, Math.max(1, n - pickedCount), remainingPool.length);
          const batch = remainingPool.splice(0, batchSize);
          setLoadingState(true, 0, batch.length);
          await loadChunks(batch, (done, total) => setLoadingState(true, done, total));
          for (const chunk of batch) {
            if (pickedCount >= n) break;
            processChunk(chunk, n - pickedCount);
          }
        }

        if (!selectedGroups.length && firstFallbackGroup) {
          selectedGroups.push(firstFallbackGroup);
        }
        rawPicked = shuffle(selectedGroups).flat();
      }
    }

    const prevSeenJson = localStorage.getItem("seenQuestions") || "{}";
    const nextSeenMap = loadSeenMap();
    const markTs = Date.now();
    for (const q of rawPicked) nextSeenMap[getQKey(q.rawQ || q)] = markTs;
    saveSeenMap(nextSeenMap);
    updateRepeatInfo();

    picked = rawPicked.map((q) => {
      const rawQ = q.rawQ || q;
      const displayQ = q.prevStem ? `【前題題幹】${q.prevStem}\n\n${q.q}` : q.q;
      if (!mixOptions) return { ...q, q: displayQ, rawQ };
      const order = shuffle(q.options.map((_, i) => i));
      const item = { ...q, q: displayQ, rawQ, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
      if (q.answers) item.answers = q.answers.map((a) => order.indexOf(a));
      if (q.optionExplains) item.optionExplains = order.map((i) => q.optionExplains[i]);
      return item;
    });

    $("quiz").innerHTML =
      picked.map((q, i) => `
        <fieldset id="q${i}">
          <div class="q-title">${i + 1}. ${fmt(q.q)}</div>
          ${q.options.map((opt, j) => `
            <label class="opt-item">
              <div class="opt-line"><input type="radio" name="q${i}" value="${j}" required /> <span class="opt-text">(${"ABCDEFGH"[j]}) ${fmt(opt)}</span></div>
              <div class="opt-note" hidden></div>
            </label>
          `).join("")}
          <p class="explain" hidden></p>
        </fieldset>`).join("") +
      `<div class="quiz-actions"><button type="submit">交卷</button><button type="button" id="cancelQuiz" class="secondary">返回重選</button></div>`;
    $("cancelQuiz").onclick = () => {
      localStorage.setItem("seenQuestions", prevSeenJson);
      updateRepeatInfo();
      $("quiz").hidden = true;
      $("setup").hidden = false;
      window.scrollTo(0, 0);
    };

    $("setup").hidden = true;
    $("result").hidden = true;
    $("quiz").hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    alert(`載入題目失敗：${err?.message || err}`);
  } finally {
    isLoadingQuiz = false;
    setLoadingState(false);
  }
}

function stripImgTags(s) {
  return String(s ?? "").replace(/\[IMG(?:_INLINE)?:([^\]]+)\]/g, "（附圖：$1）").trim();
}

function buildGeminiPrompt(q, chosen) {
  const ansIndices = q.answers || [q.answer];
  const ok = chosen !== undefined && chosen !== null
    ? (q.answers ? q.answers.includes(chosen) : chosen === q.answer)
    : null;
  const source = [q.exam, q.subject, q.num ? `第 ${q.num} 題` : ""].filter(Boolean).join("・");
  const lines = ["【物理治療師國考題請益】"];
  if (source) lines.push(`出處：${source}`);
  if (q.prevQ && !q.q.includes("【前題題幹】")) {
    lines.push(`【前題題幹】\n${stripImgTags(q.prevQ)}`);
  }
  lines.push(`題目：\n${stripImgTags(q.q)}`);
  lines.push(
    "選項：\n" +
      q.options.map((opt, j) => `(${"ABCDEFGH"[j]}) ${stripImgTags(opt)}`).join("\n")
  );
  if (chosen !== undefined && chosen !== null && q.options[chosen] !== undefined) {
    lines.push(`我的作答：(${"ABCDEFGH"[chosen]}) ${stripImgTags(q.options[chosen])}（${ok ? "答對" : "答錯"}）`);
  }
  const ansText = ansIndices.map((a) => `(${"ABCDEFGH"[a]}) ${stripImgTags(q.options[a])}`).join(" 或 ");
  lines.push(`正確答案：${ansText}${q.explain ? `（${q.explain}）` : ""}`);
  lines.push("請幫我詳細解析這題的核心觀念、正確答案的判斷依據，以及各個選項正確或錯誤的原因。");
  return lines.join("\n\n");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  return ok;
}

async function askGeminiWithQuestion(q, chosen, btnEl, target = "aiMode") {
  const promptText = buildGeminiPrompt(q, chosen);
  const copied = await copyTextToClipboard(promptText);
  const url = target === "geminiApp"
    ? `https://gemini.google.com/app?q=${encodeURIComponent(promptText)}`
    : `https://www.google.com/search?udm=50&q=${encodeURIComponent(promptText)}`;
  if (btnEl) {
    const orig = btnEl.dataset.origLabel || btnEl.textContent;
    btnEl.dataset.origLabel = orig;
    if (target === "geminiApp") {
      btnEl.textContent = copied ? "✔ 已複製題目！請於 Gemini 按 Ctrl+V 貼上" : "⚠ 自動複製失敗，請手動複製題目";
    } else {
      btnEl.textContent = copied ? "✔ 已自動帶入題目詢問 Gemini！（亦已複製至剪貼簿）" : "✔ 已自動帶入題目詢問 Gemini！";
    }
    btnEl.classList.add("copied");
    clearTimeout(btnEl._timer);
    btnEl._timer = setTimeout(() => {
      btnEl.textContent = orig;
      btnEl.classList.remove("copied");
    }, 3000);
  }
  window.open(url, "_blank", "noopener");
}

function submit(e) {
  e.preventDefault();
  let correct = 0;
  const autoRemove = $("autoRemoveWrong").checked;
  picked.forEach((q, i) => {
    const box = $(`q${i}`);
    const chosen = +box.querySelector("input:checked").value;
    q.chosen = chosen;
    const ok = q.answers ? q.answers.includes(chosen) : chosen === q.answer;
    if (ok) correct++;
    const rawQ = q.rawQ || q;
    if (!ok) addWrongQuestion(rawQ);
    else if (autoRemove) removeWrongQuestion(getQKey(rawQ));
    box.className = ok ? "right" : "wrong";
    box.querySelectorAll("input").forEach((el) => (el.disabled = true));
    const ex = box.querySelector(".explain");
    const ansIndices = q.answers || [q.answer];
    const ansLabel = ansIndices.map((a) => `(${"ABCDEFGH"[a]}) ${fmt(q.options[a])}`).join(" 或 ");
    const source = [q.exam, q.subject, q.num ? `第 ${q.num} 題` : ""].filter(Boolean).join("・");

    box.querySelectorAll("label.opt-item").forEach((labelEl, j) => {
      const isAns = ansIndices.includes(j);
      const isChosenWrong = j === chosen && !isAns;
      if (isAns) labelEl.classList.add("opt-correct");
      else if (isChosenWrong) labelEl.classList.add("opt-wrong");
      const noteEl = labelEl.querySelector(".opt-note");
      const noteText = q.optionExplains?.[j];
      if (noteEl && noteText) {
        noteEl.innerHTML = `<span class="opt-tag ${isAns ? "tag-right" : "tag-wrong"}">${isAns ? "✔ 正解選項" : "✘ 選項解析"}</span> ${fmt(noteText)}`;
        noteEl.hidden = false;
      }
    });

    ex.innerHTML = `${ok ? "✔ 答對" : "✘ 答錯，正確答案：" + ansLabel}${q.explain ? "｜" + esc(q.explain) : ""}` +
      (source ? `<div class="q-source">出處：${esc(source)}</div>` : "") +
      `<div class="gemini-bar">` +
      `<button type="button" class="gemini-btn" data-qidx="${i}" data-target="aiMode">✨ 問問 Gemini（自動帶入詢問）</button>` +
      `<button type="button" class="gemini-btn secondary" data-qidx="${i}" data-target="geminiApp">Gemini App（複製貼上）</button>` +
      `</div>`;
    ex.hidden = false;
  });
  renderWrongBook();
  const seenMap = loadSeenMap();
  const submitTs = Date.now();
  for (const q of picked) seenMap[getQKey(q.rawQ || q)] = submitTs;
  saveSeenMap(seenMap);
  updateRepeatInfo();
  $("quiz").querySelector(".quiz-actions").remove();
  const pct = Math.round((correct / picked.length) * 100);
  $("score").textContent = `得分：${correct} / ${picked.length}（${pct} 分）`;
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth" });
  const exam = $("exam").value;
  const baseLabel = exam && exam !== "全部" ? `${exam}・${$("subject").value}` : $("subject").value;
  const label = lastMode === "wrong" ? `[錯題] ${baseLabel}` : baseLabel;
  saveHistory({ time: new Date().toLocaleString(), subject: label, correct, total: picked.length, pct });
}

// ---------- 錯題簿 ----------
function getQKey(q) {
  return `${q.exam || ""}||${q.subject || ""}||${q.num || q.q}`;
}

function findLoadedQuestion(item) {
  const key = getQKey(item);
  if (customBank) return customBank.find((q) => getQKey(q) === key) || null;
  const chunk = chunkByPair.get(`${item.exam || ""}||${item.subject || ""}`);
  if (!chunk || !chunkCache.has(chunk.file)) return null;
  return chunkCache.get(chunk.file).find((q) => getQKey(q) === key) || null;
}

function loadWrongBook() {
  const saved = JSON.parse(localStorage.getItem("wrongBook") || "[]");
  return saved.map((item) => {
    const canon = findLoadedQuestion(item);
    return canon ? { ...canon, wrongCount: item.wrongCount || 1, lastTime: item.lastTime || "" } : item;
  });
}

function saveWrongBook(list) {
  localStorage.setItem("wrongBook", JSON.stringify(list));
  renderWrongBook();
}

function addWrongQuestion(rawQ) {
  const key = getQKey(rawQ);
  const list = JSON.parse(localStorage.getItem("wrongBook") || "[]");
  const idx = list.findIndex((item) => getQKey(item) === key);
  const count = idx >= 0 ? (list[idx].wrongCount || 1) + 1 : 1;
  if (idx >= 0) list.splice(idx, 1);
  list.unshift({
    exam: rawQ.exam || "",
    subject: rawQ.subject || "",
    num: rawQ.num || 0,
    q: rawQ.q,
    options: rawQ.options,
    answer: rawQ.answer,
    ...(rawQ.answers ? { answers: rawQ.answers } : {}),
    explain: rawQ.explain || "",
    ...(rawQ.optionExplains ? { optionExplains: rawQ.optionExplains } : {}),
    wrongCount: count,
    lastTime: new Date().toLocaleString(),
  });
  localStorage.setItem("wrongBook", JSON.stringify(list));
}

function removeWrongQuestion(key) {
  const list = JSON.parse(localStorage.getItem("wrongBook") || "[]").filter((item) => getQKey(item) !== key);
  localStorage.setItem("wrongBook", JSON.stringify(list));
}

function renderWrongBook() {
  const list = loadWrongBook();
  $("wrongInfo").textContent = list.length ? `錯題簿：共 ${list.length} 題` : "錯題簿：目前無錯題";
  $("startWrong").disabled = !list.length;
  $("toggleWrongList").hidden = !list.length;
  $("clearWrong").hidden = !list.length;
  if (!list.length) {
    $("wrongList").hidden = true;
    $("wrongList").innerHTML = "";
    $("toggleWrongList").textContent = "檢視錯題清單";
    return;
  }
  $("wrongList").innerHTML = list.map((q) => {
    const key = getQKey(q);
    const source = [q.exam, q.subject, q.num ? `第 ${q.num} 題` : ""].filter(Boolean).join("・") || "自訂題庫";
    const ansIndices = q.answers || [q.answer];
    return `
      <div class="wrong-card">
        <div class="wrong-meta">
          <span>${esc(source)}｜錯 ${q.wrongCount || 1} 次${q.lastTime ? `｜${esc(q.lastTime)}` : ""}</span>
          <div class="wrong-meta-actions">
            <button type="button" class="gemini-btn wrong-gemini" data-key="${esc(key)}" data-target="aiMode">✨ 問問 Gemini（自動帶入）</button>
            <button type="button" class="gemini-btn secondary wrong-gemini" data-key="${esc(key)}" data-target="geminiApp">Gemini App（複製貼上）</button>
            <button type="button" class="secondary wrong-remove" data-key="${esc(key)}">移出</button>
          </div>
        </div>
        <div class="q-title">${fmt(q.q)}</div>
        ${q.options.map((opt, j) => {
          const isAns = ansIndices.includes(j);
          const noteText = q.optionExplains?.[j];
          return `
            <div class="wrong-opt ${isAns ? "opt-correct" : ""}">
              <span class="opt-text">(${"ABCDEFGH"[j]}) ${fmt(opt)}</span>
              ${noteText ? `<div class="opt-note"><span class="opt-tag ${isAns ? "tag-right" : "tag-wrong"}">${isAns ? "✔ 正解選項" : "✘ 選項解析"}</span> ${fmt(noteText)}</div>` : ""}
            </div>`;
        }).join("")}
        ${q.explain ? `<p class="explain">${esc(q.explain)}</p>` : ""}
      </div>`;
  }).join("");
}

// ---------- 成績紀錄 ----------
function saveHistory(entry) {
  const h = JSON.parse(localStorage.getItem("examHistory") || "[]");
  h.unshift(entry);
  localStorage.setItem("examHistory", JSON.stringify(h.slice(0, 20)));
  renderHistory();
}

function renderHistory() {
  const h = JSON.parse(localStorage.getItem("examHistory") || "[]");
  $("history").hidden = !h.length;
  $("historyList").innerHTML = h
    .map((r) => `<tr><td>${esc(r.time)}</td><td>${esc(r.subject)}</td><td>${r.correct}/${r.total}</td><td>${r.pct}</td></tr>`)
    .join("");
}

$("clearHistory").onclick = () => {
  localStorage.removeItem("examHistory");
  renderHistory();
};

$("autoRemoveWrong").checked = localStorage.getItem("autoRemoveWrong") === "1";
$("autoRemoveWrong").onchange = () => {
  localStorage.setItem("autoRemoveWrong", $("autoRemoveWrong").checked ? "1" : "0");
};

$("toggleWrongList").onclick = () => {
  const willShow = $("wrongList").hidden;
  $("wrongList").hidden = !willShow;
  $("toggleWrongList").textContent = willShow ? "隱藏錯題清單" : "檢視錯題清單";
};

$("clearWrong").onclick = () => {
  if (!confirm("確定要清空所有錯題嗎？")) return;
  saveWrongBook([]);
};

$("wrongList").onclick = async (e) => {
  const gemBtn = e.target.closest(".wrong-gemini");
  if (gemBtn) {
    let q = loadWrongBook().find((item) => getQKey(item) === gemBtn.dataset.key);
    if (q && /[承呈同依]上題/.test(q.q) && !q.prevQ && !q.q.includes("【前題題幹】")) {
      let list = customBank;
      if (!list && manifest) {
        const chunk = chunkByPair.get(`${q.exam || ""}||${q.subject || ""}`);
        if (chunk) list = await loadChunk(chunk).catch(() => null);
      }
      if (list) {
        const idx = list.findIndex((x) => getQKey(x) === getQKey(q));
        const prev = idx > 0 ? list[idx - 1] : null;
        if (prev && prev.exam === q.exam && prev.subject === q.subject) q = { ...q, prevQ: prev.q };
      }
    }
    if (q) askGeminiWithQuestion(q, null, gemBtn, gemBtn.dataset.target || "aiMode");
    return;
  }
  const btn = e.target.closest(".wrong-remove");
  if (!btn) return;
  removeWrongQuestion(btn.dataset.key);
  renderWrongBook();
};

$("start").onclick = () => startQuiz("normal");
$("startWrong").onclick = () => startQuiz("wrong");
$("quiz").onsubmit = submit;
$("quiz").onclick = (e) => {
  const btn = e.target.closest(".gemini-btn");
  if (!btn) return;
  const q = picked[+btn.dataset.qidx];
  if (q) askGeminiWithQuestion(q, q.chosen, btn, btn.dataset.target || "aiMode");
};
$("retry").onclick = () => {
  if (lastMode === "wrong" && !loadWrongBook().length) {
    alert("錯題已全部移出錯題簿！");
    $("quiz").hidden = true;
    $("result").hidden = true;
    $("setup").hidden = false;
    window.scrollTo(0, 0);
    return;
  }
  startQuiz(lastMode);
};
$("backHome").onclick = () => {
  $("quiz").hidden = true;
  $("result").hidden = true;
  $("setup").hidden = false;
  window.scrollTo(0, 0);
};

$("noRepeatMode").value = localStorage.getItem("noRepeatMode") || "paper";
$("noRepeatHours").value = localStorage.getItem("noRepeatHours") || "12";
$("noRepeatMode").onchange = () => {
  localStorage.setItem("noRepeatMode", $("noRepeatMode").value);
  updateRepeatInfo();
};
$("noRepeatHours").onchange = () => {
  const val = String(Math.max(1, +$("noRepeatHours").value || 12));
  $("noRepeatHours").value = val;
  localStorage.setItem("noRepeatHours", val);
  updateRepeatInfo();
};
function onScopeChange() {
  updateRepeatInfo();
  maybePrefetchSelection();
}
$("exam").onchange = onScopeChange;
$("subject").onchange = onScopeChange;
$("resetSeen").onclick = () => {
  const seenMap = loadSeenMap();
  if (customBank) {
    for (const q of getFilteredCustomPool()) delete seenMap[getQKey(q)];
  } else if (manifest) {
    for (const c of getMatchingChunks()) {
      forEachChunkNum(c, (num) => { delete seenMap[getChunkQuestionKey(c, num)]; });
    }
  }
  saveSeenMap(seenMap);
  updateRepeatInfo();
};

localStorage.removeItem("examApiKey");

function buildMoexSyncCommand(input) {
  const val = String(input || "").trim() || "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx?y=2025&e=114090";
  if (val === "--opendata" || val.toLowerCase() === "opendata") return "node sync-moex.js --opendata";
  if (/^\d{2,4}$/.test(val)) return `node sync-moex.js --year ${val}`;
  return `node sync-moex.js "${val}"`;
}

async function reloadBuiltinBank() {
  chunkCache.clear();
  inFlightChunks.clear();
  localStorage.removeItem("examBank");
  customBank = null;
  await loadManifest(true);
  await loadBank();
}

function setMoexStatus(msg, cls = "") {
  const el = $("moexSyncStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = "moex-status" + (cls ? ` ${cls}` : "");
}

if ($("toggleMoexSync")) {
  $("toggleMoexSync").onclick = () => {
    $("moexSyncPanel").hidden = !$("moexSyncPanel").hidden;
  };
}

if ($("moexCopyCmdBtn")) {
  $("moexCopyCmdBtn").onclick = async () => {
    const cmd = buildMoexSyncCommand($("moexUrlInput").value);
    const ok = await copyTextToClipboard(cmd);
    setMoexStatus(ok ? `已複製同步指令到剪貼簿：${cmd}` : `請於終端機執行：${cmd}`, ok ? "ok" : "");
  };
}

if ($("moexSyncBtn")) {
  $("moexSyncBtn").onclick = async () => {
    const input = String($("moexUrlInput").value || "").trim() || "https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx?y=2025&e=114090";
    const cmd = buildMoexSyncCommand(input);
    const btn = $("moexSyncBtn");
    const isFile = typeof location !== "undefined" && location.protocol === "file:";

    if (!isFile && typeof fetch === "function") {
      btn.disabled = true;
      setMoexStatus("正在連線考選部考畢試題平臺下載試題、答案與更正答案並更新題庫，請稍候…");
      try {
        const payload = input === "--opendata" || input.toLowerCase() === "opendata"
          ? { opendata: true }
          : (/^\d{2,4}$/.test(input) ? { year: input } : { url: input });
        const resp = await fetch("/api/sync-moex", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const contentType = resp.headers?.get?.("content-type") || "";
        if (resp.ok && contentType.includes("application/json")) {
          const data = await resp.json();
          if (!data.ok) throw new Error(data.error || "同步失敗");
          await reloadBuiltinBank();
          const summaryText = (data.results || [])
            .map((r) => `${r.examCode}(${r.subjectCount}科・新下載${r.downloadedCount}檔)`)
            .join("、");
          setMoexStatus(
            `同步成功！${summaryText}，目前內建題庫共 ${manifest?.total || 0} 題。`,
            "ok"
          );
          btn.disabled = false;
          return;
        }
        if (resp.status === 400 && contentType.includes("application/json")) {
          const data = await resp.json();
          throw new Error(data.error || "輸入格式或同步參數錯誤");
        }
      } catch (err) {
        if (err && /輸入格式|不支援|考選部|找不到|HTTP/.test(err.message)) {
          setMoexStatus(`同步失敗：${err.message}`, "err");
          btn.disabled = false;
          return;
        }
      } finally {
        btn.disabled = false;
      }
    }

    const copied = await copyTextToClipboard(cmd);
    setMoexStatus(
      (copied ? "目前為靜態網頁模式（瀏覽器跨網域限制無法直接抓取考選部 PDF），已自動複製指令：" : "請先於專案資料夾執行：") +
        `${cmd}（若要在網頁內一鍵同步，請改用 node sync-moex.js --serve 開啟）`,
      ""
    );
  };
}

loadBank();
renderWrongBook();
renderHistory();
