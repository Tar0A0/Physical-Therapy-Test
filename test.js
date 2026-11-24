const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const BASE_URL = "https://example.com/Physical-Therapy-Test/";

function makeClassList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return Boolean(force);
    },
    contains: (c) => set.has(c),
  };
}

function makeCacheStorage() {
  const stores = new Map();
  let putCount = 0;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      async addAll(urls) {
        for (const u of urls) {
          const abs = new URL(u, BASE_URL).href;
          map.set(abs, { ok: true, status: 200, url: abs, body: "v1-shell", clone() { return this; } });
        }
      },
      async match(req, opts = {}) {
        const raw = typeof req === "string" ? req : req.url;
        const abs = new URL(raw, BASE_URL).href;
        if (map.has(abs)) return map.get(abs);
        if (opts.ignoreSearch) {
          const clean = abs.split("?")[0];
          for (const [k, v] of map.entries()) {
            if (k.split("?")[0] === clean) return v;
          }
        }
        return undefined;
      },
      async put(req, resp) {
        putCount++;
        const raw = typeof req === "string" ? req : req.url;
        const abs = new URL(raw, BASE_URL).href;
        map.set(abs, resp);
      },
      async keys() {
        return [...map.keys()].map((url) => ({ url }));
      },
      async delete(req) {
        const raw = typeof req === "string" ? req : req.url;
        const abs = new URL(raw, BASE_URL).href;
        return map.delete(abs);
      },
    };
  };
  return {
    stores,
    get putCount() { return putCount; },
    resetPutCount() { putCount = 0; },
    open,
    async keys() { return [...stores.keys()]; },
    async delete(k) { return stores.delete(k); },
  };
}

function createAppHarness({ initialStorage = {}, hasSwController = false, popupAllowed = true } = {}) {
  const elements = new Map();
  const chips = [];
  const scrolled = [];
  const winListeners = new Map();
  const docListeners = new Map();
  const fetchedUrls = [];
  const appCaches = makeCacheStorage();
  const store = new Map(Object.entries(initialStorage));
  let online = true;
  let registeredSw = null;

  const makeEl = (id) => {
    const el = {
      id,
      value: "",
      textContent: "",
      hidden: id === "installPwaBtn" || id === "noticeBar" || id === "recentHistoryWrap",
      disabled: false,
      checked: id === "mixOptions",
      className: "",
      classList: makeClassList(),
      dataset: {},
      style: {},
      attrs: {},
      offsetHeight: id === "quizNav" ? 104 : 0,
      _checkedIdx: null,
      closest() { return { hidden: false }; },
      querySelector(sel) {
        if (sel === "input:checked") return this._checkedIdx !== null ? { value: String(this._checkedIdx) } : null;
        if (sel === ".explain") return (this._ex ||= makeEl(`${id}_ex`));
        if (sel === ".quiz-actions") return { remove() {} };
        const cm = sel.match(/^\.q-chip\[data-qidx="(\d+)"\]$/);
        if (cm) return chips[+cm[1]] || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".q-chip.current") return chips.filter((c) => c.classList.contains("current"));
        if (sel === "input") return [{ disabled: false }, { disabled: false }, { disabled: false }, { disabled: false }];
        if (sel === "label.opt-item") {
          return (this._labels ||= [0, 1, 2, 3].map((j) => ({
            classList: makeClassList(),
            querySelector: () => makeEl(`${id}_n_${j}`),
          })));
        }
        return [];
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      focus() {},
      select() {},
      scrollIntoView() { scrolled.push(id); },
    };
    Object.defineProperty(el, "innerHTML", {
      get() { return this._html || ""; },
      set(v) {
        this._html = String(v);
        if (id === "exam" || id === "subject") {
          const opts = [...this._html.matchAll(/<option>(.*?)<\/option>/g)].map((m) => m[1]);
          this.options = opts;
          if (!opts.includes(this.value)) this.value = opts[0] || "";
        }
        if (id === "quiz") {
          chips.length = 0;
          for (const m of this._html.matchAll(/class="q-chip" data-qidx="(\d+)"/g)) {
            const chip = makeEl(`chip_${m[1]}`);
            chip.classList.add("q-chip");
            chip.dataset = { qidx: m[1] };
            chips.push(chip);
          }
        }
      },
    });
    return el;
  };

  const getEl = (id) => (elements.has(id) ? elements.get(id) : (elements.set(id, makeEl(id)), elements.get(id)));
  getEl("count").value = "5";
  getEl("noRepeatMode").value = "paper";
  getEl("noRepeatHours").value = "12";
  getEl("mixOptions").checked = false;

  const ctx = {
    document: {
      getElementById: getEl,
      createElement: () => makeEl("tmp"),
      body: { appendChild() {}, removeChild() {} },
      addEventListener: (ev, fn) => docListeners.set(ev, fn),
      removeEventListener: (ev, fn) => { if (docListeners.get(ev) === fn) docListeners.delete(ev); },
    },
    window: {
      scrollTo() {},
      isSecureContext: false,
      open: () => (popupAllowed ? {} : null),
      addEventListener: (ev, fn) => winListeners.set(ev, fn),
    },
    location: { protocol: "https:", href: BASE_URL },
    navigator: {
      get onLine() { return online; },
      serviceWorker: {
        get controller() { return hasSwController ? {} : null; },
        register: async (p) => { registeredSw = p; },
      },
    },
    caches: appCaches,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url) => {
      const u = String(url);
      fetchedUrls.push(u);
      const abs = new URL(u, BASE_URL).href;
      if (!online) {
        const c = await appCaches.open("pt-exam-data-v1");
        const hit = await c.match(abs);
        if (hit) return hit;
        throw new Error("Offline");
      }
      const rel = u.split("?")[0].replace(/^\//, "");
      const buf = fs.readFileSync(rel);
      return {
        ok: true,
        status: 200,
        url: abs,
        clone() { return this; },
        async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
      };
    },
    alert: () => { throw new Error("Browser alert() must never be called"); },
    confirm: () => { throw new Error("Browser confirm() must never be called"); },
    Blob,
    Response,
    DecompressionStream,
    TextDecoder,
    URL,
    console,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(fs.readFileSync("app.js", "utf8"), ctx);

  return {
    ctx,
    getEl,
    chips,
    scrolled,
    store,
    appCaches,
    fetchedUrls,
    winListeners,
    setOnline: (v) => { online = v; },
    getRegisteredSw: () => registeredSw,
    async waitReady() {
      for (let i = 0; i < 40; i++) {
        if (getEl("exam").options && getEl("exam").options.length > 1) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

async function testChunksAndDecompression() {
  const man = JSON.parse(fs.readFileSync("data/manifest.json", "utf8"));
  assert.strictEqual(man.exams.length, 16);
  assert.strictEqual(man.subjects.length, 6);
  assert.strictEqual(man.total, 7680);
  assert.strictEqual(man.chunks.length, 96);

  let total = 0;
  for (const c of man.chunks) {
    const gz = new Uint8Array(fs.readFileSync(path.join("data/chunks", c.file)));
    assert.strictEqual(gz[0], 0x1f);
    assert.strictEqual(gz[1], 0x8b);
    const arr = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
    assert.strictEqual(arr.length, c.count);
    total += arr.length;
  }
  assert.strictEqual(total, 7680);
}

async function testServiceWorker() {
  const swCaches = makeCacheStorage();
  swCaches.stores.set("old-cache", new Map([["stale", 1]]));
  const handlers = {};
  let online = true;
  let netFetches = [];
  let serverHtml = "v2-fresh-html";

  const swCtx = {
    URL,
    caches: swCaches,
    self: {
      location: { origin: "https://example.com", href: `${BASE_URL}sw.js` },
      addEventListener: (ev, fn) => { handlers[ev] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    fetch: async (req) => {
      const u = typeof req === "string" ? req : req.url;
      netFetches.push(u);
      if (!online) throw new Error("offline");
      return { ok: true, status: 200, url: u, body: serverHtml, clone() { return { ...this }; } };
    },
  };
  vm.runInNewContext(fs.readFileSync("sw.js", "utf8"), swCtx);

  let p;
  handlers.install({ waitUntil: (x) => { p = x; } });
  await p;
  assert.strictEqual(swCaches.stores.get("pt-exam-app-v1").size, 8);

  handlers.activate({ waitUntil: (x) => { p = x; } });
  await p;
  assert(!swCaches.stores.has("old-cache"));

  // Chunk cache-first
  netFetches = [];
  let respP;
  handlers.fetch({ request: { method: "GET", url: `${BASE_URL}data/chunks/115-2_s3.json.gz?v=1`, mode: "cors" }, respondWith: (x) => { respP = x; } });
  await respP;
  assert.strictEqual(netFetches.length, 1);

  netFetches = [];
  handlers.fetch({ request: { method: "GET", url: `${BASE_URL}data/chunks/115-2_s3.json.gz?v=1`, mode: "cors" }, respondWith: (x) => { respP = x; } });
  await respP;
  assert.strictEqual(netFetches.length, 0);

  // Online root visit updates "./" and offline navigate returns updated HTML
  handlers.fetch({ request: { method: "GET", url: BASE_URL, mode: "navigate" }, respondWith: (x) => { respP = x; } });
  await respP;
  online = false;
  handlers.fetch({ request: { method: "GET", url: `${BASE_URL}?from=homescreen`, mode: "navigate" }, respondWith: (x) => { respP = x; } });
  const nav = await respP;
  assert.strictEqual(nav.body, "v2-fresh-html");
}

async function testLazySamplingAndFallbackCap() {
  const h = createAppHarness();
  await h.waitReady();

  // Only manifest fetched on startup
  assert.deepStrictEqual(h.fetchedUrls, ["data/manifest.json"]);

  // Single scope loads 1 chunk
  h.fetchedUrls.length = 0;
  h.getEl("exam").value = "115年第二次";
  h.getEl("subject").value = "神經疾病物理治療學";
  h.getEl("count").value = "5";
  await h.ctx.startQuiz("normal");
  assert.strictEqual(h.fetchedUrls.length, 1);
  assert.strictEqual(vm.runInNewContext("picked.length", h.ctx), 5);

  // All x All count=1 loads <= 1 chunk; count=10 loads <= 10 chunks
  h.fetchedUrls.length = 0;
  h.getEl("exam").value = "全部";
  h.getEl("subject").value = "全部";
  h.getEl("count").value = "1";
  await h.ctx.startQuiz("normal");
  assert(h.fetchedUrls.length <= 1);

  h.fetchedUrls.length = 0;
  h.getEl("count").value = "10";
  await h.ctx.startQuiz("normal");
  assert(h.fetchedUrls.length <= 10);
  assert.strictEqual(vm.runInNewContext("picked.length", h.ctx), 10);

  // Fallback loop cap: when count=1 hits only a 2-question 承上題 group in a chunk, stops after <= 2 chunks total
  const s3 = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/chunks/115-2_s3.json.gz")).toString("utf8"));
  const gIdx = s3.findIndex((q) => /[承呈同依]上題/.test(q.q));
  assert(gIdx > 0);
  const seenOnlyGroupUnseen = {};
  for (const c of vm.runInNewContext("manifest.chunks", h.ctx)) {
    for (let num = 1; num <= c.count; num++) {
      if (c.file === "115-2_s3.json.gz" && (num === s3[gIdx - 1].num || num === s3[gIdx].num)) continue;
      seenOnlyGroupUnseen[`${c.exam}||${c.subject}||${num}`] = Date.now();
    }
  }
  const hCap = createAppHarness({ initialStorage: { seenQuestions: JSON.stringify(seenOnlyGroupUnseen) } });
  await hCap.waitReady();
  hCap.fetchedUrls.length = 0;
  hCap.getEl("exam").value = "115年第二次";
  hCap.getEl("subject").value = "神經疾病物理治療學";
  hCap.getEl("count").value = "1";
  await hCap.ctx.startQuiz("normal");
  assert.strictEqual(hCap.fetchedUrls.length, 1);
  assert.strictEqual(vm.runInNewContext("picked.length", hCap.ctx), 2);
}

async function testBlankSubmitAndRaces() {
  const h = createAppHarness();
  await h.waitReady();
  h.getEl("exam").value = "115年第二次";
  h.getEl("subject").value = "神經疾病物理治療學";
  h.getEl("count").value = "3";

  // 1. Blank submit -> confirm -> grades blanks as wrong
  await h.ctx.startQuiz("normal");
  const p0 = vm.runInNewContext("picked", h.ctx);
  h.getEl("q0")._checkedIdx = p0[0].answer;
  h.getEl("q1")._checkedIdx = null;
  h.getEl("q2")._checkedIdx = null;
  const s0 = h.ctx.submit({ preventDefault() {} });
  assert(h.getEl("noticeBar").innerHTML.includes("還有 2 題未作答"));
  h.getEl("noticeConfirm").onclick();
  await s0;
  assert.strictEqual(h.getEl("score").textContent, "得分：1 / 3（33 分，未作答 2 題）");

  // 2. Fill missed question while banner is open, then click Submit again (no deadlock, no scroll to q2)
  h.getEl("result").hidden = true;
  await h.ctx.startQuiz("normal");
  const p1 = vm.runInNewContext("picked", h.ctx);
  h.getEl("q0")._checkedIdx = p1[0].answer;
  h.getEl("q1")._checkedIdx = p1[1].answer;
  h.getEl("q2")._checkedIdx = null;
  h.scrolled.length = 0;
  const firstSub = h.ctx.submit({ preventDefault() {} });
  h.getEl("q2")._checkedIdx = p1[2].answer;
  await h.ctx.submit({ preventDefault() {} });
  await firstSub;
  assert.deepStrictEqual(h.scrolled, ["result"]);
  assert.strictEqual(h.getEl("score").textContent, "得分：3 / 3（100 分）");

  // 3. Fill missed question while banner is open, then click 仍要交卷 -> actualUnanswered = 0
  h.getEl("result").hidden = true;
  await h.ctx.startQuiz("normal");
  const p2 = vm.runInNewContext("picked", h.ctx);
  h.getEl("q0")._checkedIdx = p2[0].answer;
  h.getEl("q1")._checkedIdx = p2[1].answer;
  h.getEl("q2")._checkedIdx = null;
  const s2 = h.ctx.submit({ preventDefault() {} });
  h.getEl("q2")._checkedIdx = p2[2].answer;
  h.getEl("noticeConfirm").onclick();
  await s2;
  assert.strictEqual(h.getEl("score").textContent, "得分：3 / 3（100 分）");
}

async function testStatsAndTrends() {
  const h = createAppHarness({
    initialStorage: {
      examHistory: JSON.stringify([
        { time: "t2", subject: "115年第二次・神經疾病物理治療學", correct: 2, total: 5, pct: 40 },
        { time: "t1", subject: "全部", correct: 5, total: 10, pct: 50 },
        { time: "t0", subject: "[錯題] 骨科疾病物理治療學", correct: 4, total: 5, pct: 80 },
      ]),
    },
  });
  await h.waitReady();

  const migrated = JSON.parse(h.store.get("subjectStats"));
  assert.strictEqual(migrated["神經疾病物理治療學"].total, 5);
  assert.strictEqual(migrated["骨科疾病物理治療學"].total, 5);
  assert.strictEqual(migrated["全部"], undefined);
  assert(h.getEl("subjectStatsList").innerHTML.indexOf("神經疾病物理治療學") < h.getEl("subjectStatsList").innerHTML.indexOf("骨科疾病物理治療學"));
  assert.strictEqual(h.ctx.computeSubjectTrend([{ c: 1, t: 2 }]).label, "首次作答");
  assert.strictEqual(h.ctx.computeSubjectTrend([{ c: 2, t: 5 }, { c: 2, t: 5 }, { c: 4, t: 5 }, { c: 5, t: 5 }]).cls, "trend-up");
  assert.strictEqual(h.ctx.computeSubjectTrend([{ c: 5, t: 5 }, { c: 4, t: 5 }, { c: 2, t: 5 }, { c: 1, t: 5 }]).cls, "trend-down");

  // 25 mixed-subject submits -> cumulative stats exceed 20-entry examHistory cap
  h.store.delete("subjectStats");
  h.store.delete("examHistory");
  h.getEl("exam").value = "全部";
  h.getEl("subject").value = "全部";
  h.getEl("count").value = "4";
  for (let i = 0; i < 25; i++) {
    await h.ctx.startQuiz("normal");
    const p = vm.runInNewContext("picked", h.ctx);
    p.forEach((q, idx) => { h.getEl(`q${idx}`)._checkedIdx = q.answer; });
    await h.ctx.submit({ preventDefault() {} });
  }
  const cum = JSON.parse(h.store.get("subjectStats"));
  assert.strictEqual(Object.values(cum).reduce((s, v) => s + v.total, 0), 100);
  assert.strictEqual(JSON.parse(h.store.get("examHistory")).length, 20);
}

async function testPwaAndPopupFallback() {
  // Without SW controller: downloadAllChunksOffline puts 96 chunks once each
  const hNoCtrl = createAppHarness({ hasSwController: false });
  await hNoCtrl.waitReady();
  assert.strictEqual(hNoCtrl.getRegisteredSw(), "./sw.js");
  hNoCtrl.appCaches.resetPutCount();
  await hNoCtrl.getEl("offlineCacheBtn").onclick();
  assert.strictEqual(hNoCtrl.appCaches.putCount, 96);
  assert.strictEqual(hNoCtrl.getEl("offlineCacheBtn").textContent, "離線題庫已就緒（96/96）");

  // Offline startQuiz succeeds from cache; uncached shows offline notice
  hNoCtrl.setOnline(false);
  vm.runInNewContext("chunkCache.clear()", hNoCtrl.ctx);
  hNoCtrl.getEl("exam").value = "115年第二次";
  hNoCtrl.getEl("subject").value = "神經疾病物理治療學";
  await hNoCtrl.ctx.startQuiz("normal");
  assert.strictEqual(vm.runInNewContext("picked.length", hNoCtrl.ctx), 5);

  await (await hNoCtrl.appCaches.open("pt-exam-data-v1")).delete(
    hNoCtrl.ctx.resolveAppUrl(hNoCtrl.ctx.getChunkUrl(vm.runInNewContext('chunkByPair.get("108年第一次||骨科疾病物理治療學")', hNoCtrl.ctx)))
  );
  vm.runInNewContext("chunkCache.clear()", hNoCtrl.ctx);
  hNoCtrl.getEl("exam").value = "108年第一次";
  hNoCtrl.getEl("subject").value = "骨科疾病物理治療學";
  await hNoCtrl.ctx.startQuiz("normal");
  assert(hNoCtrl.getEl("noticeBar").innerHTML.includes("離線下載全題庫"));

  // With SW controller: downloadAllChunksOffline performs 0 duplicate main-thread cache.put calls
  const hCtrl = createAppHarness({ hasSwController: true, popupAllowed: false });
  await hCtrl.waitReady();
  hCtrl.appCaches.resetPutCount();
  await hCtrl.getEl("offlineCacheBtn").onclick();
  assert.strictEqual(hCtrl.appCaches.putCount, 0);

  // Popup-blocked window.open shows fallback link in noticeBar
  await hCtrl.ctx.askGeminiWithQuestion({
    exam: "115年第二次",
    subject: "神經疾病物理治療學",
    num: 1,
    q: "測試題幹",
    options: ["A", "B", "C", "D"],
    answer: 0,
  }, 0, null, "aiMode");
  assert(hCtrl.getEl("noticeBar").innerHTML.includes("開啟 Gemini ↗"));
}

async function testFirstTimeUiDefaults() {
  const h = createAppHarness();
  const presetBtns = [10, 20, 50, 80].map((n) => ({
    dataset: { count: String(n) },
    classList: makeClassList(),
  }));
  h.getEl("countPresets").querySelectorAll = () => presetBtns;
  h.getEl("count").value = "10";
  h.ctx.syncCountPresetUI();

  await h.waitReady();

  // Friendly bank label and hidden resetBank when using built-in bank
  assert(h.getEl("bankInfo").textContent.includes("歷屆國考題庫（108–115 年，共 7,680 題）"));
  assert.strictEqual(h.getEl("resetBank").hidden, true);

  // Calm empty wrong-book state
  assert(h.getEl("wrongSection").classList.contains("is-empty"));
  assert.strictEqual(h.getEl("wrongActions").hidden, true);

  // Preset click updates #count and active class
  assert(presetBtns[0].classList.contains("active"));
  h.getEl("countPresets").onclick({ target: { closest: () => presetBtns[2] } });
  assert.strictEqual(h.getEl("count").value, "50");
  assert(!presetBtns[0].classList.contains("active") && presetBtns[2].classList.contains("active"));

  // CSV bank unhides resetBank; adding a wrong question unhides wrongActions
  h.store.set("examBank", JSON.stringify([{ subject: "骨科", q: "題目", options: ["A", "B"], answer: 0 }]));
  await h.ctx.loadBank();
  assert.strictEqual(h.getEl("resetBank").hidden, false);

  h.ctx.addWrongQuestion({ exam: "115年第二次", subject: "神經疾病物理治療學", num: 1, q: "錯題", options: ["A", "B"], answer: 0 });
  h.ctx.renderWrongBook();
  assert(!h.getEl("wrongSection").classList.contains("is-empty"));
  assert.strictEqual(h.getEl("wrongActions").hidden, false);
}

(async () => {
  await testChunksAndDecompression();
  await testServiceWorker();
  await testLazySamplingAndFallbackCap();
  await testBlankSubmitAndRaces();
  await testStatsAndTrends();
  await testPwaAndPopupFallback();
  await testFirstTimeUiDefaults();
  console.log("All test.js suites passed!");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
