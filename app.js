/* PDF 合併工具 — 純瀏覽器版
   合併 PDF / 圖轉 PDF：pdf-lib
   PDF → 圖片、縮圖：pdf.js（+ JSZip 多張打包）
   拆分 PDF：pdf-lib
   全程本機處理，檔案不上傳。 */

const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ── 中文文字 ──
// pdf-lib 內建 StandardFonts 只支援 WinAnsi 編碼，drawText 遇中文會 throw。
// 兩條路：① 系統字型畫成 PNG 嵌入（預設，零下載）② 嵌 NotoSansTC subset（真文字，要下載）
const FONTKIT_URL = "https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js";
const CJK_FONT_URL =
  "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf";
const CANVAS_FONTS =
  '"Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif';

const isAscii = (s) => /^[\x20-\x7E]*$/.test(s);

let fontkitReady = false;
let cjkFontBytes = null;   // 下載後留著，同分頁重複使用不再抓

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("載入失敗：" + src));
    document.head.appendChild(s);
  });
}

// 高品質模式：嵌入 NotoSansTC（subset:true → 只帶用到的字，輸出檔只大幾 KB）
async function embedCjkFont(doc) {
  if (!fontkitReady) {
    log("  · 載入 fontkit（約 0.7 MB）…", "info");
    await loadScript(FONTKIT_URL);
    fontkitReady = true;
  }
  if (!cjkFontBytes) {
    log("  · 下載中文字型 NotoSansTC（約 5.4 MB，只需一次）…", "info");
    const resp = await fetch(CJK_FONT_URL);
    if (!resp.ok) throw new Error(`字型下載失敗 HTTP ${resp.status}`);
    cjkFontBytes = new Uint8Array(await resp.arrayBuffer());
  }
  doc.registerFontkit(window.fontkit);
  return doc.embedFont(cjkFontBytes, { subset: true });
}

// 預設模式：用瀏覽器內建中文字型把文字畫成透明背景 PNG（4x 超取樣，列印夠清晰）
async function textToPng(text, sizePt, rgb01, bold) {
  const SS = 4;
  const px = sizePt * SS;
  const font = `${bold ? "bold " : ""}${px}px ${CANVAS_FONTS}`;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = font;
  const m = meas.measureText(text);
  const asc = Math.ceil(m.actualBoundingBoxAscent || px * 0.88);
  const desc = Math.ceil(m.actualBoundingBoxDescent || px * 0.24);
  const pad = Math.ceil(px * 0.08);

  const c = document.createElement("canvas");
  c.width = Math.ceil(m.width) + pad * 2;
  c.height = asc + desc + pad * 2;
  const cx = c.getContext("2d");
  cx.font = font;                 // 改 canvas 尺寸會重置 context，font 必須重設
  cx.textBaseline = "alphabetic";
  cx.fillStyle = `rgb(${rgb01.map((v) => Math.round(v * 255)).join(",")})`;
  cx.fillText(text, pad, asc + pad);

  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: c.width / SS, h: c.height / SS };
}

const IMG_EXT = ["jpg", "jpeg", "png", "bmp", "jfif", "webp"];
let files = [];          // {id, name, kind:'image'|'pdf', ext, bytes:ArrayBuffer, pages?}
let selected = null;     // 選中的 id
let uid = 0;
const thumbCache = new Map();   // id -> dataURL
const thumbBusy = new Set();    // 正在產縮圖的 id

// ── DOM ──
const $ = (s) => document.querySelector(s);
const listEl = $("#filelist");
const emptyEl = $("#empty");
const logEl = $("#log");
const barFill = $("#bar-fill");
const dropzone = $("#dropzone");

// ── 記錄 ──
function log(msg, cls = "") {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = msg + "\n";
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}
function setBar(pct) { barFill.style.width = (pct * 100) + "%"; }

// ── 檔案加入 ──
function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }

async function addFiles(fileObjs) {
  for (const f of fileObjs) {
    const ext = extOf(f.name);
    let kind;
    if (ext === "pdf") kind = "pdf";
    else if (IMG_EXT.includes(ext)) kind = "image";
    else { log(`⚠ 略過不支援：${f.name}`, "err"); continue; }
    const bytes = await f.arrayBuffer();
    const item = { id: ++uid, name: f.name, kind, ext, bytes };
    if (kind === "pdf") {
      try { item.pages = (await PDFDocument.load(bytes)).getPageCount(); }
      catch { item.pages = 0; }
    }
    files.push(item);
  }
  render();
}

// ── 縮圖 ──
async function imageThumb(f) {
  const url = URL.createObjectURL(new Blob([f.bytes.slice(0)], { type: "image/" + f.ext }));
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
    return drawThumb(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}
async function pdfThumb(f) {
  const doc = await pdfjsLib.getDocument({ data: f.bytes.slice(0) }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(76 / vp.width, 100 / vp.height); // 縮圖目標 ~2x 顯示尺寸
  const v = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
  return c.toDataURL("image/jpeg", 0.7);
}
function drawThumb(src, w, h) {
  const maxW = 76, maxH = 100;
  const s = Math.min(maxW / w, maxH / h, 1);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}
async function fillThumbs() {
  for (const f of files) {
    if (thumbCache.has(f.id) || thumbBusy.has(f.id)) continue;
    thumbBusy.add(f.id);
    try {
      const url = f.kind === "image" ? await imageThumb(f) : await pdfThumb(f);
      thumbCache.set(f.id, url);
      const el = listEl.querySelector(`li[data-id="${f.id}"] .thumb`);
      if (el) el.src = url;
    } catch { /* 縮圖失敗就留佔位，不影響功能 */ }
    finally { thumbBusy.delete(f.id); }
  }
}

// ── 清單畫面 ──
function render() {
  listEl.innerHTML = "";
  emptyEl.style.display = files.length ? "none" : "block";
  files.forEach((f, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = f.id;
    if (f.id === selected) li.classList.add("selected");
    const cached = thumbCache.get(f.id) || "";
    const pageTag = f.kind === "pdf" ? `<span class="pages">${f.pages || "?"} 頁</span>` : "";
    li.innerHTML =
      `<span class="idx">${String(i + 1).padStart(2, "0")}.</span>` +
      `<img class="thumb" alt="" src="${cached}">` +
      `<span class="name"></span>${pageTag}`;
    li.querySelector(".name").textContent = f.name;
    li.addEventListener("click", () => { selected = f.id; render(); });
    listEl.appendChild(li);
  });
  updateSplitHint();
  fillThumbs();
}

// ── 拖曳排序 ──
let dragId = null;
listEl.addEventListener("dragstart", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  dragId = +li.dataset.id; li.classList.add("dragging");
});
listEl.addEventListener("dragend", (e) => {
  const li = e.target.closest("li"); if (li) li.classList.remove("dragging");
  dragId = null;
});
listEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  const over = e.target.closest("li"); if (!over || dragId == null) return;
  const overId = +over.dataset.id;
  if (overId === dragId) return;
  const from = files.findIndex((f) => f.id === dragId);
  const to = files.findIndex((f) => f.id === overId);
  const [moved] = files.splice(from, 1);
  files.splice(to, 0, moved);
  render();
});

// ── 外部檔案拖放進視窗 ──
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault(); dropzone.classList.add("dragover");
    }
  }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, () => dropzone.classList.remove("dragover")));
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
});

// ── 按鈕 ──
$("#btn-add-img").onclick = () => $("#file-img").click();
$("#btn-add-pdf").onclick = () => $("#file-pdf").click();
$("#file-img").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#file-pdf").onchange = async (e) => {
  await addFiles(e.target.files); e.target.value = "";
  if (pendingEdit) {                       // 從「頁面編輯」空清單觸發的挑檔
    pendingEdit = false;
    const f = files.filter((x) => x.kind === "pdf").pop();
    if (f) { selected = f.id; render(); try { await openEditor(f); } catch { /* noop */ } }
  }
};

function selIndex() { return files.findIndex((f) => f.id === selected); }
$("#btn-up").onclick = () => {
  const i = selIndex(); if (i <= 0) return;
  [files[i - 1], files[i]] = [files[i], files[i - 1]]; render();
};
$("#btn-down").onclick = () => {
  const i = selIndex(); if (i < 0 || i >= files.length - 1) return;
  [files[i], files[i + 1]] = [files[i + 1], files[i]]; render();
};
$("#btn-del").onclick = () => {
  const i = selIndex(); if (i < 0) return;
  thumbCache.delete(files[i].id);
  files.splice(i, 1); selected = null; render();
};
$("#btn-clear").onclick = () => {
  if (files.length && confirm("確定清除所有檔案？")) {
    files = []; selected = null; thumbCache.clear(); render();
  }
};

// ── 工具 ──
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setBusy(b) {
  ["#btn-merge", "#btn-toimg", "#btn-split-extract", "#btn-split-each"]
    .forEach((s) => { $(s).disabled = b; });
}
// 非 jpg/png（bmp/webp/jfif 保險）→ 經 canvas 轉 png bytes
async function toPngBytes(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const img = await new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

// ── 合併輸出 PDF ──
$("#btn-merge").onclick = async () => {
  if (!files.length) { alert("請先新增檔案！"); return; }
  setBusy(true); setBar(0);
  log(`▶ 開始合併 ${files.length} 個檔案…`, "info");
  try {
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.kind === "pdf") {
        const src = await PDFDocument.load(f.bytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else {
        let img;
        if (f.ext === "png") img = await out.embedPng(f.bytes);
        else if (["jpg", "jpeg", "jfif"].includes(f.ext)) img = await out.embedJpg(f.bytes);
        else img = await out.embedPng(await toPngBytes(f.bytes, "image/" + f.ext)); // bmp/webp
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      setBar((i + 1) / files.length);
    }
    const bytes = await out.save();
    download(new Blob([bytes], { type: "application/pdf" }), `merged_${stamp()}.pdf`);
    log(`🎉 合併完成！已下載 merged_${stamp()}.pdf`, "ok");
  } catch (e) {
    log(`✘ 錯誤：${e.message}`, "err");
  } finally { setBusy(false); setBar(0); }
};

// ── PDF → 圖片 ──
$("#btn-toimg").onclick = async () => {
  const pdfs = files.filter((f) => f.kind === "pdf");
  if (!pdfs.length) { alert("清單裡沒有 PDF，請先新增 PDF！"); return; }
  const fmt = document.querySelector('input[name="fmt"]:checked').value; // JPG/PNG
  const dpi = +$("#dpi").value;
  const mime = fmt === "JPG" ? "image/jpeg" : "image/png";
  const ext = fmt === "JPG" ? "jpg" : "png";
  const scale = dpi / 72;

  setBusy(true); setBar(0);
  log(`▶ 開始將 ${pdfs.length} 個 PDF 轉成 ${fmt}（DPI ${dpi}）…`, "info");
  try {
    const outputs = []; // {name, blob}
    for (const f of pdfs) {
      const stem = f.name.replace(/\.pdf$/i, "");
      const doc = await pdfjsLib.getDocument({ data: f.bytes.slice(0) }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        const blob = await new Promise((r) => c.toBlob(r, mime, 0.95));
        const name = doc.numPages === 1 ? `${stem}.${ext}`
          : `${stem}_${String(p).padStart(3, "0")}.${ext}`;
        outputs.push({ name, blob });
        setBar(outputs.length / (pdfs.length * doc.numPages));
      }
      log(`  ✔ ${stem} → ${doc.numPages} 張 ${fmt}`, "ok");
    }
    if (outputs.length === 1) {
      download(outputs[0].blob, outputs[0].name);
    } else {
      const zip = new JSZip();
      outputs.forEach((o) => zip.file(o.name, o.blob));
      const zblob = await zip.generateAsync({ type: "blob" });
      download(zblob, `images_${stamp()}.zip`);
    }
    log(`🎉 完成！共 ${outputs.length} 張${outputs.length > 1 ? "（已打包 zip）" : ""}`, "ok");
  } catch (e) {
    log(`✘ 錯誤：${e.message}`, "err");
  } finally { setBusy(false); setBar(0); }
};

// ── 拆分 PDF ──
// 找目前要拆分的 PDF：選取者優先；否則清單剛好只有 1 個 PDF 就用它
function currentPdf(silent) {
  const sel = files.find((f) => f.id === selected);
  if (sel && sel.kind === "pdf") return sel;
  const pdfs = files.filter((f) => f.kind === "pdf");
  if (pdfs.length === 1) return pdfs[0];
  if (!silent) alert(pdfs.length ? "清單有多個 PDF：請先在清單點一下要操作的那個 PDF" : "清單裡沒有 PDF，請先新增 PDF！");
  return null;
}
function updateSplitHint() {
  // 在工具面板標題後顯示目前選取的 PDF（若該工具吃 PDF）
  const el = $("#tp-selinfo");
  if (!el) return;
  const f = currentPdf(true);
  el.textContent = f ? `　·　目前：${f.name}（${f.pages || "?"} 頁）` : "";
}
// "1-3,5,8-10" → 0-based 索引陣列（驗證範圍、去重、保留輸入順序）
function parseRange(str, max) {
  const out = [];
  for (const part of str.split(",")) {
    const s = part.trim(); if (!s) continue;
    const m = s.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`頁碼格式錯誤：「${s}」`);
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= b; p++) {
      if (p < 1 || p > max) throw new Error(`頁碼超出範圍：${p}（共 ${max} 頁）`);
      out.push(p - 1);
    }
  }
  return [...new Set(out)];
}

$("#btn-split-extract").onclick = async () => {
  const f = currentPdf(); if (!f) return;
  const raw = $("#split-range").value.trim();
  if (!raw) { alert("請輸入要擷取的頁碼，例如 1-3,5"); return; }
  let idxs;
  try { idxs = parseRange(raw, f.pages); }
  catch (e) { alert(e.message); return; }
  if (!idxs.length) { alert("沒有有效頁碼"); return; }

  const stem = f.name.replace(/\.pdf$/i, "");
  setBusy(true); setBar(0);
  log(`▶ 從 ${f.name} 擷取第 ${raw} 頁（共 ${idxs.length} 頁）…`, "info");
  try {
    const src = await PDFDocument.load(f.bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, idxs);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    download(new Blob([bytes], { type: "application/pdf" }), `${stem}_擷取_${stamp()}.pdf`);
    log(`🎉 已擷取 ${idxs.length} 頁 → ${stem}_擷取.pdf`, "ok");
  } catch (e) {
    log(`✘ 錯誤：${e.message}`, "err");
  } finally { setBusy(false); setBar(0); }
};

$("#btn-split-each").onclick = async () => {
  const f = currentPdf(); if (!f) return;
  const n = f.pages || 0;
  if (n < 1) { alert("讀不到頁數"); return; }
  if (n === 1) { alert("只有 1 頁，不需要拆分"); return; }

  const stem = f.name.replace(/\.pdf$/i, "");
  setBusy(true); setBar(0);
  log(`▶ 將 ${f.name} 每頁拆成單獨 PDF（共 ${n} 頁）…`, "info");
  try {
    const src = await PDFDocument.load(f.bytes);
    const zip = new JSZip();
    for (let i = 0; i < n; i++) {
      const out = await PDFDocument.create();
      const [pg] = await out.copyPages(src, [i]);
      out.addPage(pg);
      const bytes = await out.save();
      zip.file(`${stem}_${String(i + 1).padStart(3, "0")}.pdf`, bytes);
      setBar((i + 1) / n);
    }
    const zblob = await zip.generateAsync({ type: "blob" });
    download(zblob, `${stem}_拆分_${stamp()}.zip`);
    log(`🎉 已拆成 ${n} 個單頁 PDF（打包 zip）`, "ok");
  } catch (e) {
    log(`✘ 錯誤：${e.message}`, "err");
  } finally { setBusy(false); setBar(0); }
};

// ── 頁面編輯（刪頁 / 旋轉 / 拖曳重排 → 輸出）──
let edFile = null;              // 正在編輯的檔
let edOps = [];                 // [{index:原頁碼(0-based), rotate:0/90/180/270}]
let edDoc = null;              // pdf.js doc（產頁縮圖用）
const edThumb = new Map();     // 原頁碼 -> dataURL

let pendingEdit = false;
$("#btn-edit").onclick = async () => {
  const f = currentPdf(true);              // 靜默：自己決定怎麼引導
  if (f) {
    if (!f.pages) { alert("讀不到頁數"); return; }
    try { await openEditor(f); } catch (e) { alert("開啟失敗：" + e.message); }
    return;
  }
  if (!files.some((x) => x.kind === "pdf")) {   // 清單沒 PDF → 直接開檔案選擇
    pendingEdit = true; $("#file-pdf").click();
  } else {
    alert("清單有多個 PDF：請先在清單點一下要編輯的那個 PDF");
  }
};

async function openEditor(f) {
  edFile = f;
  edOps = Array.from({ length: f.pages }, (_, i) => ({ index: i, rotate: 0 }));
  edThumb.clear();
  edDoc = await pdfjsLib.getDocument({ data: f.bytes.slice(0) }).promise;
  $("#editor-title").textContent = `頁面編輯 — ${f.name}（${f.pages} 頁）`;
  $("#editor").hidden = false;
  renderEditor();
}
function closeEditor() {
  $("#editor").hidden = true;
  edFile = null; edOps = []; edDoc = null; edThumb.clear();
}

async function edPageThumb(origIndex) {
  if (edThumb.has(origIndex)) return edThumb.get(origIndex);
  const page = await edDoc.getPage(origIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(220 / vp.width, 300 / vp.height);
  const v = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
  const url = c.toDataURL("image/jpeg", 0.72);
  edThumb.set(origIndex, url);
  return url;
}

function renderEditor() {
  const grid = $("#editor-grid");
  grid.innerHTML = "";
  edOps.forEach((op, pos) => {
    const card = document.createElement("div");
    card.className = "pcard";
    card.draggable = true;
    card.dataset.pos = pos;
    card.innerHTML =
      `<div class="pthumb-box"><img class="pthumb" alt=""></div>` +
      `<span class="pnum">第 ${pos + 1} 頁（原 ${op.index + 1}）</span>` +
      `<span class="pbtns">` +
      `<button class="rl" title="左轉"><svg class="ic ic-sm"><use href="#i-rot-l"/></svg></button>` +
      `<button class="rr" title="右轉"><svg class="ic ic-sm"><use href="#i-rot-r"/></svg></button>` +
      `<button class="del" title="刪頁"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button></span>`;
    const img = card.querySelector(".pthumb");
    img.style.transform = `rotate(${op.rotate}deg)`;
    edPageThumb(op.index).then((u) => { img.src = u; }).catch(() => {});
    card.querySelector(".rl").onclick = (e) => { e.stopPropagation(); op.rotate = (op.rotate + 270) % 360; img.style.transform = `rotate(${op.rotate}deg)`; };
    card.querySelector(".rr").onclick = (e) => { e.stopPropagation(); op.rotate = (op.rotate + 90) % 360; img.style.transform = `rotate(${op.rotate}deg)`; };
    card.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      if (edOps.length <= 1) { alert("至少要留 1 頁"); return; }
      edOps.splice(pos, 1); renderEditor();
    };
    grid.appendChild(card);
  });
}

// 編輯器內拖曳重排
let edDragPos = null;
$("#editor-grid").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".pcard"); if (!card) return;
  edDragPos = +card.dataset.pos; card.classList.add("dragging");
});
$("#editor-grid").addEventListener("dragend", (e) => {
  const card = e.target.closest(".pcard"); if (card) card.classList.remove("dragging");
  edDragPos = null;
});
$("#editor-grid").addEventListener("dragover", (e) => {
  e.preventDefault();
  const over = e.target.closest(".pcard"); if (!over || edDragPos == null) return;
  const to = +over.dataset.pos;
  if (to === edDragPos) return;
  const [moved] = edOps.splice(edDragPos, 1);
  edOps.splice(to, 0, moved);
  edDragPos = to;
  renderEditor();
});

$("#ed-cancel").onclick = closeEditor;

$("#ed-export").onclick = async () => {
  if (!edFile || !edOps.length) return;
  const f = edFile, ops = edOps.slice();
  const stem = f.name.replace(/\.pdf$/i, "");
  $("#ed-export").disabled = true;
  log(`▶ 輸出編輯後 PDF（${ops.length} 頁）…`, "info");
  try {
    const src = await PDFDocument.load(f.bytes);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, ops.map((o) => o.index));
    copied.forEach((pg, i) => {
      const base = pg.getRotation().angle || 0;
      pg.setRotation(degrees(((base + ops[i].rotate) % 360 + 360) % 360));
      out.addPage(pg);
    });
    const bytes = await out.save();
    download(new Blob([bytes], { type: "application/pdf" }), `${stem}_編輯_${stamp()}.pdf`);
    log(`🎉 已輸出 ${ops.length} 頁 → ${stem}_編輯.pdf`, "ok");
    closeEditor();
  } catch (e) {
    log(`✘ 錯誤：${e.message}`, "err");
  } finally { $("#ed-export").disabled = false; }
};

// ── 左側工具切換 ──
const TOOL_TITLES = {
  merge: "合併", toimg: "PDF → 圖片", split: "拆分", editor: "頁面編輯",
  nup: "多頁併一頁", crop: "裁切", removeblank: "去空白頁",
  pagenum: "頁碼", watermark: "浮水印", metadata: "文件資訊",
};
function selectTool(name) {
  document.querySelectorAll(".navitem").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === name));
  document.querySelectorAll(".tp-body").forEach((p) =>
    p.hidden = p.dataset.panel !== name);
  $("#tp-title").textContent = TOOL_TITLES[name] || "工具";
  updateSplitHint();
}
document.querySelectorAll(".navitem").forEach((b) =>
  b.addEventListener("click", () => selectTool(b.dataset.tool)));

// ── 共用：載入選取 PDF 的 pdf-lib 文件 ──
async function loadSelectedPdf() {
  const f = currentPdf();
  if (!f) return null;
  const doc = await PDFDocument.load(f.bytes);
  return { f, doc, stem: f.name.replace(/\.pdf$/i, "") };
}
function savePdfDownload(bytes, name) {
  download(new Blob([bytes], { type: "application/pdf" }), name);
}

// ── 頁碼 ──
$("#btn-pagenum").onclick = async () => {
  const ctx = await loadSelectedPdf(); if (!ctx) return;
  const pos = $("#pn-pos").value, start = parseInt($("#pn-start").value, 10) || 0;
  const size = parseInt($("#pn-size").value, 10) || 11;
  setBusy(true); log(`▶ 加頁碼…`, "info");
  try {
    const font = await ctx.doc.embedFont(PDFLib.StandardFonts.Helvetica);
    ctx.doc.getPages().forEach((pg, i) => {
      const { width } = pg.getSize();
      const label = String(start + i);
      const w = font.widthOfTextAtSize(label, size);
      let x = width / 2 - w / 2;
      if (pos === "br") x = width - w - 36;
      if (pos === "bl") x = 36;
      pg.drawText(label, { x, y: 24, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
    });
    savePdfDownload(await ctx.doc.save(), `${ctx.stem}_頁碼_${stamp()}.pdf`);
    log(`🎉 已加頁碼 → ${ctx.stem}_頁碼.pdf`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); }
};

// ── 浮水印 ──
$("#btn-watermark").onclick = async () => {
  const text = $("#wm-text").value.trim();
  if (!text) { alert("請輸入浮水印文字"); return; }
  const ctx = await loadSelectedPdf(); if (!ctx) return;
  const size = parseInt($("#wm-size").value, 10) || 48;
  const op = Math.min(0.8, Math.max(0.05, (parseInt($("#wm-opacity").value, 10) || 15) / 100));
  const wantEmbed = $("#wm-embed").checked;
  const GRAY = [0.5, 0.5, 0.5];
  const RAD = Math.PI / 4;
  setBusy(true); log(`▶ 蓋浮水印…`, "info");
  try {
    let draw;   // (page, 頁寬, 頁高) => void
    if (isAscii(text) || wantEmbed) {
      // 真文字路徑：英數走內建 Helvetica，中文走 NotoSansTC subset
      const font = isAscii(text)
        ? await ctx.doc.embedFont(PDFLib.StandardFonts.HelveticaBold)
        : await embedCjkFont(ctx.doc);
      draw = (pg, W, H) => {
        const w = font.widthOfTextAtSize(text, size);
        pg.drawText(text, {
          x: W / 2 - (w / 2) * Math.cos(RAD),
          y: H / 2 - (w / 2) * Math.sin(RAD),
          size, font, color: PDFLib.rgb(...GRAY),
          rotate: degrees(45), opacity: op,
        });
      };
    } else {
      // 圖片路徑：整份共用同一個 PNG XObject，頁數再多也只加一份
      const t = await textToPng(text, size, GRAY, true);
      const png = await ctx.doc.embedPng(t.bytes);
      draw = (pg, W, H) => {
        // drawImage 的旋轉錨點在左下角，反推出讓圖中心落在頁面中心的 x/y
        const cos = Math.cos(RAD), sin = Math.sin(RAD);
        pg.drawImage(png, {
          x: W / 2 - (t.w / 2) * cos + (t.h / 2) * sin,
          y: H / 2 - (t.w / 2) * sin - (t.h / 2) * cos,
          width: t.w, height: t.h,
          rotate: degrees(45), opacity: op,
        });
      };
      log(`  · 中文走圖片模式（不可選取，檔案 +${(t.bytes.length / 1024).toFixed(0)} KB）`, "info");
    }
    ctx.doc.getPages().forEach((pg) => {
      const { width, height } = pg.getSize();
      draw(pg, width, height);
    });
    savePdfDownload(await ctx.doc.save(), `${ctx.stem}_浮水印_${stamp()}.pdf`);
    log(`🎉 已蓋浮水印「${text}」`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); }
};

// ── 文件資訊 metadata ──
$("#btn-metadata").onclick = async () => {
  const ctx = await loadSelectedPdf(); if (!ctx) return;
  setBusy(true); log(`▶ 套用文件資訊…`, "info");
  try {
    const t = $("#md-title").value, a = $("#md-author").value, s = $("#md-subject").value;
    if (t) ctx.doc.setTitle(t);
    if (a) ctx.doc.setAuthor(a);
    if (s) ctx.doc.setSubject(s);
    savePdfDownload(await ctx.doc.save(), `${ctx.stem}_資訊_${stamp()}.pdf`);
    log(`🎉 已套用文件資訊`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); }
};

// ── 多頁併一頁 n-up（pdf.js 光柵化，穩定不吃 embedPdf 的雷） ──
$("#btn-nup").onclick = async () => {
  const f = currentPdf(); if (!f) return;
  const n = parseInt($("#nup-n").value, 10);
  const cols = n === 2 ? 1 : 2, rows = n === 2 ? 2 : (n === 4 ? 2 : 3);
  const stem = f.name.replace(/\.pdf$/i, "");
  setBusy(true); setBar(0); log(`▶ ${n} 頁併一頁…`, "info");
  try {
    const jsdoc = await pdfjsLib.getDocument({ data: f.bytes.slice(0) }).promise;
    const p0 = (await jsdoc.getPage(1)).getViewport({ scale: 1 });
    const W = p0.width, H = p0.height, cw = W / cols, ch = H / rows;
    const out = await PDFDocument.create();
    const imgs = [];
    for (let p = 1; p <= jsdoc.numPages; p++) {
      const page = await jsdoc.getPage(p);
      const vp = page.getViewport({ scale: 150 / 72 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
      imgs.push(new Uint8Array(await blob.arrayBuffer()));
      setBar((p / jsdoc.numPages) * 0.6);
    }
    for (let i = 0; i < imgs.length; i += n) {
      const page = out.addPage([W, H]);
      for (let k = 0; k < n && i + k < imgs.length; k++) {
        const jimg = await out.embedJpg(imgs[i + k]);
        const col = k % cols, row = Math.floor(k / cols);
        const s = Math.min(cw / jimg.width, ch / jimg.height) * 0.96;
        const dw = jimg.width * s, dh = jimg.height * s;
        page.drawImage(jimg, {
          x: col * cw + (cw - dw) / 2,
          y: H - (row + 1) * ch + (ch - dh) / 2, width: dw, height: dh,
        });
      }
      setBar(0.6 + ((i + n) / imgs.length) * 0.4);
    }
    savePdfDownload(await out.save(), `${stem}_${n}合1_${stamp()}.pdf`);
    log(`🎉 ${n} 頁併一頁完成`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); setBar(0); }
};

// ── 裁切（依百分比裁四邊） ──
$("#btn-crop").onclick = async () => {
  const ctx = await loadSelectedPdf(); if (!ctx) return;
  const pct = Math.min(45, Math.max(0, parseFloat($("#crop-pct").value) || 0)) / 100;
  setBusy(true); log(`▶ 裁切 ${pct * 100}% …`, "info");
  try {
    ctx.doc.getPages().forEach((pg) => {
      const { width, height } = pg.getSize();
      const mx = width * pct, my = height * pct;
      pg.setCropBox(mx, my, width - 2 * mx, height - 2 * my);
    });
    savePdfDownload(await ctx.doc.save(), `${ctx.stem}_裁切_${stamp()}.pdf`);
    log(`🎉 已裁切四邊 ${pct * 100}%`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); }
};

// ── 去空白頁（pdf.js 渲染判斷近全白） ──
$("#btn-removeblank").onclick = async () => {
  const f = currentPdf(); if (!f) return;
  setBusy(true); setBar(0); log(`▶ 偵測空白頁…`, "info");
  try {
    const jsdoc = await pdfjsLib.getDocument({ data: f.bytes.slice(0) }).promise;
    const keep = [];
    for (let p = 1; p <= jsdoc.numPages; p++) {
      const page = await jsdoc.getPage(p);
      const vp = page.getViewport({ scale: 0.4 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx2 = c.getContext("2d");
      ctx2.fillStyle = "#fff"; ctx2.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx2, viewport: vp }).promise;
      const data = ctx2.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink++;
      if (ink / (c.width * c.height) > 0.002) keep.push(p - 1); // >0.2% 非白 = 有內容
      setBar(p / jsdoc.numPages);
    }
    if (!keep.length) { alert("偵測結果全是空白頁，未輸出"); return; }
    const src = await PDFDocument.load(f.bytes);
    const out = await PDFDocument.create();
    (await out.copyPages(src, keep)).forEach((pg) => out.addPage(pg));
    const removed = jsdoc.numPages - keep.length;
    savePdfDownload(await out.save(), `${f.name.replace(/\.pdf$/i, "")}_去空白_${stamp()}.pdf`);
    log(`🎉 移除 ${removed} 空白頁，保留 ${keep.length} 頁`, "ok");
  } catch (e) { log(`✘ 錯誤：${e.message}`, "err"); }
  finally { setBusy(false); setBar(0); }
};

selectTool("merge");   // 預設顯示合併
render();
