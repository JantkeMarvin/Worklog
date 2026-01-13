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
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function makeSearchString(job) {
  return [job.date, job.wo, job.tc, job.pn, job.text]
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
      if (job) renderForm(job);
    };
  });
}

async function renderToday() {
  const jobs = await getAllJobs();
  const t = todayISO();
  const todays = jobs.filter(j => j.date === t).sort((a,b)=> b.createdAt - a.createdAt);

  view.innerHTML = `
    <h2>Heute (${fmtDate(t)})</h2>
    ${todays.length ? todays.map(j => cardJob(j)).join("") : `<p class="muted">Noch keine Einträge für heute.</p>`}
  `;
  bindCardActions();
}

async function renderDays() {
  const jobs = await getAllJobs();
  const grouped = groupByDate(jobs);

  view.innerHTML = `
    <h2>Alle Tage</h2>
    ${grouped.length ? grouped.map(g => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${fmtDate(g.date)}</strong>
          <span class="muted">${g.items.length} Auftrag${g.items.length===1?"":"e"}</span>
        </div>
        <hr>
        ${g.items.map(j => cardJob(j)).join("")}
      </div>
    `).join("") : `<p class="muted">Noch keine Einträge vorhanden.</p>`}
  `;
  bindCardActions();
}

async function renderSearch() {
  view.innerHTML = `
    <h2>Suche</h2>
    <input id="q" placeholder="Suche nach W/O, T/C, P/N oder Text…" />
    <div id="results" style="margin-top:10px;"></div>
  `;

  const input = $("#q");
  const results = $("#results");

  let jobs = await getAllJobs();

  function doSearch() {
    const q = (input.value || "").trim().toLowerCase();
    if (!q) {
      results.innerHTML = `<p class="muted">Tippe etwas ein, um zu suchen.</p>`;
      return;
    }
    const hits = jobs
      .filter(j => (j.search || "").includes(q))
      .sort((a,b)=> b.createdAt - a.createdAt);

    results.innerHTML = hits.length
      ? hits.map(j => cardJob(j, true)).join("")
      : `<p class="muted">Keine Treffer.</p>`;

    bindCardActions();
  }

  input.addEventListener("input", doSearch);
  doSearch();
}

// ---------- Form (Neu/Bearbeiten) ----------
function renderForm(existing=null) {
  const isEdit = !!existing;
  const d = existing?.date || todayISO();

  view.innerHTML = `
    <h2>${isEdit ? "Auftrag bearbeiten" : "Neuer Auftrag"}</h2>

    <label>Datum</label>
    <input id="date" type="date" value="${escapeHtml(d)}" />

    <div class="row">
      <div>
        <label>W/O</label>
        <input id="wo" placeholder="z.B. 123456" value="${escapeHtml(existing?.wo || "")}" />
      </div>
      <div>
        <label>T/C</label>
        <input id="tc" placeholder="z.B. ABC-01" value="${escapeHtml(existing?.tc || "")}" />
      </div>
    </div>

    <label>P/N</label>
    <input id="pn" placeholder="z.B. 98-7654-321" value="${escapeHtml(existing?.pn || "")}" />

    <label>Durchgeführte Arbeiten (Freitext)</label>
    <textarea id="text" placeholder="Kurz und klar: was hast du gemacht?">${escapeHtml(existing?.text || "")}</textarea>

    <div class="row" style="margin-top:12px;">
      <button id="saveBtn" class="primary">${isEdit ? "Speichern" : "Anlegen"}</button>
      <button id="cancelBtn">Abbrechen</button>
    </div>

    <p class="muted" style="margin-top:10px;">
      Tipp: Die Suche findet W/O, T/C, P/N und Stichwörter aus dem Text.
    </p>
  `;

  $("#cancelBtn").onclick = () => render();

  $("#saveBtn").onclick = async () => {
    const job = {
      id: existing?.id || uuid(),
      date: $("#date").value || todayISO(),
      wo: ($("#wo").value || "").trim(),
      tc: ($("#tc").value || "").trim(),
      pn: ($("#pn").value || "").trim(),
      text: ($("#text").value || "").trim(),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    // Minimal-Validierung: mind. ein Feld außer Datum
    if (!job.wo && !job.tc && !job.pn && !job.text) {
      setStatus("Bitte mindestens ein Feld ausfüllen.");
      return;
    }

    job.search = makeSearchString(job);
    await putJob(job);

    setStatus(isEdit ? "Gespeichert." : "Angelegt.");
    currentTab = "today";
    render();
  };
}

// ---------- Navigation ----------
document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => {
    currentTab = btn.getAttribute("data-tab");
    render();
  };
});

$("#addBtn").onclick = () => renderForm(null);

// ---------- Init ----------
(async function init() {
  db = await openDB();
  render();
})();
