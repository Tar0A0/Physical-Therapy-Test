const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BASE = __dirname;
const BANK_ROOT = path.join(BASE, "題庫");
const IMG_DIR = path.join(BASE, "img");
fs.mkdirSync(IMG_DIR, { recursive: true });

// Minimal PNG encoder for raw RGB24 buffers extracted from FlateDecode PDF images
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function rgbToPng(rgb, width, height) {
  const stride = width * 3;
  if (rgb.length !== stride * height) throw new Error(`RGB size mismatch: got ${rgb.length}, expected ${stride * height}`);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function mulMat(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function unescapePdfStr(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      const n = s[++i];
      if (n === "n") bytes.push(10);
      else if (n === "r") bytes.push(13);
      else if (n === "t") bytes.push(9);
      else if (n === "b") bytes.push(8);
      else if (n === "f") bytes.push(12);
      else if (n >= "0" && n <= "7") {
        let oct = n;
        if (s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        if (s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        bytes.push(parseInt(oct, 8));
      } else bytes.push(n.charCodeAt(0));
    } else bytes.push(s.charCodeAt(i));
  }
  return bytes;
}

function decodePdfText(hex, rawStr, curFont) {
  let txt = "";
  if (hex) {
    if (curFont) for (let i = 0; i < hex.length; i += 4) txt += curFont[parseInt(hex.slice(i, i + 4), 16)] ?? "";
    else for (let i = 0; i < hex.length; i += 2) txt += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  } else if (rawStr !== undefined) {
    const bytes = unescapePdfStr(rawStr);
    if (curFont) for (let i = 0; i < bytes.length; i += 2) txt += curFont[(bytes[i] << 8) | bytes[i + 1]] ?? "";
    else txt = Buffer.from(bytes).toString("latin1");
  }
  return txt;
}

function parsePdfObjects(filePath) {
  const buf = fs.readFileSync(filePath);
  const str = buf.toString("latin1");
  const objs = {};
  for (const m of str.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) {
    const id = m[1];
    const body = m[2];
    const sIdx = body.indexOf("stream");
    if (sIdx !== -1) {
      const dict = body.slice(0, sIdx);
      const start = m.index + m[0].indexOf("stream") + 6;
      const nl = str[start] === "\r" && str[start + 1] === "\n" ? 2 : (str[start] === "\n" || str[start] === "\r" ? 1 : 0);
      const dataStart = start + nl;
      let dataEnd = str.indexOf("endstream", dataStart);
      if (str[dataEnd - 1] === "\n") dataEnd--;
      if (str[dataEnd - 1] === "\r") dataEnd--;
      const lenMatch = dict.match(/\/Length\s+(\d+)\b(?!\s+0\s+R)/);
      const raw = lenMatch ? buf.subarray(dataStart, dataStart + parseInt(lenMatch[1], 10)) : buf.subarray(dataStart, dataEnd);
      const isImg = /\/Subtype\s*\/Image/.test(dict);
      let stream = "";
      if (!isImg) {
        if (dict.includes("FlateDecode")) {
          try { stream = zlib.inflateSync(raw).toString("latin1"); } catch {}
        } else {
          stream = raw.toString("latin1");
        }
      }
      objs[id] = { dict, stream, raw: isImg ? raw : null };
    } else {
      objs[id] = { dict: body, stream: "", raw: null };
    }
  }
  // Unpack PDF 1.5+ /Type /ObjStm compressed object streams
  for (const o of Object.values(objs)) {
    if (!/\/Type\s*\/ObjStm\b/.test(o.dict) || !o.stream) continue;
    const n = +(o.dict.match(/\/N\s+(\d+)/)?.[1] || 0);
    const first = +(o.dict.match(/\/First\s+(\d+)/)?.[1] || 0);
    if (!n || !first) continue;
    const nums = o.stream.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
      const oid = String(nums[i * 2]);
      const start = first + nums[i * 2 + 1];
      const end = i + 1 < n ? first + nums[(i + 1) * 2 + 1] : o.stream.length;
      if (!objs[oid]) objs[oid] = { dict: o.stream.slice(start, end), stream: "", raw: null };
    }
  }
  return objs;
}

function buildFontCmaps(objs) {
  const cmaps = {};
  for (const [id, o] of Object.entries(objs)) {
    if (!o.stream.includes("begincmap")) continue;
    const map = {};
    for (const bm of o.stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of bm[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map[parseInt(pair[1], 16)] = String.fromCodePoint(parseInt(pair[2], 16));
      }
    }
    for (const rm of o.stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const rng of rm[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const s = parseInt(rng[1], 16), e = parseInt(rng[2], 16), d = parseInt(rng[3], 16);
        for (let c = s; c <= e; c++) map[c] = String.fromCodePoint(d + (c - s));
      }
    }
    cmaps[id] = map;
  }
  const fontObjToCmap = {};
  for (const [fid, o] of Object.entries(objs)) {
    const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (tu && cmaps[tu[1]]) {
      fontObjToCmap[fid] = cmaps[tu[1]];
    } else if (o.dict.includes("WinCharSetFFFF")) {
      const map = {};
      for (let k = 0; k < 10; k++) map[0x835b + k] = String.fromCodePoint(0x2460 + k);
      fontObjToCmap[fid] = map;
    }
  }
  return fontObjToCmap;
}

function decodeFlateImageToRgb(o, objs, w, h) {
  const inf = zlib.inflateSync(o.raw);
  let rgb;
  if (inf.length === w * h * 3) {
    rgb = Buffer.from(inf);
  } else if (inf.length === w * h) {
    rgb = Buffer.alloc(w * h * 3);
    let pal = null;
    const csRef = o.dict.match(/\/ColorSpace\s+(\d+)\s+0\s+R/);
    const csStr = csRef && objs[csRef[1]] ? objs[csRef[1]].dict : o.dict;
    if (csStr.includes("/Indexed")) {
      const pm = csStr.match(/\(((?:\\.|[^\\()])*)\)\s*\]/);
      if (pm) {
        pal = Buffer.from(unescapePdfStr(pm[1]));
      } else {
        const hm = csStr.match(/<([0-9A-Fa-f\s]+)>\s*\]/);
        if (hm) pal = Buffer.from(hm[1].replace(/\s+/g, ""), "hex");
      }
    }
    for (let i = 0; i < w * h; i++) {
      const v = inf[i];
      if (pal && v * 3 + 2 < pal.length) {
        rgb[i * 3] = pal[v * 3];
        rgb[i * 3 + 1] = pal[v * 3 + 1];
        rgb[i * 3 + 2] = pal[v * 3 + 2];
      } else {
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
      }
    }
  } else {
    throw new Error(`Unsupported Flate image buffer length ${inf.length} for ${w}x${h}`);
  }
  const smRef = o.dict.match(/\/SMask\s+(\d+)\s+0\s+R/);
  if (smRef && objs[smRef[1]]?.raw) {
    const mask = zlib.inflateSync(objs[smRef[1]].raw);
    if (mask.length === w * h) {
      for (let i = 0; i < w * h; i++) {
        const a = mask[i];
        rgb[i * 3] = Math.round((rgb[i * 3] * a + 255 * (255 - a)) / 255);
        rgb[i * 3 + 1] = Math.round((rgb[i * 3 + 1] * a + 255 * (255 - a)) / 255);
        rgb[i * 3 + 2] = Math.round((rgb[i * 3 + 2] * a + 255 * (255 - a)) / 255);
      }
    }
  }
  if (w <= 40 && h <= 40 && rgb.every((b) => b === 255)) return null;
  return rgbToPng(rgb, w, h);
}

function extractImages(objs, code, jpxQueue) {
  const smaskIds = new Set();
  for (const o of Object.values(objs)) {
    const sm = o.dict?.match(/\/SMask\s+(\d+)\s+0\s+R/);
    if (sm) smaskIds.add(sm[1]);
  }
  const imgTags = {};
  for (const [id, o] of Object.entries(objs)) {
    if (smaskIds.has(id)) continue;
    if (!o.raw || !/\/Subtype\s*\/Image/.test(o.dict)) continue;
    const w = +(o.dict.match(/\/Width\s+(\d+)/)?.[1] || 0);
    const h = +(o.dict.match(/\/Height\s+(\d+)/)?.[1] || 0);
    const isJpx = o.dict.includes("JPXDecode");
    const isJpg = o.dict.includes("DCTDecode");
    const ext = isJpg ? "jpg" : "png";
    const file = `${code}_${id}.${ext}`;
    const outPath = path.join(IMG_DIR, file);
    if (isJpx) {
      jpxQueue.push({ jp2Buf: o.raw, w, h, outPath });
    } else if (!isJpg) {
      const data = decodeFlateImageToRgb(o, objs, w, h);
      if (!data) continue;
      if (!fs.existsSync(outPath)) {
        if (!data.length) throw new Error(`Empty image extracted: ${file}`);
        fs.writeFileSync(outPath, data);
      }
    } else if (!fs.existsSync(outPath)) {
      if (!o.raw.length) throw new Error(`Empty image extracted: ${file}`);
      fs.writeFileSync(outPath, o.raw);
    }
    const tag = (w <= 40 && h <= 40) ? `[IMG_INLINE:${file}]` : `[IMG:${file}]`;
    imgTags[id] = tag;
  }
  return imgTags;
}

function extractQuestionText(filePath, code, jpxQueue) {
  const objs = parsePdfObjects(filePath);
  const fontObjToCmap = buildFontCmaps(objs);
  const imgTags = extractImages(objs, code, jpxQueue);

  const pageIds = [];
  for (const o of Object.values(objs)) {
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = o.dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
      if (kids) for (const km of kids[1].matchAll(/(\d+)\s+0\s+R/g)) pageIds.push(km[1]);
    }
  }

  const allLines = [];
  for (const pid of pageIds) {
    const po = objs[pid];
    let contentStream = "";
    const cArr = po?.dict.match(/\/Contents\s*\[([\s\S]*?)\]/);
    if (cArr) {
      for (const cm of cArr[1].matchAll(/(\d+)\s+0\s+R/g)) {
        if (objs[cm[1]]?.stream) contentStream += objs[cm[1]].stream + "\n";
      }
    } else {
      const cm = po?.dict.match(/\/Contents\s+(\d+)\s+0\s+R/);
      if (cm && objs[cm[1]]?.stream) contentStream = objs[cm[1]].stream;
    }
    if (!contentStream.includes("BT")) continue;

    let resDict = po.dict;
    const rm = po.dict.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (rm && objs[rm[1]]) resDict = objs[rm[1]].dict;
    const localFonts = {}, localImgs = {};
    const fRef = resDict.match(/\/Font\s+(\d+)\s+0\s+R/);
    const fontDictStr = fRef && objs[fRef[1]] ? objs[fRef[1]].dict : resDict;
    for (const fm of fontDictStr.matchAll(/\/(F\d+|R\d+)\s+(\d+)\s+0\s+R/g)) localFonts[fm[1]] = fontObjToCmap[fm[2]] || null;
    const xRef = resDict.match(/\/XObject\s+(\d+)\s+0\s+R/);
    const xDictStr = xRef && objs[xRef[1]] ? objs[xRef[1]].dict : resDict;
    for (const im of xDictStr.matchAll(/\/(X\d+|Image\d+|Im\d+|I\d+|R\d+)\s+(\d+)\s+0\s+R/g)) localImgs[im[1]] = im[2];

    let ctm = [1, 0, 0, 1, 0, 0], stack = [];
    let curFont = null, tmMat = [1, 0, 0, 1, 0, 0];
    const pageItems = [];
    const seen = new Set();
    const tokRe = /\b(q|Q)\b|([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+(cm|Tm)|([\d.-]+)\s+([\d.-]+)\s+Td|\/(F\d+|R\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:\((?:\\.|[^\\()])*\)|[^\]])+)\]\s*TJ|\/(X\d+|Image\d+|Im\d+|I\d+|R\d+)\s+Do/g;
    let tm;
    while ((tm = tokRe.exec(contentStream))) {
      if (tm[1] === "q") stack.push({ ctm: [...ctm], curFont });
      else if (tm[1] === "Q") {
        const s = stack.pop();
        ctm = s ? s.ctm : [1, 0, 0, 1, 0, 0];
        if (s) curFont = s.curFont;
      }
      else if (tm[8] === "cm") ctm = mulMat([+tm[2], +tm[3], +tm[4], +tm[5], +tm[6], +tm[7]], ctm);
      else if (tm[8] === "Tm") tmMat = [+tm[2], +tm[3], +tm[4], +tm[5], +tm[6], +tm[7]];
      else if (tm[9] !== undefined) tmMat = mulMat([1, 0, 0, 1, +tm[9], +tm[10]], tmMat);
      else if (tm[11]) curFont = localFonts[tm[11]] ?? null;
      else if (tm[12] || tm[13] !== undefined || tm[14]) {
        let txt = "";
        if (tm[14]) {
          for (const hm of tm[14].matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\()])*)\)/g)) {
            txt += decodePdfText(hm[1], hm[2], curFont);
          }
        } else {
          txt = decodePdfText(tm[12], tm[13], curFont);
        }
        if (txt) {
          const m = mulMat(tmMat, ctm);
          const x = m[4], y = 842 - m[5];
          const key = `${Math.round(x / 3)}_${Math.round(y / 3)}_${txt.trim()}`;
          if (!txt.trim() || !seen.has(key)) {
            if (txt.trim()) seen.add(key);
            pageItems.push({ x, y, txt });
          }
        }
      } else if (tm[15]) {
        const imgObjId = localImgs[tm[15]] || tm[15].replace(/^[XR]/, "");
        const tag = imgTags[imgObjId];
        if (!tag) continue;
        const x = ctm[4];
        const yTop = ctm[3] < 0 ? 842 - ctm[5] : 842 - (ctm[5] + ctm[3] * 0.5);
        const key = `IMG_${imgObjId}_${Math.round(x)}_${Math.round(yTop)}`;
        if (!seen.has(key)) {
          seen.add(key);
          pageItems.push({ x, y: yTop, txt: tag });
        }
      }
    }

    pageItems.sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x);
    let lastY = null, lastX = null, lastLen = 0, line = "";
    for (const it of pageItems) {
      if (lastY !== null && Math.abs(it.y - lastY) > 3) {
        if (line.trim()) allLines.push(line.trim());
        line = it.txt;
      } else {
        const t = it.txt.trim();
        if (t.length >= 3 && line.includes(t)) { lastX = it.x; lastY = it.y; lastLen = it.txt.length; continue; }
        if (lastX !== null && lastLen <= 6 && it.x - lastX > 22 && line && !line.endsWith(" ")) line += " ";
        line += it.txt;
      }
      lastY = it.y;
      lastX = it.x;
      lastLen = it.txt.length;
    }
    if (line.trim()) allLines.push(line.trim());
  }
  return allLines.join("\n");
}

function extractAnswerText(filePath) {
  const objs = parsePdfObjects(filePath);
  const fontObjToCmap = buildFontCmaps(objs);
  const items = [];
  let pageIdx = 0;
  for (const o of Object.values(objs)) {
    if (!o.stream.includes("BT")) continue;
    pageIdx++;
    let curFont = null, curX = 0, curY = 0;
    const tokRe = /\/(F\d+)\s+[\d.]+\s+Tf|1\s+0\s+0\s+(-?1)\s+([\d.]+)\s+([\d.]+)\s+Tm|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let tm;
    while ((tm = tokRe.exec(o.stream))) {
      if (tm[1]) curFont = fontObjToCmap[tm[1]] || Object.values(fontObjToCmap)[0];
      else if (tm[2]) {
        curX = parseFloat(tm[3]);
        curY = parseFloat(tm[2]) < 0 ? parseFloat(tm[4]) : 1000 - parseFloat(tm[4]);
      } else if ((tm[5] !== undefined || tm[6] !== undefined) && curFont) {
        let txt = "";
        if (tm[5] !== undefined) {
          for (let i = 0; i < tm[5].length; i += 4) txt += curFont[parseInt(tm[5].slice(i, i + 4), 16)] ?? "";
        } else {
          const bytes = unescapePdfStr(tm[6]);
          for (let i = 0; i < bytes.length; i += 2) txt += curFont[(bytes[i] << 8) | bytes[i + 1]] ?? "";
        }
        if (txt) items.push({ page: pageIdx, x: curX, y: curY, txt });
      }
    }
  }
  items.sort((a, b) => a.page - b.page || (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x));
  const lines = [];
  let lastPage = -1, lastY = null, line = "";
  for (const it of items) {
    if (it.page !== lastPage || (lastY !== null && Math.abs(it.y - lastY) > 3)) {
      if (line) lines.push(line);
      line = it.txt;
      lastPage = it.page;
      lastY = it.y;
    } else line += it.txt;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function joinLine(prev, next) {
  if (!prev) return next;
  if (/^\[IMG:/.test(next) || /\[IMG:[^\]]+\]$/.test(prev) || /^(身高|球直徑)/.test(next)) {
    return prev + "\n" + next;
  }
  return /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next) ? prev + " " + next : prev + next;
}

function parseQuestions(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const qs = [];
  let cur = null, state = null;
  for (const l of lines) {
    if (/^(\d+\s*年|試分階段|代[\s　]*號|類科名稱|科目名稱|考試時間|※注意|※本試題)/.test(l)) continue;
    const nextNum = qs.length + (cur ? 2 : 1);
    const qm = l.match(/^(\d{1,2})\.(.*)/);
    if (qm && +qm[1] === nextNum) {
      if (cur) qs.push(cur);
      cur = { num: +qm[1], q: qm[2].trim(), options: [] };
      state = "q";
      continue;
    }
    const om = l.match(/^([A-D])\.(.*)/);
    if (om && cur && "ABCD".indexOf(om[1]) === cur.options.length) {
      cur.options.push(om[2].trim());
      state = "opt";
      continue;
    }
    if (cur) {
      if (state === "q") cur.q = joinLine(cur.q, l);
      else if (state === "opt") cur.options[cur.options.length - 1] = joinLine(cur.options[cur.options.length - 1], l);
    }
  }
  if (cur) qs.push(cur);
  return qs;
}

function parseAnswers(text) {
  const full2half = (s) => s.replace(/[Ａ-Ｚ＃]/g, (c) => c === "＃" ? "#" : String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const ans = [];
  for (const l of text.split("\n")) {
    const norm = full2half(l.trim());
    if (norm.startsWith("答案")) {
      for (const ch of norm.slice(2)) if (/[A-D#]/.test(ch)) ans.push(ch);
    }
  }
  const note = full2half((text.match(/備\s*註：([\s\S]*)/)?.[1] || "").trim());
  const modRules = {};
  if (note) {
    for (const m of note.matchAll(/第(\d+)題(?:答([A-D或]+?)(?:者均)?給分|[^\d]*(?:一律給分|均給分))/g)) {
      const qNum = +m[1];
      if (m[2]) {
        const letters = [...new Set(m[2].match(/[A-D]/g))].map((c) => "ABCD".indexOf(c));
        modRules[qNum] = { answers: letters, explain: `考選部更正答案：${m[0]}` };
      } else {
        modRules[qNum] = { answers: [0, 1, 2, 3], explain: `考選部更正答案：${m[0]}` };
      }
    }
  }
  return { ans, modRules };
}

function findExamHtmls(dir) {
  const res = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...findExamHtmls(p));
    else if (e.name === "考畢題答.html") res.push(p);
  }
  return res.sort();
}

const TABLE_OVERRIDES = {
  "114年第一次||神經疾病物理治療學||12":
    "王爺爺身高165公分、體重75公斤，患有巴金森氏病（侯葉氏分期第三期），因摔倒骨折剛做過右側髖關節的全關節置換。下表為治療球的參考尺寸，依王爺爺的狀況，坐在那個尺寸充飽氣的治療球上進行姿勢平衡訓練最為恰當？\n| 身高（公分） | <153 | 153-170 | 171-191 | >191 |\n| 球直徑（公分） | 45 | 55 | 65 | 75 |",
  "115年第一次||神經疾病物理治療學||77":
    "下列何評估結果顯示有高跌倒風險？\n| 個案 | 量表 | 得分 |\n| 甲 | 阮柏氏測試（Romberg's test） | 32秒 |\n| 乙 | 柏格氏平衡量表（Berg balance scale） | 32分 |\n| 丙 | 三公尺計時起走測試（timed up-and-go test） | 25秒 |\n| 丁 | 緹氏表現導向行動評量（Tinetti performance-oriented mobility assessment） | 25分 |",
};

function collapseImgStrips(str) {
  return str.replace(/(\[IMG:[^\]]+\])(?:\s*\[IMG:[^\]]+\])+/g, "$1");
}

const rowRe = /<UL class='link_3'><LI><table[^>]*><tr>\s*<td><div>([^<]+)<\/div><\/td>([\s\S]*?)<\/tr><\/table>/g;
const EXPLAINS_PATH = path.join(BASE, "option-explains.json");
const optionExplainsMap = fs.existsSync(EXPLAINS_PATH)
  ? JSON.parse(fs.readFileSync(EXPLAINS_PATH, "utf8"))
  : {};
const allQuestions = [];
const jpxQueue = [];

for (const htmlPath of findExamHtmls(BANK_ROOT)) {
  const htmlDir = path.dirname(htmlPath);
  const relParts = path.relative(BANK_ROOT, htmlDir).split(path.sep);
  const exam = (relParts[0].match(/^\d+年第[一二三四]次/)?.[0]) || relParts[0];
  const html = fs.readFileSync(htmlPath, "utf8");

  for (const rm of html.matchAll(rowRe)) {
    const subject = rm[1].trim();
    const links = rm[2];
    const qPdf = links.match(/href='([^']+)'[^>]*>試題<\/a>/)?.[1];
    const ansPdf = links.match(/href='([^']+)'[^>]*>答案<\/a>/)?.[1];
    const modPdf = links.match(/href='([^']+)'[^>]*>更正答案<\/a>/)?.[1];
    const examCode = qPdf?.match(/^(\d+)_/)?.[1];
    const code = qPdf?.match(/_(\d{2,4})_/)?.[1];
    if (!qPdf || !ansPdf || !examCode || !code) throw new Error(`Invalid row in ${htmlPath} for ${subject}`);

    const imgPrefix = `${examCode}_${code}`;
    const qs = parseQuestions(extractQuestionText(path.join(htmlDir, qPdf), imgPrefix, jpxQueue));
    const { ans, modRules } = parseAnswers(extractAnswerText(path.join(htmlDir, modPdf || ansPdf)));
    if (qs.length !== 80 || ans.length !== 80) {
      throw new Error(`Count mismatch for ${exam} ${subject}: qs=${qs.length}, ans=${ans.length}`);
    }

    qs.forEach((item, idx) => {
      const num = idx + 1;
      if (item.options.length !== 4) throw new Error(`${exam} ${subject} Q${num} options=${item.options.length}`);
      const ch = ans[idx];
      const mod = modRules[num];
      if (ch === "#" && !mod) throw new Error(`${exam} ${subject} Q${num} marked # without MOD rule`);
      const qObj = {
        exam,
        subject,
        num,
        q: collapseImgStrips(TABLE_OVERRIDES[`${exam}||${subject}||${num}`] || item.q),
        options: item.options.map(collapseImgStrips),
        answer: mod ? mod.answers[0] : "ABCD".indexOf(ch),
        explain: mod ? mod.explain : "",
      };
      if (mod) qObj.answers = mod.answers;
      const optExplains = optionExplainsMap[`${exam}||${subject}||${num}`];
      if (optExplains) qObj.optionExplains = optExplains;
      allQuestions.push(qObj);
    });
    console.log(`Parsed ${exam} ${imgPrefix} ${subject}: ${qs.length} 題`);
  }
}

const missingJpx = jpxQueue.filter((j) => !fs.existsSync(j.outPath) || fs.statSync(j.outPath).size === 0);
console.log(`JPX images total: ${jpxQueue.length}, missing: ${missingJpx.length}`);
if (missingJpx.length) {
  fs.writeFileSync(path.join(BASE, ".jpx-queue.json"), JSON.stringify(missingJpx.map((j) => ({
    w: j.w, h: j.h, outPath: j.outPath, jp2Base64: j.jp2Buf.toString("base64")
  }))));
}

const out = `// 由 build-bank.js 自動從考畢題答 PDF 解析產生，共 ${allQuestions.length} 題\nwindow.QUESTIONS = ${JSON.stringify(allQuestions, null, 2)};\n`;
fs.writeFileSync(path.join(BASE, "questions.js"), out, "utf8");
console.log(`Wrote ${allQuestions.length} questions to questions.js`);
