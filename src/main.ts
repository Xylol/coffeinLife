import "./style.css";

// --- Types & constants ---
interface CoffeeEntry {
  id: number;
  time: number; // unix ms
  mg: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_H = 5;
const PEAK_TIME_MS = 45 * 60 * 1000; // 45 min absorption delay
const DEFAULT_DEFAULT_MG = 100;
const DEFAULT_THRESHOLD_MG = 10;
const STORAGE_KEY = "coffeinLife";
const SETTINGS_STORAGE_KEY = "coffeinLife-settings";

let halfLifeH = DEFAULT_HALF_LIFE_H;
let defaultMg = DEFAULT_DEFAULT_MG;
let thresholdMg = DEFAULT_THRESHOLD_MG;
loadSettings();

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
    if (typeof stored.halfLifeH === "number" && stored.halfLifeH > 0) halfLifeH = stored.halfLifeH;
    if (typeof stored.defaultMg === "number" && stored.defaultMg > 0) defaultMg = stored.defaultMg;
    if (typeof stored.thresholdMg === "number" && stored.thresholdMg >= 0) thresholdMg = stored.thresholdMg;
  } catch { /* use defaults */ }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ halfLifeH, defaultMg, thresholdMg }));
}
function decay(): number {
  return Math.LN2 / (halfLifeH * MS_PER_HOUR);
}
const GRAPH_LOOKAHEAD_H = 24;
const GRAPH_LOOKBEHIND_H = 1;
const MIN_GRAPH_SAMPLES = 200;
const X_LABEL_TARGET = 6;
const GRAPH_PAD = { top: 0.08, right: 0.04, bottom: 0.1, left: 0.16 };
const CURVE_WIDTH = 2;
const DOT_RADIUS = 4;
const DASH_PATTERN = [4, 4];
const CURVE_COLOR = "#6cf";
const CURVE_FILL = "rgba(102,204,255,0.1)";

// --- State ---
let entries: CoffeeEntry[] = load();
let editingId: number | null = null;
let editingField: "time" | "mg" | null = null;
let nextId = entries.reduce((mx, e) => Math.max(mx, e.id), 0) + 1;

// --- Persistence ---
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}
function load(): CoffeeEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

// --- Helpers ---
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})\s+([01]\d|2[0-3]):([0-5]\d)$/;

function parseTime(str: string): number | null {
  const m = str.trim().match(TIME_RE);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

function parseDatetime(str: string): number | null {
  const m = str.trim().match(DATETIME_RE);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

function sortEntries() {
  entries.sort((a, b) => a.time - b.time);
}

// --- DOM refs ---
const mgInput = document.getElementById("mg-input") as HTMLInputElement;
const timeInput = document.getElementById("time-input") as HTMLInputElement;
const tbody = document.querySelector("#coffee-table tbody") as HTMLTableSectionElement;
const canvas = document.getElementById("graph") as HTMLCanvasElement;

// default inputs
mgInput.value = String(defaultMg);
timeInput.value = fmtHHMM(new Date());

// --- Add entries ---
document.getElementById("add-now")!.addEventListener("click", () => {
  addEntry(Date.now());
});
document.getElementById("add-time")!.addEventListener("click", () => {
  const t = parseTime(timeInput.value);
  if (t === null) return;
  addEntry(t);
});

function addEntry(time: number) {
  const mg = Math.max(0, Number(mgInput.value) || defaultMg);
  entries.push({ id: nextId++, time, mg });
  sortEntries();
  save();
  render();
}

function deleteEntry(id: number) {
  entries = entries.filter((e) => e.id !== id);
  save();
  render();
}

// --- Sober time ---
const soberInfo = document.getElementById("sober-info") as HTMLDivElement;

function findSoberTime(): number | null {
  if (entries.length === 0) return null;
  const latest = Math.max(...entries.map((e) => e.time));
  // binary search: caffeine is monotonically decreasing after the last intake
  let lo = latest;
  let hi = latest + 48 * MS_PER_HOUR; // generous upper bound
  while (hi - lo > 60_000) { // 1 min precision
    const mid = (lo + hi) / 2;
    if (caffeineAt(mid) >= thresholdMg) lo = mid;
    else hi = mid;
  }
  return caffeineAt(lo) >= thresholdMg ? hi : lo;
}

function renderSoberInfo() {
  const soberAt = findSoberTime();
  if (soberAt === null) {
    soberInfo.textContent = "";
    return;
  }
  const now = Date.now();
  if (soberAt <= now) {
    soberInfo.textContent = "caffeine-free since " + fmtTime(soberAt);
  } else {
    const diffMs = soberAt - now;
    const h = Math.floor(diffMs / MS_PER_HOUR);
    const m = Math.ceil((diffMs % MS_PER_HOUR) / 60_000);
    soberInfo.textContent = `caffeine-free at ${fmtTime(soberAt)} (in ${h}h ${pad2(m)}m)`;
  }
}

// --- Table rendering ---
function render() {
  renderTable();
  renderSoberInfo();
  drawGraph();
}

function renderTable() {
  tbody.innerHTML = "";
  for (const entry of entries) {
    const tr = document.createElement("tr");

    // time cell
    const tdTime = document.createElement("td");
    if (editingId === entry.id && editingField === "time") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = fmtTime(entry.time);
      inp.placeholder = "yyyy-MM-dd HH:MM";
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
        if (e.key === "Escape") { editingId = null; editingField = null; render(); }
      });
      inp.addEventListener("blur", () => {
        const t = parseDatetime(inp.value);
        if (t !== null) {
          entry.time = t;
          sortEntries();
          save();
        }
        editingId = null;
        editingField = null;
        render();
      });
      tdTime.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      tdTime.textContent = fmtTime(entry.time);
      tdTime.addEventListener("click", () => {
        editingId = entry.id;
        editingField = "time";
        render();
      });
    }

    // mg cell
    const tdMg = document.createElement("td");
    if (editingId === entry.id && editingField === "mg") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "numeric";
      inp.value = String(entry.mg);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
        if (e.key === "Escape") { editingId = null; editingField = null; render(); }
      });
      inp.addEventListener("blur", () => {
        const val = Number(inp.value);
        if (!isNaN(val) && val >= 0) {
          entry.mg = val;
          save();
        }
        editingId = null;
        editingField = null;
        render();
      });
      tdMg.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      tdMg.textContent = String(entry.mg);
      tdMg.addEventListener("click", () => {
        editingId = entry.id;
        editingField = "mg";
        render();
      });
    }

    // delete cell
    const tdDel = document.createElement("td");
    tdDel.style.cursor = "default";
    const btn = document.createElement("button");
    btn.className = "del";
    btn.textContent = "\u00d7";
    btn.addEventListener("click", () => deleteEntry(entry.id));
    tdDel.appendChild(btn);

    tr.append(tdTime, tdMg, tdDel);
    tbody.appendChild(tr);
  }
}

// --- Graph ---
function absorption(dt: number): number {
  // Models delayed absorption: rises to 1.0 at PEAK_TIME_MS, then stays at 1.0
  if (dt <= 0) return 0;
  if (dt >= PEAK_TIME_MS) return 1;
  // Smooth ramp using sine curve (0 → 1 over peak time)
  return Math.sin((dt / PEAK_TIME_MS) * (Math.PI / 2));
}

function caffeineAt(t: number): number {
  let total = 0;
  const k = decay();
  for (const e of entries) {
    if (e.time > t) continue;
    const dt = t - e.time;
    const absorbed = e.mg * absorption(dt);
    // Decay starts from peak time; before peak, no decay yet
    const decayTime = Math.max(0, dt - PEAK_TIME_MS);
    const remaining = absorbed * Math.exp(-k * decayTime);
    if (remaining >= thresholdMg) total += remaining;
  }
  return total;
}

function drawGraph() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const gPad = {
    top: GRAPH_PAD.top * H,
    right: GRAPH_PAD.right * W,
    bottom: GRAPH_PAD.bottom * H,
    left: GRAPH_PAD.left * W,
  };
  const gw = W - gPad.left - gPad.right;
  const gh = H - gPad.top - gPad.bottom;

  if (entries.length === 0) {
    ctx.fillStyle = "#666";
    ctx.font = "0.85rem system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Add a coffee to see the graph", W / 2, H / 2);
    return;
  }

  const earliest = Math.min(...entries.map((e) => e.time)) - GRAPH_LOOKBEHIND_H * MS_PER_HOUR;
  const latest = Math.max(...entries.map((e) => e.time)) + GRAPH_LOOKAHEAD_H * MS_PER_HOUR;
  const tRange = latest - earliest;

  // sample curve
  const steps = Math.max(MIN_GRAPH_SAMPLES, Math.floor(gw));
  const samples: { t: number; v: number }[] = [];
  let maxVal = 0;
  for (let i = 0; i <= steps; i++) {
    const t = earliest + (tRange * i) / steps;
    const v = caffeineAt(t);
    samples.push({ t, v });
    if (v > maxVal) maxVal = v;
  }
  // snap y scale to whole coffees (ceiling), minimum 1 coffee
  maxVal = Math.max(Math.ceil(maxVal / defaultMg), 1) * defaultMg;

  function tx(t: number) {
    return gPad.left + ((t - earliest) / tRange) * gw;
  }
  function ty(v: number) {
    return gPad.top + gh - (v / maxVal) * gh;
  }

  // grid lines & labels
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#888";
  ctx.font = `${Math.min(0.7, 11 / 16)}rem system-ui`;
  const textMetrics = ctx.measureText("0");
  const textH = textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent;

  // y axis — tick per coffee count
  const maxCoffees = Math.round(maxVal / defaultMg);
  ctx.textAlign = "right";
  for (let c = 0; c <= maxCoffees; c++) {
    const v = c * defaultMg;
    const y = ty(v);
    ctx.beginPath();
    ctx.moveTo(gPad.left, y);
    ctx.lineTo(W - gPad.right, y);
    ctx.stroke();
    ctx.fillText(`${c} (${v}mg)`, gPad.left - textH * 0.5, y + textH * 0.4);
  }

  // x axis — time labels
  ctx.textAlign = "center";
  const totalHours = tRange / MS_PER_HOUR;
  const labelEvery = Math.max(1, Math.ceil(totalHours / X_LABEL_TARGET));
  const xLabelY = gPad.top + gh + textH * 1.8;
  for (let h = 0; h <= Math.ceil(totalHours); h += labelEvery) {
    const t = earliest + h * MS_PER_HOUR;
    const x = tx(t);
    if (x < gPad.left || x > W - gPad.right) continue;
    ctx.beginPath();
    ctx.moveTo(x, gPad.top);
    ctx.lineTo(x, gPad.top + gh);
    ctx.stroke();
    ctx.fillText(fmtHHMM(new Date(t)), x, xLabelY);
  }

  // y-axis label
  ctx.save();
  ctx.translate(12, gPad.top + gh / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("coffees", 0, 0);
  ctx.restore();

  // "now" line
  const now = Date.now();
  if (now >= earliest && now <= latest) {
    ctx.strokeStyle = "#666";
    ctx.setLineDash(DASH_PATTERN);
    ctx.beginPath();
    ctx.moveTo(tx(now), gPad.top);
    ctx.lineTo(tx(now), gPad.top + gh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    const nowMg = Math.round(caffeineAt(now));
    ctx.fillText(`now ${nowMg}mg`, tx(now), gPad.top - 4);
  }

  // curve — only draw segments above threshold
  ctx.strokeStyle = CURVE_COLOR;
  ctx.lineWidth = CURVE_WIDTH;
  let inSegment = false;
  for (let i = 0; i < samples.length; i++) {
    const above = samples[i].v >= thresholdMg;
    const x = tx(samples[i].t);
    const y = ty(above ? samples[i].v : 0);
    if (above) {
      if (!inSegment) { ctx.beginPath(); ctx.moveTo(x, y); inSegment = true; }
      else ctx.lineTo(x, y);
    } else if (inSegment) {
      ctx.lineTo(x, ty(0));
      ctx.stroke();
      inSegment = false;
    }
  }
  if (inSegment) ctx.stroke();

  // fill under curve — only above threshold
  ctx.fillStyle = CURVE_FILL;
  inSegment = false;
  for (let i = 0; i < samples.length; i++) {
    const above = samples[i].v >= thresholdMg;
    const x = tx(samples[i].t);
    const y = ty(above ? samples[i].v : 0);
    if (above) {
      if (!inSegment) { ctx.beginPath(); ctx.moveTo(x, ty(0)); ctx.lineTo(x, y); inSegment = true; }
      else ctx.lineTo(x, y);
    } else if (inSegment) {
      ctx.lineTo(x, ty(0));
      ctx.closePath();
      ctx.fill();
      inSegment = false;
    }
  }
  if (inSegment) {
    const last = samples[samples.length - 1];
    ctx.lineTo(tx(last.t), ty(0));
    ctx.closePath();
    ctx.fill();
  }

  // dots for each entry
  ctx.fillStyle = CURVE_COLOR;
  for (const e of entries) {
    const x = tx(e.time);
    const y = ty(caffeineAt(e.time));
    ctx.beginPath();
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  // crosshair
  if (hoverX !== null) {
    const xPx = hoverX * W;
    const hoverT = earliest + ((xPx - gPad.left) / gw) * tRange;
    const hoverMg = Math.round(caffeineAt(hoverT));
    const curveY = ty(caffeineAt(hoverT));

    // vertical dashed line
    ctx.strokeStyle = "#aaa";
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH_PATTERN);
    ctx.beginPath();
    ctx.moveTo(xPx, gPad.top);
    ctx.lineTo(xPx, gPad.top + gh);
    ctx.stroke();
    ctx.setLineDash([]);

    // dot on curve
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(xPx, curveY, DOT_RADIUS + 1, 0, Math.PI * 2);
    ctx.fill();

    // label
    ctx.fillStyle = "#ddd";
    ctx.textAlign = "center";
    ctx.fillText(`${fmtHHMM(new Date(hoverT))} ${hoverMg}mg`, xPx, gPad.top - 4);
  }
}

// --- Settings ---
const settingsOverlay = document.getElementById("settings-overlay") as HTMLDivElement;
const defaultMgInput = document.getElementById("default-mg-input") as HTMLInputElement;
const halfLifeInput = document.getElementById("half-life-input") as HTMLInputElement;
const thresholdInput = document.getElementById("threshold-input") as HTMLInputElement;

function openSettings() {
  defaultMgInput.value = String(defaultMg);
  halfLifeInput.value = String(halfLifeH);
  thresholdInput.value = String(thresholdMg);
  settingsOverlay.removeAttribute("hidden");
}
function closeSettings() {
  settingsOverlay.setAttribute("hidden", "");
}

document.getElementById("settings-toggle")!.addEventListener("click", openSettings);
document.getElementById("settings-close")!.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

defaultMgInput.addEventListener("change", () => {
  const val = Number(defaultMgInput.value);
  if (val > 0) {
    defaultMg = val;
    mgInput.value = String(defaultMg);
    saveSettings();
  }
});

halfLifeInput.addEventListener("change", () => {
  const val = Number(halfLifeInput.value);
  if (val > 0) {
    halfLifeH = val;
    saveSettings();
    render();
  }
});

thresholdInput.addEventListener("change", () => {
  const val = Number(thresholdInput.value);
  if (val >= 0) {
    thresholdMg = val;
    saveSettings();
    render();
  }
});

document.getElementById("reset-settings")!.addEventListener("click", () => {
  halfLifeH = DEFAULT_HALF_LIFE_H;
  defaultMg = DEFAULT_DEFAULT_MG;
  thresholdMg = DEFAULT_THRESHOLD_MG;
  defaultMgInput.value = String(DEFAULT_DEFAULT_MG);
  halfLifeInput.value = String(DEFAULT_HALF_LIFE_H);
  thresholdInput.value = String(DEFAULT_THRESHOLD_MG);
  mgInput.value = String(DEFAULT_DEFAULT_MG);
  saveSettings();
  render();
});

document.getElementById("reset-all")!.addEventListener("click", () => {
  if (!confirm("Reset everything? All entries and settings will be deleted.")) return;
  entries = [];
  nextId = 1;
  halfLifeH = DEFAULT_HALF_LIFE_H;
  defaultMg = DEFAULT_DEFAULT_MG;
  thresholdMg = DEFAULT_THRESHOLD_MG;
  mgInput.value = String(DEFAULT_DEFAULT_MG);
  save();
  saveSettings();
  closeSettings();
  render();
});

// --- Export / Import ---
document.getElementById("export-json")!.addEventListener("click", () => {
  const data = JSON.stringify({ entries, halfLifeH, defaultMg, thresholdMg }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "coffeinLife.json";
  a.click();
  URL.revokeObjectURL(url);
});

const importFile = document.getElementById("import-file") as HTMLInputElement;
document.getElementById("import-json")!.addEventListener("click", () => {
  importFile.click();
});
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      if (Array.isArray(data.entries)) {
        entries = data.entries;
        nextId = entries.reduce((mx, e) => Math.max(mx, e.id), 0) + 1;
        sortEntries();
        save();
      }
      if (typeof data.halfLifeH === "number" && data.halfLifeH > 0) {
        halfLifeH = data.halfLifeH;
      }
      if (typeof data.defaultMg === "number" && data.defaultMg > 0) {
        defaultMg = data.defaultMg;
        mgInput.value = String(defaultMg);
      }
      if (typeof data.thresholdMg === "number" && data.thresholdMg >= 0) {
        thresholdMg = data.thresholdMg;
      }
      saveSettings();
      render();
    } catch { /* ignore bad files */ }
  };
  reader.readAsText(file);
  importFile.value = "";
});

// --- Crosshair ---
let hoverX: number | null = null;

function onPointerMove(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const pad = GRAPH_PAD.left * rect.width;
  const right = rect.width - GRAPH_PAD.right * rect.width;
  const top = GRAPH_PAD.top * rect.height;
  const bottom = rect.height - GRAPH_PAD.bottom * rect.height;
  if (x >= pad && x <= right && y >= top && y <= bottom) {
    hoverX = x / rect.width;
  } else {
    hoverX = null;
  }
  drawGraph();
}

canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerleave", () => { hoverX = null; drawGraph(); });
canvas.addEventListener("click", (e) => {
  onPointerMove(e as PointerEvent);
});

// --- Resize handling ---
window.addEventListener("resize", drawGraph);

// --- Init ---
render();
