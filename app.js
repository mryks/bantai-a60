import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const pagesEl = $("pages");
const tocEl = $("toc");
const pill = $("pagePill");
const loading = $("loading");
const zoomLabel = $("zoomFit");

const CSS_PER_PT = 96 / 72;            // 100% = ukuran asli
const PAGE_GAP = () => (window.innerWidth <= 860 ? 10 : 18);
const MAX_RENDERED = 14;               // batas kanvas di memori (hemat untuk HP)
const MIN_SCALE = 0.3, MAX_SCALE = 5;

let pdf = null;
let toc = null;
let sizes = [];                        // [w, h] dalam pt
let pageEls = [];
let tops = [];
let scale = 1;                         // CSS px per pt
let fitMode = true;
let current = 1;
const rendered = new Map();            // pageNum -> {task, canvas, scale}
const pending = new Set();
let observer = null;
let lastWidth = window.innerWidth;

// ------------------------------------------------------------------ data
async function loadToc() {
  const v = encodeURIComponent(window.BUILD_VERSION || "") + "-" + Date.now();
  const res = await fetch(`toc.json?v=${v}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`toc.json HTTP ${res.status}`);
  return res.json();
}

function fitScale() {
  const avail = viewer.clientWidth - (window.innerWidth <= 860 ? 18 : 40);
  const maxW = Math.max(...sizes.map((s) => s[0]));
  const s = avail / maxW;
  return Math.max(MIN_SCALE, Math.min(s, window.innerWidth <= 860 ? s : 1.15 * CSS_PER_PT));
}

// ------------------------------------------------------------------ layout
function buildPages() {
  pagesEl.innerHTML = "";
  pageEls = sizes.map((_, i) => {
    const d = document.createElement("div");
    d.className = "page placeholder";
    d.dataset.page = String(i + 1);
    d.id = `page-${i + 1}`;
    pagesEl.appendChild(d);
    return d;
  });
  applySizes();
  observer = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: "120% 0px" });
  pageEls.forEach((el) => observer.observe(el));
}

function applySizes() {
  pagesEl.style.gap = PAGE_GAP() + "px";
  pageEls.forEach((el, i) => {
    const [w, h] = sizes[i];
    el.style.width = Math.floor(w * scale) + "px";
    el.style.height = Math.floor(h * scale) + "px";
  });
  tops = pageEls.map((el) => el.offsetTop);
  zoomLabel.textContent = Math.round((scale / CSS_PER_PT) * 100) + "%";
}

// ------------------------------------------------------------------ render
function onIntersect(entries) {
  for (const e of entries) {
    const n = Number(e.target.dataset.page);
    if (e.isIntersecting) queueRender(n);
    else pending.delete(n);
  }
}

function queueRender(n) {
  const r = rendered.get(n);
  if (r && r.scale === scale) return;
  pending.add(n);
  scheduleRender();
}

let rendering = false;
async function scheduleRender() {
  if (rendering) return;
  rendering = true;
  try {
    while (pending.size) {
      // dahulukan halaman paling dekat dengan posisi baca
      const n = [...pending].sort((a, b) => Math.abs(a - current) - Math.abs(b - current))[0];
      pending.delete(n);
      await renderPage(n);
    }
  } finally {
    rendering = false;
  }
}

async function renderPage(n) {
  const el = pageEls[n - 1];
  const myScale = scale;
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: myScale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let outScale = dpr;
  const maxPixels = 12e6;
  if (vp.width * vp.height * outScale * outScale > maxPixels) {
    outScale = Math.sqrt(maxPixels / (vp.width * vp.height));
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * outScale);
  canvas.height = Math.floor(vp.height * outScale);
  const ctx = canvas.getContext("2d", { alpha: false });
  const task = page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: outScale !== 1 ? [outScale, 0, 0, outScale, 0, 0] : null,
  });
  rendered.set(n, { task, canvas: null, scale: myScale });
  try {
    await task.promise;
  } catch (err) {
    rendered.delete(n);
    if (err && err.name === "RenderingCancelledException") return;
    console.error(err);
    return;
  }
  if (myScale !== scale) { rendered.delete(n); return; }
  el.replaceChildren(canvas);
  el.classList.remove("placeholder");
  rendered.set(n, { task: null, canvas, scale: myScale });
  page.cleanup();
  evict();
}

function evict() {
  if (rendered.size <= MAX_RENDERED) return;
  const far = [...rendered.keys()].sort((a, b) => Math.abs(b - current) - Math.abs(a - current));
  for (const n of far.slice(0, rendered.size - MAX_RENDERED)) dropPage(n);
}

function dropPage(n) {
  const r = rendered.get(n);
  if (!r) return;
  if (r.task) r.task.cancel();
  if (r.canvas) { r.canvas.width = 0; r.canvas.height = 0; }
  const el = pageEls[n - 1];
  el.replaceChildren();
  el.classList.add("placeholder");
  rendered.delete(n);
}

// ------------------------------------------------------------------ zoom
function setScale(next, keepFit = false) {
  next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  fitMode = keepFit;
  if (Math.abs(next - scale) < 1e-3) return;
  // pertahankan posisi baca relatif di halaman saat ini
  const top = tops[current - 1] ?? 0;
  const ratio = (viewer.scrollTop - top) / (pageEls[current - 1]?.offsetHeight || 1);
  const xRatio = viewer.scrollWidth > viewer.clientWidth
    ? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth : 0.5;

  scale = next;
  [...rendered.keys()].forEach(dropPage);
  pending.clear();
  applySizes();
  viewer.scrollTop = tops[current - 1] + ratio * pageEls[current - 1].offsetHeight;
  viewer.scrollLeft = Math.max(0, xRatio * viewer.scrollWidth - viewer.clientWidth / 2);
  // render ulang yang terlihat
  observer.disconnect();
  pageEls.forEach((el) => observer.observe(el));
}

$("zoomIn").addEventListener("click", () => setScale(scale * 1.2));
$("zoomOut").addEventListener("click", () => setScale(scale / 1.2));
zoomLabel.addEventListener("click", () => setScale(fitScale(), true));

// lebar area baca berubah (jendela diubah, HP diputar): sesuaikan ulang.
// Perubahan tinggi saja (address bar HP) diabaikan.
new ResizeObserver(() => {
  if (!pdf || viewer.clientWidth === lastWidth) return;
  lastWidth = viewer.clientWidth;
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => {
    if (fitMode) setScale(fitScale(), true);
    else applySizes();
  }, 150);
}).observe(viewer);

// ------------------------------------------------------------------ posisi & TOC
function pageAtScroll() {
  const y = viewer.scrollTop + viewer.clientHeight * 0.3;
  let lo = 0, hi = tops.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans + 1;
}

let activeLink = null;
function updatePosition() {
  if (!tops.length) return;
  current = pageAtScroll();
  pill.textContent = `Hal. ${current} / ${toc.total_pages}`;
  let idx = -1;
  toc.items.forEach((it, i) => { if (it.start_page <= current) idx = i; });
  const link = idx >= 0 ? tocEl.querySelector(`a[data-idx="${idx}"]`) : null;
  if (link !== activeLink) {
    activeLink?.classList.remove("active");
    activeLink?.removeAttribute("aria-current");
    link?.classList.add("active");
    link?.setAttribute("aria-current", "true");
    activeLink = link;
    if (link && link.offsetParent) {
      const nav = link.closest("nav");
      const lt = link.offsetTop - nav.offsetTop;
      if (lt < nav.scrollTop + 8 || lt + link.offsetHeight > nav.scrollTop + nav.clientHeight - 8) {
        nav.scrollTo({ top: lt - nav.clientHeight / 2 + link.offsetHeight / 2, behavior: "smooth" });
      }
    }
  }
}

let ticking = false;
viewer.addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; updatePosition(); });
}, { passive: true });

function goToPage(n) {
  if (!pdf || !sizes.length) return;
  n = Math.max(1, Math.min(n, sizes.length));
  viewer.scrollTo({ top: tops[n - 1] - (window.innerWidth <= 860 ? 8 : 16), behavior: "auto" });
  updatePosition();
}

function slug(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function buildToc() {
  tocEl.innerHTML = "";
  toc.items.forEach((it, i) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${slug(it.label)}`;
    a.dataset.idx = String(i);
    a.dataset.search = `${it.label} ${it.file}`.toLowerCase();
    a.innerHTML = `<span></span><span class="pg">hal. ${it.start_page}</span>`;
    a.firstChild.textContent = it.label;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      history.replaceState(null, "", `#${slug(it.label)}`);
      goToPage(it.start_page);
      closeMenu();
    });
    li.appendChild(a);
    tocEl.appendChild(li);
  });
  $("tocCount").textContent = `· ${toc.items.length} soal`;
}

// Extract all pages, including pages whose canvas has never been rendered.
const searchPages = [];
let searchReady = false;
let searchFailed = 0;
let searchTimer;
const normalizeSearch = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

async function indexPdfText() {
  for (let n = 1; n <= pdf.numPages; n++) {
    try {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = normalizeSearch(content.items.map((item) => item.str || "").join(" "));
      const item = toc.items.find((it) => n >= it.start_page && n < it.start_page + it.pages);
      searchPages.push({ page: n, text, item });
    } catch (err) {
      console.error("Tidak bisa mengindeks halaman", n, err);
      searchFailed++;
    }
    // Yield so typing and PDF rendering remain responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  searchReady = true;
  renderSearch();
}

function renderSearch() {
  if (!toc) return;
  const q = normalizeSearch($("search").value);
  if (!q) {
    buildToc();
    $("tocEmpty").hidden = true;
    $("searchStatus").textContent = searchReady
      ? `Cari nomor, isi soal, atau pembahasan. Ctrl+F${searchFailed ? " \u00b7 Sebagian halaman gagal dibaca; muat ulang untuk mencoba lagi." : ""}`
      : "Menyiapkan pencarian seluruh halaman...";
    updatePosition();
    return;
  }
  const qNum = /^\d+$/.test(q) ? Number(q) : null;
  const labelMatches = (it) => normalizeSearch(`${it.label} ${it.file}`).includes(q)
    || (qNum !== null && (it.label.match(/\d+/g) || []).some((n) => Number(n) === qNum));
  const matches = searchPages.filter((entry) => entry.text.includes(q) || labelMatches(entry.item));
  // Number/title navigation remains available while text indexing is in progress.
  for (const item of toc.items.filter(labelMatches)) {
    if (!matches.some((entry) => entry.item === item)) matches.push({ page: item.start_page, text: "", item });
  }
  matches.sort((a, b) => Number(labelMatches(b.item)) - Number(labelMatches(a.item)) || a.page - b.page);
  tocEl.replaceChildren();
  activeLink = null;
  for (const hit of matches) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "search-result";
    link.href = `#page=${hit.page}`;
    const title = document.createElement("strong");
    title.textContent = `${hit.item.label} \u00b7 hal. ${hit.page}`;
    link.appendChild(title);
    const pos = hit.text.indexOf(q);
    if (pos >= 0) {
      const snippet = document.createElement("small");
      const from = Math.max(0, pos - 45), to = Math.min(hit.text.length, pos + q.length + 85);
      snippet.append((from ? "\u2026" : "") + hit.text.slice(from, pos));
      const mark = document.createElement("mark");
      mark.textContent = hit.text.slice(pos, pos + q.length);
      snippet.append(mark, hit.text.slice(pos + q.length, to) + (to < hit.text.length ? "\u2026" : ""));
      link.appendChild(snippet);
    }
    link.addEventListener("click", (e) => {
      e.preventDefault();
      history.replaceState(null, "", link.getAttribute("href"));
      goToPage(hit.page);
      closeMenu();
      viewer.focus({ preventScroll: true });
    });
    li.appendChild(link);
    tocEl.appendChild(li);
  }
  $("tocEmpty").hidden = matches.length > 0 || !searchReady;
  $("searchStatus").textContent = `${matches.length} halaman cocok${searchReady ? "" : " \u00b7 Indeks sedang disiapkan..."}${searchFailed ? " \u00b7 Sebagian halaman gagal dibaca; muat ulang untuk mencoba lagi." : ""}`;
}

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 180);
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    clearTimeout(searchTimer);
    renderSearch();
    tocEl.querySelector("a")?.click();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    document.body.classList.add("menu-open");
    $("menuBtn").setAttribute("aria-expanded", "true");
    $("search").focus();
    $("search").select();
  }
});

// ------------------------------------------------------------------ menu HP
function closeMenu() {
  document.body.classList.remove("menu-open");
  $("menuBtn").setAttribute("aria-expanded", "false");
}
$("menuBtn").addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  $("menuBtn").setAttribute("aria-expanded", String(open));
});
$("scrim").addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

// ------------------------------------------------------------------ start
function initialPageFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return 1;
  const m = h.match(/^(?:page|hal)=(\d+)$/i);
  if (m) return Number(m[1]);
  const it = toc.items.find((x) => slug(x.label) === h);
  return it ? it.start_page : 1;
}

async function main() {
  try {
    toc = await loadToc();
    $("updated").textContent = `Terakhir diperbarui: ${toc.updated_display}`;
    const pdfUrl = `${toc.pdf}?v=${encodeURIComponent(toc.version)}`;
    $("downloadBtn").href = pdfUrl;
    buildToc();

    pdf = await pdfjsLib.getDocument({
      url: pdfUrl,
      disableAutoFetch: true,
      rangeChunkSize: 262144,
    }).promise;

    sizes = Array.isArray(toc.page_sizes) && toc.page_sizes.length === pdf.numPages
      ? toc.page_sizes
      : await (async () => {
          const p = await pdf.getPage(1);
          const v = p.getViewport({ scale: 1 });
          return Array.from({ length: pdf.numPages }, () => [v.width, v.height]);
        })();
    toc.total_pages = pdf.numPages;

    scale = fitScale();
    lastWidth = viewer.clientWidth;
    buildPages();
    loading.classList.add("hide");
    const start = initialPageFromHash();
    if (start > 1) goToPage(start); else updatePosition();
    void indexPdfText();
  } catch (err) {
    console.error(err);
    loading.classList.add("error");
    loading.textContent = "Gagal memuat PDF. Coba muat ulang halaman. (" + (err?.message || err) + ")";
  }
}

window.addEventListener("hashchange", () => { if (pdf) goToPage(initialPageFromHash()); });

// status internal untuk diagnosa lewat console: bantai.state
window.bantai = {
  get state() {
    return { current, scale, fitMode, rendering, pending: [...pending], rendered: [...rendered.keys()] };
  },
};

main();
