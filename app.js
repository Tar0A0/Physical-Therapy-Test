const $ = (id) => document.getElementById(id);
const BUILTIN = window.QUESTIONS;
let all = BUILTIN;
let picked = [];
let lastMode = "normal";

// ---------- 題庫：內建 or 匯入的 CSV（存在瀏覽器 localStorage） ----------
function loadBank() {
  const saved = JSON.parse(localStorage.getItem("examBank") || "null");
  all = saved && saved.length ? saved : BUILTIN;
  $("bankInfo").textContent = saved && saved.length
    ? `目前題庫：匯入的 CSV（${all.length} 題）`
    : `目前題庫：考畢題答（${all.length} 題）`;
  const exams = ["全部", ...new Set(all.map((q) => q.exam).filter(Boolean))];
  $("exam").innerHTML = exams.map((x) => `<option>${esc(x)}</option>`).join("");
  $("exam").closest("label").hidden = exams.length <= 1;
  const subjects = ["全部", ...new Set(all.map((q) => q.subject))];
  $("subject").innerHTML = subjects.map((s) => `<option>${esc(s)}</option>`).join("");
  updateRepeatInfo();
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

function isQuestionSeen(q, seenMap, now, winMs) {
  if (winMs === null) return false;
  const ts = seenMap[getQKey(q)];
  if (!ts) return false;
  if (winMs === Infinity) return true;
  return now - ts < winMs;
}

function getFilteredPool() {
  const exam = $("exam").value || "全部";
  const subject = $("subject").value || "全部";
  return all.filter((q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject));
}

function updateRepeatInfo() {
  if (!$("noRepeatMode")) return;
  const mode = $("noRepeatMode").value;
  $("customHoursWrap").hidden = mode !== "custom";
  const basePool = getFilteredPool();
  const seenMap = loadSeenMap();
  const now = Date.now();
  const winMs = getRepeatWindowMs();
  let seenCount = 0;
  let everSeenCount = 0;
  for (const q of basePool) {
    if (seenMap[getQKey(q)]) everSeenCount++;
    if (isQuestionSeen(q, seenMap, now, winMs)) seenCount++;
  }
  const availCount = basePool.length - seenCount;
  if (mode === "off") {
    $("repeatInfo").textContent = `目前範圍共 ${basePool.length} 題（未限制重複；此範圍曾抽過 ${everSeenCount} 題）`;
  } else if (mode === "paper") {
    $("repeatInfo").textContent = `目前考卷／範圍剩餘未抽：${availCount} / ${basePool.length} 題（已抽過 ${seenCount} 題）`;
  } else {
    $("repeatInfo").textContent = `目前範圍於設定時效內可抽：${availCount} / ${basePool.length} 題（時效內已抽過 ${seenCount} 題）`;
  }
  $("resetSeen").hidden = (mode === "off" ? everSeenCount : seenCount) === 0;
}

function startQuiz(mode = "normal") {
  lastMode = mode;
  const exam = $("exam").value || "全部";
  const subject = $("subject").value;
  let pool;

  if (mode === "wrong") {
    const wrongAll = loadWrongBook();
    if (!wrongAll.length) return alert("目前錯題簿沒有題目");
    const filtered = wrongAll.filter((q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject));
    const chosenWrong = filtered.length ? filtered : wrongAll;
    pool = chosenWrong.map((q) => {
      if (!/[承呈同依]上題/.test(q.q)) return q;
      const idx = all.findIndex((x) => getQKey(x) === getQKey(q));
      const prev = idx > 0 ? all[idx - 1] : null;
      if (prev && prev.exam === q.exam && prev.subject === q.subject) {
        return { ...q, prevStem: prev.q };
      }
      return q;
    });
  } else {
    pool = getFilteredPool();
  }
  if (!pool.length) return alert("此篩選條件下沒有題目");

  const n = Math.min(Math.max(1, +$("count").value || 1), pool.length);
  const mixOptions = $("mixOptions").checked;
  const winMs = getRepeatWindowMs();
  const seenMap = loadSeenMap();
  const now = Date.now();

  let rawPicked = [];
  if (mode === "wrong") {
    let unseenWrong = winMs === null ? pool : pool.filter((q) => !isQuestionSeen(q, seenMap, now, winMs));
    if (!unseenWrong.length) {
      if (!confirm("錯題簿在此範圍內的題目於目前防重複條件下已全部抽過！是否重置此範圍錯題的已抽紀錄並繼續測驗？")) return;
      for (const q of pool) delete seenMap[getQKey(q)];
      saveSeenMap(seenMap);
      updateRepeatInfo();
      unseenWrong = pool;
    }
    rawPicked = shuffle(unseenWrong).slice(0, n);
  } else {
    const groups = [];
    for (const q of pool) {
      if (groups.length && /[承呈同依]上題/.test(q.q) && groups[groups.length - 1][0].subject === q.subject && groups[groups.length - 1][0].exam === q.exam) {
        const grp = groups[groups.length - 1];
        grp.push({ ...q, prevQ: grp.map((p) => p.q).join("\n") });
      } else {
        groups.push([q]);
      }
    }
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

function loadWrongBook() {
  const saved = JSON.parse(localStorage.getItem("wrongBook") || "[]");
  const byKey = new Map(all.map((q) => [getQKey(q), q]));
  return saved.map((item) => {
    const canon = byKey.get(getQKey(item));
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

$("wrongList").onclick = (e) => {
  const gemBtn = e.target.closest(".wrong-gemini");
  if (gemBtn) {
    let q = loadWrongBook().find((item) => getQKey(item) === gemBtn.dataset.key);
    if (q && /[承呈同依]上題/.test(q.q) && !q.prevQ && !q.q.includes("【前題題幹】")) {
      const idx = all.findIndex((x) => getQKey(x) === getQKey(q));
      const prev = idx > 0 ? all[idx - 1] : null;
      if (prev && prev.exam === q.exam && prev.subject === q.subject) q = { ...q, prevQ: prev.q };
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
$("exam").onchange = updateRepeatInfo;
$("subject").onchange = updateRepeatInfo;
$("resetSeen").onclick = () => {
  const seenMap = loadSeenMap();
  for (const q of getFilteredPool()) delete seenMap[getQKey(q)];
  saveSeenMap(seenMap);
  updateRepeatInfo();
};

localStorage.removeItem("examApiKey");
loadBank();
renderWrongBook();
renderHistory();
