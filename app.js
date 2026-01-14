/* =========================================================
   WORKLOG / OJT TRACKER
   Clean • Stable • Offline • PWA-safe
   ========================================================= */

/* -------------------- Service Worker -------------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* -------------------- IndexedDB -------------------- */
const DB_NAME = "worklog_db";
const DB_VERSION = 1;
const JOBS = "jobs";
const TODOS = "todos";

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(JOBS))
        d.createObjectStore(JOBS, { keyPath: "id" });
      if (!d.objectStoreNames.contains(TODOS))
        d.createObjectStore(TODOS, { keyPath: "id" });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

const getAll = (name) =>
  new Promise((res) => {
    const r = store(name).getAll();
    r.onsuccess = () => res(r.result || []);
  });

const put = (name, obj) =>
  new Promise((res) => {
    const r = store(name, "readwrite").put(obj);
    r.onsuccess = () => res();
  });

/* -------------------- Helpers -------------------- */
const $ = (q) => document.querySelector(q);
const view = $("#view");

const todayISO = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();

/* -------------------- Similarity -------------------- */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/* -------------------- Matching Logic (SINGLE SOURCE) -------------------- */
/*
RULE:
- If Job has P/N:
    → P/N must match 100%
    → AND Notes similarity ≥ 96%
- If Job has NO P/N:
    → Notes similarity ≥ 96%
*/
function isMatch(todo, job) {
  if (todo.category !== job.category) return false;

  const jobPN = (job.pn || "").trim();
  const todoPN = (todo.pn || "").trim();
  const jobNotes = (job.notes || "").trim();
  const todoNotes = (todo.notes || "").trim();

  if (jobPN) {
    if (jobPN !== todoPN) return false;
    if (!jobNotes || !todoNotes) return false;
    return similarity(jobNotes, todoNotes) >= 0.96;
  }

  if (!jobNotes || !todoNotes) return false;
  return similarity(jobNotes, todoNotes) >= 0.96;
}

/* -------------------- Recheck (CENTRAL) -------------------- */
async function recheckAll() {
  const jobs = await getAll(JOBS);
  const todos = await getAll(TODOS);

  for (const t of todos) t.done = false;
  for (const j of jobs) j.done = false;

  for (const t of todos) {
    const hit = jobs.find((j) => isMatch(t, j));
    if (hit) {
      t.done = true;
      hit.done = true;
    }
  }

  for (const j of jobs) await put(JOBS, j);
  for (const t of todos) await put(TODOS, t);
}

/* -------------------- State -------------------- */
let state = {
  view: "today", // today | month | todo | search | settings
  month: new Date().toISOString().slice(0, 7),
};

/* -------------------- Rendering -------------------- */
async function render() {
  if (state.view === "today") renderToday();
  if (state.view === "month") renderMonth();
  if (state.view === "todo") renderTodo();
  if (state.view === "settings") renderSettings();
}

async function renderToday() {
  const jobs = await getAll(JOBS);
  const today = todayISO();

  view.innerHTML = `
    <h2>Today</h2>
    <button data-action="new-job">+ New Job</button>
    ${jobs.filter(j => j.date === today).map(renderJob).join("")}
  `;
}

async function renderMonth() {
  const jobs = await getAll(JOBS);
  view.innerHTML = `
    <h2>Month</h2>
    <input type="month" value="${state.month}" data-action="pick-month">
    ${jobs.filter(j => j.date.startsWith(state.month)).map(renderJob).join("")}
  `;
}

async function renderTodo() {
  const todos = await getAll(TODOS);

  view.innerHTML = `
    <h2>ToDo / OJT</h2>
    <button data-action="new-todo">+ New ToDo</button>
    <h3>Open</h3>
    ${todos.filter(t => !t.done).map(renderTodoCard).join("") || "<p>None</p>"}
    <h3>Done</h3>
    ${todos.filter(t => t.done).map(renderTodoCard).join("") || "<p>None</p>"}
  `;
}

function renderSettings() {
  view.innerHTML = `
    <h2>Settings</h2>
    <button data-action="backup">Backup</button>
    <input type="file" id="restoreFile" hidden>
    <button data-action="restore">Restore</button>
  `;
}

/* -------------------- Cards -------------------- */
function renderJob(j) {
  return `
    <div class="card ${j.done ? "done" : ""}">
      <b>${j.category}</b> ${j.pn || ""}
      <div>${j.notes || ""}</div>
    </div>
  `;
}

function renderTodoCard(t) {
  return `
    <div class="card ${t.done ? "done" : ""}">
      <b>${t.category}</b> ${t.pn || ""}
      <div>${t.notes || ""}</div>
    </div>
  `;
}

/* -------------------- Forms -------------------- */
function jobForm() {
  view.innerHTML = `
    <h2>New Job</h2>
    <select id="jcat"><option>CLS</option><option>INT</option></select>
    <input id="jpn" placeholder="P/N">
    <textarea id="jnotes" placeholder="Notes"></textarea>
    <button data-action="save-job">Create</button>
  `;
}

function todoForm() {
  view.innerHTML = `
    <h2>New ToDo</h2>
    <select id="tcat"><option>CLS</option><option>INT</option></select>
    <input id="tpn" placeholder="P/N">
    <textarea id="tnotes" placeholder="Notes"></textarea>
    <button data-action="save-todo">Create</button>
  `;
}

/* -------------------- Backup / Restore -------------------- */
async function backup() {
  const data = {
    jobs: await getAll(JOBS),
    todos: await getAll(TODOS),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "worklog-backup.json";
  a.click();
}

async function restore(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  for (const j of data.jobs || []) await put(JOBS, j);
  for (const t of data.todos || []) await put(TODOS, t);

  await recheckAll();
  render();
}

/* -------------------- Global Click Handler -------------------- */
document.addEventListener("click", async (e) => {
  const a = e.target.dataset.action;
  if (!a) return;

  if (a === "new-job") jobForm();
  if (a === "new-todo") todoForm();

  if (a === "save-job") {
    const job = {
      id: uid(),
      category: $("#jcat").value,
      pn: $("#jpn").value,
      notes: $("#jnotes").value,
      date: todayISO(),
      done: false,
    };
    await put(JOBS, job);
    await recheckAll();
    state.view = "today";
    render();
  }

  if (a === "save-todo") {
    const todo = {
      id: uid(),
      category: $("#tcat").value,
      pn: $("#tpn").value,
      notes: $("#tnotes").value,
      done: false,
    };
    await put(TODOS, todo);
    await recheckAll();
    state.view = "todo";
    render();
  }

  if (a === "backup") backup();
  if (a === "restore") $("#restoreFile").click();
});

document.addEventListener("change", (e) => {
  if (e.target.id === "restoreFile") restore(e.target.files[0]);
  if (e.target.dataset.action === "pick-month") {
    state.month = e.target.value;
    render();
  }
});

/* -------------------- Init -------------------- */
(async () => {
  db = await openDB();
  await recheckAll();
  render();
})();
