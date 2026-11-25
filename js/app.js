/* Order Tracker v7 — clean rebuild, write-only CSV, no legacy import */

const STORAGE_KEYS = {
  ongoing: "ot7_ongoing",
  area: "ot7_area",
  history: "ot7_history",
  parts: "ot7_parts",
  todoOrder: "ot7_todoOrder",
};

let ongoing = JSON.parse(localStorage.getItem(STORAGE_KEYS.ongoing) || "[]");
let area = JSON.parse(localStorage.getItem(STORAGE_KEYS.area) || "[]");
let history = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || "[]");
let knownParts = JSON.parse(localStorage.getItem(STORAGE_KEYS.parts) || "[]");
let undoStack = [];
let expandedDates = {};
let expandedEntries = {};
let importMode = "replace";

function getOngoingSnapshot() { return ongoing.map((o) => ({ ...o })); }
window.getOngoingSnapshot = getOngoingSnapshot;


let autoSaveCsvHandle = null;
let autoSaveCsvEnabled = false;
let autoSaveDebounceTimer = null;
let writingCsv = false; // guard: never read back while we write

let localPdfFolderHandle = null;
let pdfFileMap = new Map();

const IDB_NAME = "OrderTrackerV7";
const IDB_STORE = "handles";

function uid() {
  return "id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function showSaveIndicator(msg) {
  const el = document.getElementById("saveIndicator");
  if (!el) return;
  el.textContent = msg || (autoSaveCsvEnabled ? "Saved · CSV ✓" : "Saved ✓");
  el.style.opacity = "1";
  setTimeout(() => { el.style.opacity = "0"; }, 1800);
}

// ---- persistence ----
function saveState() {
  undoStack.push(JSON.stringify({ ongoing, area, history }));
  if (undoStack.length > 40) undoStack.shift();
  updateUndoBadge();
}

function saveData() {
  localStorage.setItem(STORAGE_KEYS.ongoing, JSON.stringify(ongoing));
  localStorage.setItem(STORAGE_KEYS.area, JSON.stringify(area));
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history));
  knownParts = [...new Set(knownParts.map((p) => String(p).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  localStorage.setItem(STORAGE_KEYS.parts, JSON.stringify(knownParts));
  scheduleAutoSaveCsv();
}

function manualSave() {
  saveData();
  writeAutoSaveCsvNow().then(() => showSaveIndicator());
}

function undo() {
  if (!undoStack.length) { alert("Nothing to undo"); return; }
  const prev = JSON.parse(undoStack.pop());
  ongoing = prev.ongoing || [];
  area = prev.area || [];
  history = prev.history || [];
  saveData();
  updateUndoBadge();
  render();
}

function updateUndoBadge() {
  const badge = document.getElementById("undoCountBadge");
  const btn = document.getElementById("undoBtn");
  if (!badge || !btn) return;
  if (undoStack.length) {
    badge.textContent = undoStack.length;
    badge.classList.remove("hidden");
    btn.disabled = false;
  } else {
    badge.classList.add("hidden");
    btn.disabled = true;
  }
}

function rememberPart(p) {
  const t = (p || "").trim();
  if (!t) return;
  if (!knownParts.some((x) => x.toLowerCase() === t.toLowerCase())) knownParts.push(t);
}

// ---- IndexedDB handles ----
function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- CSV: write-only auto + download + manual import ----
function generateCSVString() {
  const esc = (s) => `"${String(s || "").replace(/"/g, '""')}"`;
  let csv = "Table,Priority,Status,DueDate,ActivityDate,WN,Part,Qty,OriginalQty,Event,PO,BOL,ScrapType\n";
  ongoing.forEach((o) => {
    csv += ["Ongoing", o.priority ? "Yes" : "No", o.status || "Normal", o.dueDate || "", "", esc(o.wn), esc(o.partNo), o.qty, o.originalQty || o.qty, "Active", esc(o.po), "", ""].join(",") + "\n";
  });
  area.forEach((o) => {
    csv += ["Area", o.priority ? "Yes" : "No", "Staged", o.dueDate || "", "", esc(o.wn), esc(o.partNo), o.qty, o.originalQty || o.qty, "Staged", esc(o.po), "", ""].join(",") + "\n";
  });
  history.forEach((o) => {
    if (o.subs && o.subs.length) {
      o.subs.forEach((s) => {
        csv += [
          "History",
          o.priority ? "Yes" : "No",
          o.status || "Shipped",
          o.dueDate || "",
          s.date || o.shippedDate || "",
          esc(o.wn),
          esc(o.partNo),
          s.qty,
          o.originalQty || o.qty,
          s.type === "scrapped" ? "Scrap" : "Ship",
          esc(o.po),
          esc(o.bol || ""),
          esc(s.scrapType || ""),
        ].join(",") + "\n";
      });
    } else {
      csv += ["History", o.priority ? "Yes" : "No", "Shipped", o.dueDate || "", o.shippedDate || "", esc(o.wn), esc(o.partNo), o.qty, o.originalQty || o.qty, "Ship", esc(o.po), esc(o.bol || ""), ""].join(",") + "\n";
    }
  });
  knownParts.forEach((p) => {
    csv += `KnownPart,,,,,,,,,,${esc(p)},,\n`;
  });
  return "\ufeff" + csv;
}

function downloadCSV() {
  const blob = new Blob([generateCSVString()], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = todayISO();
  a.download = `OrderTracker_${d}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("CSV downloaded");
}

function scheduleAutoSaveCsv() {
  if (!autoSaveCsvEnabled || !autoSaveCsvHandle) return;
  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(() => writeAutoSaveCsvNow(), 500);
}

async function writeAutoSaveCsvNow() {
  if (!autoSaveCsvEnabled || !autoSaveCsvHandle) return;
  writingCsv = true;
  try {
    const writable = await autoSaveCsvHandle.createWritable();
    await writable.write(generateCSVString());
    await writable.close();
  } catch (e) {
    console.error(e);
    autoSaveCsvEnabled = false;
    updateAutoSaveStatusUi();
  } finally {
    writingCsv = false;
  }
}

async function linkAutoSaveCsv() {
  if (!window.showSaveFilePicker) {
    alert("Link CSV needs Chrome or Edge.");
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: `OrderTracker_${todayISO()}.csv`,
      types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
    });
    autoSaveCsvHandle = handle;
    autoSaveCsvEnabled = true;
    await idbSet("csvHandle", handle);
    await writeAutoSaveCsvNow();
    updateAutoSaveStatusUi();
    toast("CSV linked (write-only)");
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

function updateAutoSaveStatusUi() {
  const el = document.getElementById("autoSaveStatus");
  if (!el) return;
  el.textContent = autoSaveCsvEnabled && autoSaveCsvHandle ? `CSV: ${autoSaveCsvHandle.name || "linked"}` : "CSV: off";
}

async function restoreAutoSaveCsvHandle() {
  try {
    const handle = await idbGet("csvHandle");
    if (!handle) return;
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      autoSaveCsvHandle = handle;
      autoSaveCsvEnabled = true;
      updateAutoSaveStatusUi();
    }
  } catch (e) {
    console.warn(e);
  }
}

function parseCsvRow(row) {
  const values = [];
  let inQ = false;
  let cur = "";
  for (const ch of row) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { values.push(cur); cur = ""; }
    else cur += ch;
  }
  values.push(cur);
  return values.map((v) => v.replace(/^"|"$/g, "").trim());
}

function processCSVContent(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = text.trim().split(/\r?\n/);
  if (rows.length < 2) return;

  const header = parseCsvRow(rows[0]).map((h) => h.toLowerCase());
  const col = (name) => header.indexOf(name);

  // v7 columns: Table,Priority,Status,DueDate,ActivityDate,WN,Part,Qty,OriginalQty,Event,PO,BOL,ScrapType
  const iTable = col("table") >= 0 ? col("table") : 0;
  const iPri = col("priority") >= 0 ? col("priority") : 1;
  const iStatus = col("status") >= 0 ? col("status") : 2;
  const iDue = col("duedate") >= 0 ? col("duedate") : 3;
  const iAct = col("activitydate") >= 0 ? col("activitydate") : 4;
  const iWn = col("wn") >= 0 ? col("wn") : 5;
  const iPart = col("part") >= 0 ? col("part") : col("part number") >= 0 ? col("part number") : 6;
  const iQty = col("qty") >= 0 ? col("qty") : 7;
  const iOrig = col("originalqty") >= 0 ? col("originalqty") : 8;
  const iEvent = col("event") >= 0 ? col("event") : 9;
  const iPo = col("po") >= 0 ? col("po") : 10;
  const iBol = col("bol") >= 0 ? col("bol") : 11;
  const iScrap = col("scraptype") >= 0 ? col("scraptype") : 12;

  if (importMode !== "merge") {
    ongoing = [];
    area = [];
    history = [];
  }

  const existingPo = new Set(ongoing.map((o) => (o.po || "").toLowerCase()).filter(Boolean));
  let added = 0;

  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line.trim() || line.startsWith("#")) continue;
    const v = parseCsvRow(line);
    const table = (v[iTable] || "").trim();
    if (table === "KnownPart") {
      const p = v[iPo] || v[iPart] || "";
      if (p) rememberPart(p);
      continue;
    }
    const partNo = (v[iPart] || "").trim();
    if (!partNo) continue;
    const po = (v[iPo] || "").trim();
    const qty = parseInt(v[iQty], 10) || 1;
    const orig = parseInt(v[iOrig], 10) || qty;
    const wn = (v[iWn] || "Wolfsteel").trim() || "Wolfsteel";
    const due = (v[iDue] || "").trim();
    const act = (v[iAct] || "").trim();
    const event = (v[iEvent] || "").trim();
    const bol = (v[iBol] || "").trim();
    const scrapType = (v[iScrap] || "").trim();
    const priority = /yes|true|1/i.test(v[iPri] || "");
    const status = (v[iStatus] || "").trim();

    if (table === "Ongoing" || (!table && event === "Active")) {
      if (importMode === "merge" && po && existingPo.has(po.toLowerCase())) continue;
      ongoing.push({
        id: uid(),
        priority,
        dueDate: due,
        wn,
        partNo,
        po,
        qty,
        originalQty: orig,
        status: status.includes("Partial") ? "partial" : "normal",
        scrapLog: [],
      });
      if (po) existingPo.add(po.toLowerCase());
      rememberPart(partNo);
      added++;
    } else if (table === "Area") {
      // skip area on import — staging is session work
    } else if (table === "History" || event === "Ship" || event === "Scrap") {
      if (importMode === "merge") continue; // never re-import history on merge
      const sub = {
        type: event === "Scrap" ? "scrapped" : "shipped",
        date: act || todayISO(),
        qty,
        scrapType: event === "Scrap" ? scrapType : undefined,
      };
      const existing = history.find(
        (h) => (po && (h.po || "").toLowerCase() === po.toLowerCase() && h.shippedDate === (act || h.shippedDate)) ||
          (!po && h.partNo === partNo && h.dueDate === due && h.wn === wn)
      );
      if (existing) {
        if (!existing.subs) existing.subs = [];
        existing.subs.push(sub);
      } else {
        history.push({
          id: uid(),
          priority,
          status: status || "Shipped",
          dueDate: due,
          shippedDate: act || todayISO(),
          wn,
          partNo,
          po,
          bol,
          qty,
          originalQty: orig,
          subs: [sub],
        });
      }
      rememberPart(partNo);
    }
  }

  saveData();
  render();
  toast(importMode === "merge" ? `Added ${added} new order(s)` : "CSV loaded");
}

function openImportMenu() {
  document.getElementById("importModal").classList.remove("hidden");
}
function closeImportModal() {
  document.getElementById("importModal").classList.add("hidden");
}
function startImport(mode) {
  importMode = mode;
  closeImportModal();
  const input = document.getElementById("csvFile");
  input.value = "";
  input.click();
}

// ---- PDF ----
async function selectPDFFolder() {
  if (!window.showDirectoryPicker) {
    alert("PDF folder needs Chrome or Edge.");
    return;
  }
  try {
    localPdfFolderHandle = await window.showDirectoryPicker();
    await idbSet("pdfHandle", localPdfFolderHandle);
    await scanPdfFolder();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

async function scanPdfFolder() {
  pdfFileMap.clear();
  if (!localPdfFolderHandle) return;
  async function walk(dir, rel) {
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".pdf")) {
        const base = entry.name.replace(/\.pdf$/i, "");
        const key = base.toLowerCase();
        if (!pdfFileMap.has(key)) {
          pdfFileMap.set(key, { fileHandle: entry, displayName: base, relativePath: rel ? `${rel}/${entry.name}` : entry.name });
        }
      } else if (entry.kind === "directory") {
        try { await walk(entry, rel ? `${rel}/${entry.name}` : entry.name); } catch (_) {}
      }
    }
  }
  await walk(localPdfFolderHandle, "");
  const status = document.getElementById("pdfStatus");
  if (status) status.textContent = `${pdfFileMap.size} PDF(s)`;
  refreshPartSuggestions();
  render();
}

async function restorePdfFolderHandle() {
  try {
    const handle = await idbGet("pdfHandle");
    if (!handle) return;
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "read" });
    if (perm === "granted") {
      localPdfFolderHandle = handle;
      await scanPdfFolder();
    }
  } catch (e) {
    console.warn(e);
  }
}

async function openPDF(partOrFileName) {
  if (!localPdfFolderHandle || !pdfFileMap.size) {
    alert("Link a PDF folder first.");
    return;
  }
  const key = (partOrFileName || "").trim().replace(/\.pdf$/i, "").toLowerCase();
  const hit = pdfFileMap.get(key);
  if (!hit) {
    alert(`No PDF matching "${partOrFileName}"`);
    return;
  }
  try {
    const file = await hit.fileHandle.getFile();
    window.open(URL.createObjectURL(file), "_blank");
  } catch (e) {
    alert("Could not open PDF.");
  }
}

window.openPDF = openPDF;

function hasPdfMatch(partNo) {
  if (!localPdfFolderHandle) return null;
  return pdfFileMap.has((partNo || "").trim().toLowerCase());
}

function refreshPartSuggestions(query) {
  const dl = document.getElementById("partSuggestions");
  if (!dl) return;
  dl.innerHTML = "";
  const q = (query == null ? "" : String(query)).trim().toLowerCase();
  if (!q) return;
  const seen = new Set();
  const add = (v) => {
    const t = (v || "").trim();
    if (!t || seen.has(t.toLowerCase()) || !t.toLowerCase().includes(q)) return;
    seen.add(t.toLowerCase());
    const o = document.createElement("option");
    o.value = t;
    dl.appendChild(o);
  };
  knownParts.forEach(add);
  for (const { displayName } of pdfFileMap.values()) add(displayName);
}

function onPartInput(el) {
  if (el) refreshPartSuggestions(el.value);
}

// ---- dates / urgency ----
function getDayOfWeek(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function getPreviousBusinessDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const toISO = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  return { start: toISO(monday), end: toISO(sunday) };
}

function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const { start, end } = getCurrentWeekRange();
  return dateStr >= start && dateStr <= end;
}

function getOrderUrgency(order) {
  if (!order?.dueDate) return { level: "ok", shipBy: "" };
  const shipBy = getPreviousBusinessDay(order.dueDate);
  const t = new Date(todayISO() + "T00:00:00");
  const d = new Date(shipBy + "T00:00:00");
  const delta = Math.round((d - t) / 86400000);
  if (delta < 0) return { level: "overdue", shipBy, delta };
  if (delta === 0) return { level: "due-soon", shipBy, delta };
  return { level: "ok", shipBy, delta };
}

// ---- CRUD ----
function addOrder() {
  const dueDate = document.getElementById("newDueDate").value;
  const wn = document.getElementById("newWN").value;
  const partNo = document.getElementById("newPart").value.trim();
  const po = (document.getElementById("newPO").value || "").trim();
  const qty = parseInt(document.getElementById("newQty").value, 10) || 1;
  const priority = document.getElementById("newPriority").checked;
  if (!dueDate || !partNo) { alert("Enter Due Date and Part Number"); return; }
  if (po && ongoing.some((o) => (o.po || "").toLowerCase() === po.toLowerCase())) {
    alert("That PO is already on an ongoing order.");
    return;
  }
  saveState();
  rememberPart(partNo);
  ongoing.push({
    id: uid(),
    priority,
    dueDate,
    wn,
    partNo,
    po,
    qty,
    originalQty: qty,
    status: "normal",
    scrapLog: [],
  });
  saveData();
  render();
  toast(`Added ${qty} × ${partNo}${po ? " · " + po : ""}`);
  document.getElementById("newPart").value = "";
  document.getElementById("newQty").value = 1;
  document.getElementById("newPO").value = "";
  document.getElementById("newPriority").checked = false;
}

function updateOngoing(index, field, value) {
  saveState();
  if (field === "qty") {
    ongoing[index].qty = parseInt(String(value).split("/")[0], 10) || 0;
  } else if (field === "priority") {
    ongoing[index].priority = !!value;
  } else {
    ongoing[index][field] = value;
    if (field === "partNo") rememberPart(value);
  }
  saveData();
  render();
}

function deleteOngoing(index) {
  if (!confirm("Delete this order?")) return;
  saveState();
  ongoing.splice(index, 1);
  saveData();
  render();
}

// ---- Ship to area ----
let shipIndex = null;
let shipScrapLines = [];

function openShipModal(index) {
  const o = ongoing[index];
  if (!o) return;
  shipIndex = index;
  shipScrapLines = [];
  document.getElementById("shipModalTitle").textContent = `Ship ${o.partNo}`;
  document.getElementById("shipModalSub").textContent = `${o.po || "no PO"} · remaining ${o.qty}`;
  document.getElementById("shipQtyInput").value = o.qty;
  document.getElementById("shipScrapQty").value = 1;
  renderShipScrapLines();
  document.getElementById("shipModal").classList.remove("hidden");
}

function closeShipModal() {
  shipIndex = null;
  shipScrapLines = [];
  document.getElementById("shipModal").classList.add("hidden");
}

function renderShipScrapLines() {
  const el = document.getElementById("shipScrapList");
  if (!el) return;
  el.innerHTML = shipScrapLines.length
    ? shipScrapLines.map((l, i) => `<div class="flex justify-between px-3 py-1.5 rounded-xl bg-cream-100 border border-cream-200"><span>${l.qty} × ${l.type}</span><button class="text-rose-600 text-xs font-bold" onclick="removeShipScrapLine(${i})">remove</button></div>`).join("")
    : `<div class="text-slate-400 text-xs">No scrap added</div>`;
}

function addShipScrapLine() {
  const qty = parseInt(document.getElementById("shipScrapQty").value, 10);
  const type = document.getElementById("shipScrapType").value;
  if (!qty || qty <= 0 || !type) return;
  shipScrapLines.push({ type, qty });
  document.getElementById("shipScrapQty").value = 1;
  renderShipScrapLines();
}

function removeShipScrapLine(i) {
  shipScrapLines.splice(i, 1);
  renderShipScrapLines();
}

function confirmShipModal() {
  const o = ongoing[shipIndex];
  if (!o) { closeShipModal(); return; }
  const qty = parseInt(document.getElementById("shipQtyInput").value, 10);
  const scrapTotal = shipScrapLines.reduce((a, l) => a + l.qty, 0);
  if (isNaN(qty) || qty <= 0 || qty > o.qty) { alert("Invalid bin qty"); return; }
  if (qty + scrapTotal > o.qty) { alert("Bin + scrap exceeds remaining"); return; }
  saveState();
  const today = todayISO();
  if (!o.scrapLog) o.scrapLog = [];
  shipScrapLines.forEach((l) => o.scrapLog.push({ type: l.type, date: today, qty: l.qty }));
  o.qty -= scrapTotal;
  area.push({
    id: o.id,
    binId: uid(),
    priority: o.priority,
    dueDate: o.dueDate,
    wn: o.wn,
    partNo: o.partNo,
    po: o.po || "",
    qty,
    originalQty: o.originalQty || o.qty,
    scrapLog: (o.scrapLog || []).map((s) => ({ ...s })),
  });
  o.qty -= qty;
  o.status = "partial";
  if (o.qty <= 0) ongoing.splice(shipIndex, 1);
  closeShipModal();
  saveData();
  render();
  toast(`Staged ${qty} × ${o.partNo}`);
}

// ---- Scrap on ongoing ----
let scrapIndex = null;
let scrapLines = [];

function openScrapModal(index) {
  const o = ongoing[index];
  if (!o) return;
  scrapIndex = index;
  scrapLines = [];
  document.getElementById("scrapModalTitle").textContent = `Scrap · ${o.po ? "PO " + o.po : o.partNo}`;
  document.getElementById("scrapModalSub").textContent = `${o.partNo} · remaining ${o.qty}`;
  document.getElementById("scrapQtyInput").value = 1;
  renderScrapLines();
  document.getElementById("scrapModal").classList.remove("hidden");
}

function closeScrapModal() {
  scrapIndex = null;
  scrapLines = [];
  document.getElementById("scrapModal").classList.add("hidden");
}

function scrapLinesTotal() {
  return scrapLines.reduce((a, l) => a + l.qty, 0);
}

function renderScrapLines() {
  const el = document.getElementById("scrapLineList");
  const hint = document.getElementById("scrapRemainingHint");
  const o = scrapIndex != null ? ongoing[scrapIndex] : null;
  const used = scrapLinesTotal();
  if (el) {
    el.innerHTML = scrapLines.length
      ? scrapLines.map((l, i) => `<div class="flex justify-between px-3 py-1.5 rounded-xl bg-cream-100 border border-cream-200"><span>${l.qty} × ${l.type}</span><button class="text-rose-600 text-xs font-bold" onclick="removeScrapLine(${i})">remove</button></div>`).join("")
      : `<div class="text-slate-400 text-xs">No scrap lines yet</div>`;
  }
  if (hint && o) hint.textContent = `Queued ${used} · available ${Math.max(0, o.qty - used)}`;
}

function addScrapLine() {
  if (scrapIndex == null) return;
  const o = ongoing[scrapIndex];
  const type = document.getElementById("scrapTypeInput").value;
  const qty = parseInt(document.getElementById("scrapQtyInput").value, 10);
  if (!qty || qty <= 0) return;
  if (scrapLinesTotal() + qty > o.qty) { alert("Not enough remaining"); return; }
  scrapLines.push({ type, qty });
  document.getElementById("scrapQtyInput").value = Math.max(1, o.qty - scrapLinesTotal());
  renderScrapLines();
}

function removeScrapLine(i) {
  scrapLines.splice(i, 1);
  renderScrapLines();
}

function confirmScrap() {
  if (scrapIndex == null) return;
  const o = ongoing[scrapIndex];
  if (!scrapLines.length) { alert("Add at least one scrap line"); return; }
  const total = scrapLinesTotal();
  if (total > o.qty) return;
  saveState();
  const today = todayISO();
  if (!o.scrapLog) o.scrapLog = [];
  scrapLines.forEach((l) => o.scrapLog.push({ type: l.type, date: today, qty: l.qty }));
  o.qty -= total;
  o.status = "partial";
  if (o.qty <= 0) {
    // fully scrapped → history
    history.push({
      id: o.id,
      priority: o.priority,
      status: "Scrapped",
      dueDate: o.dueDate,
      shippedDate: today,
      wn: o.wn,
      partNo: o.partNo,
      po: o.po || "",
      bol: "",
      qty: o.originalQty || total,
      originalQty: o.originalQty || total,
      subs: o.scrapLog.map((s) => ({ type: "scrapped", scrapType: s.type, date: s.date, qty: s.qty })),
    });
    ongoing.splice(scrapIndex, 1);
  }
  closeScrapModal();
  saveData();
  render();
  toast(`Scrap recorded (${total})`);
}

// ---- Area → History with BOL ----
let bolTargets = null; // indices into area, reverse-safe

function openBolModal(indexes, label) {
  bolTargets = indexes.slice().sort((a, b) => b - a); // high to low for splice
  document.getElementById("bolModalSub").textContent = label;
  document.getElementById("bolInput").value = "";
  document.getElementById("bolModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("bolInput").focus(), 30);
}

function closeBolModal() {
  bolTargets = null;
  document.getElementById("bolModal").classList.add("hidden");
}

function confirmBolModal() {
  if (!bolTargets || !bolTargets.length) { closeBolModal(); return; }
  const bol = (document.getElementById("bolInput").value || "").trim();
  saveState();
  const today = todayISO();
  bolTargets.forEach((index) => {
    const item = area[index];
    if (!item) return;
    const scrapSubs = (item.scrapLog || []).map((s) => ({
      type: "scrapped",
      scrapType: s.type,
      date: s.date || today,
      qty: s.qty,
    }));
    const shipSub = { type: "shipped", date: today, qty: item.qty };
    const poKey = (item.po || "").trim().toLowerCase();
    const bolKey = (bol || "").trim().toLowerCase();
    // Same PO + same BOL → one history row, total qty
    let existing = null;
    if (poKey || bolKey) {
      existing = history.find((h) =>
        (h.po || "").trim().toLowerCase() === poKey &&
        (h.bol || "").trim().toLowerCase() === bolKey &&
        (h.partNo || "") === (item.partNo || "") &&
        (h.wn || "") === (item.wn || "")
      );
    }
    if (existing) {
      if (!existing.subs) existing.subs = [];
      existing.subs.push(...scrapSubs, shipSub);
      existing.qty = (existing.subs.filter((s) => s.type === "shipped").reduce((a, s) => a + (s.qty || 0), 0));
      // Status: still open on ongoing → Partial; fully done → Shipped
      const stillOpen = ongoing.some((o) => o.id === item.id && o.qty > 0);
      existing.status = stillOpen ? "Partial" : "Shipped";
      existing.shippedDate = today;
      if (bol) existing.bol = bol;
    } else {
      const stillOpen = ongoing.some((o) => o.id === item.id && o.qty > 0);
      history.push({
        id: item.id,
        binId: item.binId || uid(),
        priority: item.priority,
        status: stillOpen ? "Partial" : "Shipped",
        dueDate: item.dueDate,
        shippedDate: today,
        wn: item.wn,
        partNo: item.partNo,
        po: item.po || "",
        bol,
        qty: item.qty,
        originalQty: item.originalQty || item.qty,
        subs: [...scrapSubs, shipSub],
      });
    }
  });
  bolTargets.forEach((index) => area.splice(index, 1));
  closeBolModal();
  saveData();
  render();
  toast(bol ? `Shipped under BOL ${bol}` : "Shipped (no BOL)");
}

function shipOneFromArea(index) {
  const item = area[index];
  if (!item) return;
  openBolModal([index], `${item.qty} × ${item.partNo} (${item.wn})`);
}

function shipAreaByWn(wn) {
  const indexes = area.map((o, i) => (o.wn === wn ? i : -1)).filter((i) => i >= 0);
  if (!indexes.length) { alert(`Nothing in Shipping Area for ${wn}`); return; }
  const total = indexes.reduce((a, i) => a + (area[i].qty || 0), 0);
  openBolModal(indexes, `${indexes.length} ${wn} bin(s) · ${total} qty`);
}

function returnFromArea(index) {
  saveState();
  const item = area[index];
  if (!item) return;
  let target = ongoing.find((o) => o.id === item.id);
  if (target) {
    target.qty += item.qty;
  } else {
    ongoing.push({
      id: item.id,
      priority: item.priority,
      dueDate: item.dueDate,
      wn: item.wn,
      partNo: item.partNo,
      po: item.po || "",
      qty: item.qty,
      originalQty: item.originalQty || item.qty,
      status: "partial",
      scrapLog: item.scrapLog || [],
    });
  }
  area.splice(index, 1);
  saveData();
  render();
}

function deleteHistory(index) {
  if (!confirm("Delete this history row?")) return;
  saveState();
  history.splice(index, 1);
  saveData();
  render();
}

// ---- BOL preview ----
function printBOL() {
  if (!area.length) { alert("Shipping Area is empty"); return; }
  const grouped = {};
  area.forEach((o) => {
    const wn = o.wn === "NAC" ? "NAC" : "Wolfsteel";
    const key = `${wn}|${(o.partNo || "").trim()}|${(o.po || "").trim()}`;
    if (!grouped[key]) grouped[key] = { wn, partNo: o.partNo || "", po: o.po || "", qty: 0 };
    grouped[key].qty += o.qty || 0;
  });
  const byWn = { Wolfsteel: [], NAC: [] };
  Object.values(grouped).forEach((g) => byWn[g.wn].push(g));
  let html = "";
  ["Wolfsteel", "NAC"].forEach((wn) => {
    if (!byWn[wn].length) return;
    html += `<div><div class="font-display font-extrabold text-base mb-1">${wn}</div>`;
    byWn[wn].forEach((o) => { html += `<div>${o.qty} &nbsp; ${o.partNo} &nbsp; ${o.po}</div>`; });
    html += `</div>`;
  });
  document.getElementById("bolPreview").innerHTML = html;
  document.getElementById("bolSection").classList.remove("hidden");
}

function closeBOL() {
  document.getElementById("bolSection").classList.add("hidden");
}

// ---- helpers UI ----
function scrapForPo(po) {
  if (!po) return 0;
  const key = po.toLowerCase();
  return history.reduce((acc, o) => {
    if ((o.po || "").toLowerCase() !== key) return acc;
    return acc + (o.subs || []).filter((s) => s.type === "scrapped").reduce((a, s) => a + (s.qty || 0), 0);
  }, 0);
}

function openPdfLookup() {
  document.getElementById("pdfModal").classList.remove("hidden");
  document.getElementById("pdfLookupInput").value = "";
  updatePdfLookupStatus();
}
function closePdfLookup() { document.getElementById("pdfModal").classList.add("hidden"); }
function updatePdfLookupStatus() {
  const v = (document.getElementById("pdfLookupInput").value || "").trim();
  const el = document.getElementById("pdfLookupStatus");
  if (!v) { el.textContent = "Type a part number"; return; }
  const hit = hasPdfMatch(v);
  el.textContent = hit === true ? "PDF found" : hit === false ? "No PDF for that part" : "Folder not linked";
}
function openPdfFromLookup() {
  const v = (document.getElementById("pdfLookupInput").value || "").trim();
  if (v) openPDF(v);
}

function openCalendar() {
  const counts = {};
  ongoing.forEach((o) => { if (o.dueDate) counts[o.dueDate] = (counts[o.dueDate] || 0) + 1; });
  const dates = Object.keys(counts).sort();
  const body = document.getElementById("calendarBody");
  if (!dates.length) body.innerHTML = `<p class="text-slate-400">No ongoing orders</p>`;
  else {
    body.innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">` + dates.map((d) => {
      const list = ongoing.filter((o) => o.dueDate === d).map((o) => `${o.qty} ${o.partNo} ${o.wn}`).join("<br>");
      return `<button class="text-left p-3 rounded-xl border border-slate-200 bg-white" onclick="this.querySelector('.daylist').classList.toggle('hidden')"><div class="font-bold">${d} · ${counts[d]}</div><div class="daylist hidden text-xs mt-1 text-slate-600">${list}</div></button>`;
    }).join("") + `</div>`;
  }
  document.getElementById("calendarModal").classList.remove("hidden");
}
function closeCalendar() { document.getElementById("calendarModal").classList.add("hidden"); }

function openPastRecords() {
  const old = history.filter((o) => !isThisWeek(o.shippedDate));
  const body = document.getElementById("pastBody");
  if (!old.length) body.innerHTML = `<p class="text-slate-400">No older records</p>`;
  else {
    body.innerHTML = `<table class="w-full text-sm"><thead><tr><th>Date</th><th>Part</th><th>PO</th><th>BOL</th><th>Qty</th><th>Scrap</th></tr></thead><tbody>` +
      old.map((o) => {
        const scrap = (o.subs || []).filter((s) => s.type === "scrapped").reduce((a, s) => a + s.qty, 0);
        return `<tr><td>${o.shippedDate || ""}</td><td>${o.partNo || ""}</td><td>${o.po || ""}</td><td>${o.bol || ""}</td><td>${o.qty}</td><td>${scrap || ""}</td></tr>`;
      }).join("") + `</tbody></table>`;
  }
  document.getElementById("pastModal").classList.remove("hidden");
}
function closePastRecords() { document.getElementById("pastModal").classList.add("hidden"); }

function openTodoWindow() {
  const w = window.open("", "trackerTodoV7", "width=460,height=760");
  if (!w) { alert("Allow popups for the to-do window"); return; }
  // Snapshot + keep parent list in sync via localStorage key ot7_ongoing
  const snap = JSON.stringify(ongoing || []);
  const html = `<!DOCTYPE html><html><head><title>To-Do</title>
  <style>
  body{font-family:Inter,Segoe UI,sans-serif;background:#12121a;color:#f1f0f5;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 4px}.hint{color:#6e6c7e;font-size:12px;margin:0 0 12px}
  .item{display:flex;align-items:center;gap:8px;padding:10px 12px;margin:6px 0;background:#1e1e2a;border-radius:12px;cursor:grab}
  .item.over{outline:2px solid #8B7AE8}.main{flex:1}.meta{color:#a8a6b8;font-size:12px}
  .pdf{border:0;border-radius:8px;padding:6px 8px;font-weight:700;font-size:11px;cursor:pointer;background:#134e4a;color:#99f6e4}
  .empty{color:#6e6c7e;margin-top:24px}
  </style></head><body>
  <h1>To-Do · ongoing</h1>
  <p class="hint">Drag to reorder. Open PDF uses the folder linked on the main tracker. Keep this window and the main page open.</p>
  <div id="list"></div>
  <script>
  var SNAP = ${snap};
  function load(){
    try {
      if (window.opener && Array.isArray(window.opener.getOngoingSnapshot)) {
        var fromParent = window.opener.getOngoingSnapshot();
        if (fromParent && fromParent.length) return fromParent;
      }
    } catch (e) {}
    try {
      var ls = JSON.parse(localStorage.getItem("ot7_ongoing") || "[]");
      if (ls && ls.length) return ls;
    } catch (e) {}
    return Array.isArray(SNAP) ? SNAP : [];
  }
  function orderIds(){ try { return JSON.parse(localStorage.getItem("ot7_todoOrder")||"[]"); } catch(e){ return []; } }
  function saveOrder(ids){ localStorage.setItem("ot7_todoOrder", JSON.stringify(ids)); }
  function sorted(){
    var data = load().slice();
    data.forEach(function(o,i){ if (!o.id) o.id = "tmp_"+i; });
    var ids = orderIds();
    var byId = {};
    data.forEach(function(o){ byId[o.id] = o; });
    var out = [];
    ids.forEach(function(id){ if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
    Object.keys(byId).forEach(function(k){ out.push(byId[k]); });
    return out;
  }
  function render(){
    var data = sorted();
    var list = document.getElementById("list");
    if (!data.length) { list.innerHTML = '<p class="empty">No ongoing orders</p>'; return; }
    list.innerHTML = data.map(function(o){
      return '<div class="item" draggable="true" data-id="'+(o.id||'')+'">'+
        '<div class="main"><strong>'+o.qty+'</strong> '+(o.partNo||'')+
        '<div class="meta">'+(o.wn||'')+' · '+(o.dueDate||'')+'</div></div>'+
        '<button class="pdf" data-part="'+(String(o.partNo||'').replace(/"/g,'&quot;'))+'">Open PDF</button></div>';
    }).join("");
    list.querySelectorAll(".pdf").forEach(function(btn){
      btn.onclick = function(){
        var part = btn.getAttribute("data-part");
        if (window.opener && window.opener.openPDF) window.opener.openPDF(part);
        else alert("Keep the main tracker open and link the PDF folder.");
      };
    });
    var dragId = null;
    list.querySelectorAll(".item").forEach(function(el){
      el.ondragstart = function(){ dragId = el.dataset.id; };
      el.ondragover = function(e){ e.preventDefault(); el.classList.add("over"); };
      el.ondragleave = function(){ el.classList.remove("over"); };
      el.ondrop = function(e){
        e.preventDefault(); el.classList.remove("over");
        if (!dragId || dragId === el.dataset.id) return;
        var ids = sorted().map(function(o){ return o.id; });
        var from = ids.indexOf(dragId);
        var to = ids.indexOf(el.dataset.id);
        if (from < 0 || to < 0) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        saveOrder(ids);
        render();
      };
    });
  }
  render();
  setInterval(render, 2000);
  <\/script></body></html>`;
  w.document.write(html);
  w.document.close();
}

function toggleDarkMode() {
  document.documentElement.classList.toggle("dark");
  localStorage.setItem("ot7_dark", document.documentElement.classList.contains("dark") ? "1" : "0");
  if (window.lucide) lucide.createIcons();
}

function toggleDensity() {
  document.documentElement.classList.toggle("compact");
  const on = document.documentElement.classList.contains("compact");
  localStorage.setItem("ot7_compact", on ? "1" : "0");
  const label = document.getElementById("densityLabel");
  if (label) label.textContent = on ? "Comfort" : "Compact";
}

function toggleDateAccordion(dateStr) {
  expandedDates[dateStr] = expandedDates[dateStr] === false ? true : false;
  if (expandedDates[dateStr] === false) expandedDates[dateStr] = false;
  else expandedDates[dateStr] = true;
  // simpler: flip
  expandedDates[dateStr] = !expandedDates[dateStr];
  render();
}

// ---- render ----
function updateStats() {
  const el = (id) => document.getElementById(id);
  if (el("statOngoing")) el("statOngoing").textContent = ongoing.length;
  if (el("statPriority")) el("statPriority").textContent = ongoing.filter((o) => o.priority).length;
  if (el("statPartial")) el("statPartial").textContent = ongoing.filter((o) => o.status === "partial").length;
  if (el("statOverdue")) el("statOverdue").textContent = ongoing.filter((o) => getOrderUrgency(o).level === "overdue").length;
  if (el("statShipped")) {
    const n = history.filter((o) => isThisWeek(o.shippedDate)).reduce((a, o) => {
      const ships = (o.subs || []).filter((s) => s.type === "shipped");
      return a + (ships.length ? ships.length : 1);
    }, 0);
    el("statShipped").textContent = n;
  }
  const strip = document.getElementById("shipByStrip");
  if (strip) {
    const counts = {};
    ongoing.forEach((o) => {
      if (!o.dueDate) return;
      const sb = getPreviousBusinessDay(o.dueDate);
      counts[sb] = (counts[sb] || 0) + 1;
    });
    const dates = Object.keys(counts).sort();
    if (!dates.length) strip.textContent = "Ship-by day · no ongoing orders";
    else {
      const today = todayISO();
      strip.innerHTML = dates.map((d) => {
        let cls = "inline-block mr-2 mb-1 px-2 py-1 rounded-lg bg-cream-100 text-slate-700 text-xs font-semibold";
        if (d < today) cls += " text-rose-700 bg-rose-50";
        else if (d === today) cls += " text-amber-800 bg-amber-50";
        return `<span class="${cls}">${getDayOfWeek(d)} ${d.slice(5)} · ${counts[d]} order${counts[d] === 1 ? "" : "s"}</span>`;
      }).join("");
    }
  }
}

function render() {
  updateStats();
  updateUndoBadge();
  const search = (document.getElementById("searchBox")?.value || "").toLowerCase();

  // sort ongoing
  ongoing.sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
  });

  const ongoingTable = document.getElementById("ongoingTable");
  const stagingTable = document.getElementById("stagingTable");
  const shippedTable = document.getElementById("shippedTable");
  if (!ongoingTable || !stagingTable || !shippedTable) return;

  ongoingTable.innerHTML = "";
  let lastShipBy = "";
  ongoing.forEach((o, index) => {
    if (search && !JSON.stringify(o).toLowerCase().includes(search)) return;
    const shipBy = o.dueDate ? getPreviousBusinessDay(o.dueDate) : "";
    if (shipBy && shipBy !== lastShipBy) {
      ongoingTable.innerHTML += `<tr class="separator-row"><td colspan="9" class="rounded-lg">Ship By: ${shipBy} (${getDayOfWeek(shipBy)}) — Due: ${o.dueDate} (${getDayOfWeek(o.dueDate)})</td></tr>`;
      lastShipBy = shipBy;
    }
    const urgency = getOrderUrgency(o);
    const rowClasses = [];
    if (o.priority) rowClasses.push("priority-row");
    if (o.status === "partial") rowClasses.push("partial-row");
    if (urgency.level === "overdue") rowClasses.push("overdue-row");
    else if (urgency.level === "due-soon") rowClasses.push("due-soon-row");
    const scrapTotal = (o.scrapLog || []).reduce((a, s) => a + (s.qty || 0), 0);
    const qtyDisp = o.status === "partial" || scrapTotal ? `${o.qty}/${o.originalQty || o.qty}` : o.qty;
    const scrapHtml = scrapTotal ? `<div class="text-[11px] font-bold text-rose-600">scrap ${scrapTotal}</div>` : "";
    const pdf = hasPdfMatch(o.partNo);
    const partEsc = (o.partNo || "").replace(/'/g, "\\'");
    const pdfHtml = pdf === true
      ? `<span class="pdf-link" onclick="openPDF('${partEsc}')">Open PDF</span>`
      : pdf === false ? `<span class="pdf-missing">No PDF</span>` : "";
    ongoingTable.innerHTML += `
      <tr class="${rowClasses.join(" ")}">
        <td class="text-center"><input type="checkbox" ${o.priority ? "checked" : ""} onchange="updateOngoing(${index},'priority',this.checked)"></td>
        <td><input type="date" value="${o.dueDate || ""}" onchange="updateOngoing(${index},'dueDate',this.value)"> <span class="day-badge">${getDayOfWeek(o.dueDate)}</span></td>
        <td><select onchange="updateOngoing(${index},'wn',this.value)"><option ${o.wn === "Wolfsteel" ? "selected" : ""}>Wolfsteel</option><option ${o.wn === "NAC" ? "selected" : ""}>NAC</option></select></td>
        <td><input type="text" value="${(o.partNo || "").replace(/"/g, "&quot;")}" onchange="updateOngoing(${index},'partNo',this.value)" oninput="onPartInput(this)" list="partSuggestions" autocomplete="off" class="w-full min-w-[100px]"><br>${pdfHtml}</td>
        <td><input type="text" value="${o.po || ""}" onchange="updateOngoing(${index},'po',this.value)" placeholder="PO #" class="w-24">${!(o.po && o.po.trim()) ? '<div class="no-po-badge">Add PO</div>' : ""}</td>
        <td><input type="text" value="${qtyDisp}" onchange="updateOngoing(${index},'qty',this.value)" class="w-20">${scrapHtml}</td>
        <td><button class="btn-action btn-ship btn-trendy" onclick="openShipModal(${index})">Ship</button></td>
        <td><button class="btn-action btn-scrap btn-trendy" onclick="openScrapModal(${index})">Scrap</button></td>
        <td><button class="btn-action btn-delete btn-trendy" onclick="deleteOngoing(${index})">Del</button></td>
      </tr>`;
  });

  if (!area.length) {
    stagingTable.innerHTML = `<tr><td colspan="7" class="text-center text-slate-400 py-4 text-sm">Empty — Ship from Ongoing to stage bins here</td></tr>`;
  } else {
    stagingTable.innerHTML = area.map((item, index) => {
      const scrap = (item.scrapLog || []).reduce((a, s) => a + (s.qty || 0), 0);
      return `<tr>
        <td>${item.dueDate || ""}</td>
        <td>${item.wn || ""}</td>
        <td>${item.partNo || ""}</td>
        <td>${item.po || ""}</td>
        <td>${item.qty}${scrap ? `<div class="text-[11px] font-bold text-rose-600">scrap ${scrap}</div>` : ""}</td>
        <td><button class="btn-action btn-ship btn-trendy" onclick="shipOneFromArea(${index})">Ship</button></td>
        <td><button class="btn-action btn-return btn-trendy" onclick="returnFromArea(${index})">Return</button></td>
      </tr>`;
    }).join("");
  }

  shippedTable.innerHTML = "";
  const byDate = {};
  let visible = 0;
  history.forEach((o, index) => {
    if (!isThisWeek(o.shippedDate)) return;
    if (search && !JSON.stringify(o).toLowerCase().includes(search)) return;
    const k = o.shippedDate || "unknown";
    if (!byDate[k]) byDate[k] = [];
    byDate[k].push({ o, index });
    visible++;
  });
  if (!visible) {
    const { start, end } = getCurrentWeekRange();
    shippedTable.innerHTML = `<tr><td colspan="9" class="text-center text-slate-400 py-6 text-sm">No shipments this week (${start} → ${end})</td></tr>`;
  } else {
    Object.keys(byDate).sort().reverse().forEach((dateKey) => {
      const isOpen = expandedDates[dateKey] !== false;
      shippedTable.innerHTML += `<tr class="separator-row" onclick="expandedDates['${dateKey}']=!(expandedDates['${dateKey}']!==false);render()"><td colspan="9">${isOpen ? "▼" : "▶"} Shipped Date: ${dateKey} (${getDayOfWeek(dateKey)})</td></tr>`;
      if (!isOpen) return;
      byDate[dateKey].forEach(({ o, index }) => {
        const scrap = (o.subs || []).filter((s) => s.type === "scrapped").reduce((a, s) => a + s.qty, 0);
        const shipQty = (o.subs || []).filter((s) => s.type === "shipped").reduce((a, s) => a + s.qty, 0) || o.qty;
        const poScrap = scrapForPo(o.po);
        const scrapHtml = (scrap || poScrap)
          ? `<div class="text-[11px] font-bold text-rose-600">scrap ${scrap || poScrap}${o.po ? " · PO total" : ""}</div>`
          : "";
        shippedTable.innerHTML += `<tr class="shipped-row">
          <td>${o.status || ""}</td>
          <td>${o.dueDate || ""}</td>
          <td>${o.shippedDate || ""}</td>
          <td>${o.wn || ""}</td>
          <td>${o.partNo || ""}</td>
          <td>${o.po || ""}</td>
          <td>${o.bol || ""}</td>
          <td>${shipQty}${scrapHtml}</td>
          <td><button class="btn-action btn-delete btn-trendy" onclick="deleteHistory(${index})">Del</button></td>
        </tr>`;
      });
    });
  }

  if (window.lucide) lucide.createIcons();
}

// ---- init ----
async function init() {
  if (localStorage.getItem("ot7_dark") === "1") document.documentElement.classList.add("dark");
  if (localStorage.getItem("ot7_compact") === "1") {
    document.documentElement.classList.add("compact");
    const label = document.getElementById("densityLabel");
    if (label) label.textContent = "Comfort";
  }

  document.getElementById("csvFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      processCSVContent(e.target.result);
      event.target.value = "";
    };
    reader.readAsText(file);
  });

  await restoreAutoSaveCsvHandle();
  updateAutoSaveStatusUi();
  await restorePdfFolderHandle();
  render();
  if (window.lucide) lucide.createIcons();
}

document.addEventListener("DOMContentLoaded", init);
