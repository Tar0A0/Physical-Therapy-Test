const $ = (id) => document.getElementById(id);
const BUILTIN = window.QUESTIONS;
let all = BUILTIN;
let picked = [];

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

function start() {
  const exam = $("exam").value || "全部";
  const subject = $("subject").value;
  const pool = all.filter((q) => (exam === "全部" || q.exam === exam) && (subject === "全部" || q.subject === subject));
  if (!pool.length) return alert("此篩選條件下沒有題目");
  const n = Math.min(Math.max(1, +$("count").value || 1), pool.length);
  const mixOptions = $("mixOptions").checked;

  const groups = [];
  for (const q of pool) {
    if (groups.length && /[承呈同依]上題/.test(q.q) && groups[groups.length - 1][0].subject === q.subject && groups[groups.length - 1][0].exam === q.exam) {
      const grp = groups[groups.length - 1];
      grp.push({ ...q, prevQ: grp.map((p) => p.q).join("\n") });
    } else {
      groups.push([q]);
    }
  }
  const rawPicked = [];
  for (const g of shuffle(groups)) {
    if (rawPicked.length + g.length <= n) rawPicked.push(...g);
    if (rawPicked.length === n) break;
  }
  if (!rawPicked.length && groups.length) rawPicked.push(...groups[0]);

  picked = rawPicked.map((q) => {
    if (!mixOptions) return q;
    const order = shuffle(q.options.map((_, i) => i));
    const item = { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
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
    $("quiz").hidden = true;
    $("setup").hidden = false;
    window.scrollTo(0, 0);
  };

  $("setup").hidden = true;
  $("result").hidden = true;
  $("quiz").hidden = false;
  window.scrollTo(0, 0);
}

function submit(e) {
  e.preventDefault();
  let correct = 0;
  picked.forEach((q, i) => {
    const box = $(`q${i}`);
    const chosen = +box.querySelector("input:checked").value;
    const ok = q.answers ? q.answers.includes(chosen) : chosen === q.answer;
    if (ok) correct++;
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
      (source ? `<div class="q-source">出處：${esc(source)}</div>` : "");
    ex.hidden = false;
  });
  $("quiz").querySelector(".quiz-actions").remove();
  const pct = Math.round((correct / picked.length) * 100);
  $("score").textContent = `得分：${correct} / ${picked.length}（${pct} 分）`;
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth" });
  const exam = $("exam").value;
  const label = exam && exam !== "全部" ? `${exam}・${$("subject").value}` : $("subject").value;
  saveHistory({ time: new Date().toLocaleString(), subject: label, correct, total: picked.length, pct });
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

$("start").onclick = start;
$("quiz").onsubmit = submit;
$("retry").onclick = () => {
  $("quiz").hidden = true;
  $("result").hidden = true;
  $("setup").hidden = false;
  window.scrollTo(0, 0);
};

loadBank();
renderHistory();
