// ---------- PWA / Service Worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
  });
}

// ---------- IndexedDB ----------
const DB_NAME = "worklog_db";
const STORE = "jobs";
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const s = d.createObjectStore(STORE, { keyPath: "id" });
      s.createIndex("date", "date");
      s.createIndex("createdAt", "createdAt");
      s.createIndex("search", "search");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function store(mode="readonly") {
  return db.transaction(STORE, mode).objectStore(STORE);
}
function getAllJobs() {
  return new Promise((resolve, reject) => {
    const req = store().getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function putJob(job) {
  return new Promise((resolve, reject) => {
    const req = store("readwrite").put(job);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function deleteJob(id) {
  return new Promise((resolve, reject) => {
    const req = store("readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const statusEl = $("#status");

function setStatus(msg) {
  statusEl.textContent = msg || "";
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 1800);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function fmtDate(iso) {
  const [y,m,d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function toGermanDate(iso) {
  // iso yyyy-mm-dd -> dd.mm.yyyy
  return fmtDate(iso);
}
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function makeSearchString(job) {
  // Wichtig: ISO-Datum + deutsches Datum + alle Felder
  const iso = job.date || "";
  const de = iso ? toGermanDate(iso) : "";
  return [iso, de, job.wo, job.tc, job.pn, job.text]
    .filter(Boolean).join(" ").toLowerCase();
}
function uuid() {
  return (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
function groupByDate(jobs) {
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.date)) map.set(j.date, []);
    map.get(j.date).push(j);
  }
  const dates = [...map.keys()].sort((a,b)=> b.localeCompare(a));
  return dates.map(date => ({
    date,
    items: map.get(date).sort((a,b)=> b.createdAt - a.createdAt)
  }));
}

// ---------- Rendering ----------
let currentTab = "today";

async function render() {
  if (currentTab === "today") return renderToday();
  if (currentTab === "days") return renderDays();
  if (currentTab === "bydate") return renderByDate();
  if (currentTab === "search") return renderSearch();
}

function cardJobInner(job, showDate=false) {
  return `
    <div style="display:flex;justify-content:space-between;gap:10px;">
      <div>
        ${showDate ? `<div class="muted">${fmtDate(job.date)}</div>` : ``}
        <div>
          ${job.wo ? `<span class="pill">W/O: ${escapeHtml(job.wo)}</span>` : ``}
          ${job.tc ? `<span class="pill">T/C: ${escapeHtml(job.tc)}</span>` : ``}
          ${job.pn ? `<span class="pill">P/N: ${escapeHtml(job.pn)}</span>` : ``}
        </div>
        ${job.text
          ? `<div style="margin-top:8px;">${escapeHtml(job.text).replace(/\n/g,"<br>")}</div>`
          : `<div class="muted" style="margin-top:8px;">(kein Freitext)</div>`}
      </div>
      <div class="actions">
        <button data-edit="${job.id}">Bearbeiten</button>
        <button data-del="${job.id}" class="danger">Löschen</button>
      </div>
    </div>
  `;
}
function cardJob(job, showDate=false) {
  return `<div class="card">${cardJobInner(job, showDate)}</div>`;
}

function bindCardActions() {
  document.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-del");
      if (confirm("Eintrag wirklich löschen?")) {
        await deleteJob(id);
        setStatus("Gelöscht.");
        render();
      }
    };
  });
  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-edit");
      const jobs = await getAllJobs();
      const job = jobs.find(j => j.id === id);
      if (job
