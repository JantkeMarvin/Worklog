/* =========================================================
   WORKLOG / OJT TRACKER (Stable)
   - Offline (IndexedDB)
   - Simple Views: Today / Month / ToDo / Settings
   - Header Buttons always work: + New Job / + New ToDo
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
      if (!d.objectStoreNames.contains(JOBS)) {
        d.createObjectStore(JOBS, { keyPath: "id" });
      }
      if (!d.objectStoreNames.contains(TODOS)) {
        d.createObjectStore(TODOS, { keyPath: "id" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function getAll(name) {
  return new Promise((res, rej) => {
    try {
      const r = store(name).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    } catch (e) {
      rej(e);
    }
  });
}

function put(name, obj) {
  return new Promise((res, rej) => {
    try {
      const r = store(name, "readwrite").put(obj);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    } catch (e) {
      rej(e);
    }
  });
}

function del(name, id) {
  return new Promise((res, rej) => {
    try {
      const r = store(name, "readwrite").delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    } catch (e) {
      rej(e);
    }
  });
}

/* -------------------- Helpers -------------------- */
const $ = (q) => document.querySelector(q);
const view = $("#view");

const todayISO = () => new Date().toISOString().slice(0, 10);

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function safeStr(v) {
  return (v ?? "").toString().trim();
}

/* -------------------- Similarity (Notes) -------------------- */
function similarity(a, b) {
  a = safeStr(a);
  b = safeStr(b);
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

/* -------------------- Matching Rule -------------------- */
/*
RULE:
- Categories must match
- If Job has P/N:
    → P/N must match 100%
    → AND Notes similarity >= 0.96 (both notes must exist)
- If Job has NO P/N:
    → Notes similarity >= 0.96
*/
function isMatch(todo, job) {
  if (safeStr(todo.category) !== safeStr(job.category)) return false;

  const jobPN = safeStr(job.pn);
  const todoPN = safeStr(todo.pn);
  const jobNotes = safeStr(job.notes);
  const todoNotes = safeStr(todo.notes);

  if (jobPN) {
    if (jobPN !== todoPN) return false;
    if (!jobNotes || !todoNotes) return false;
    return similarity(jobNotes, todoNotes) >= 0.96;
  }

  if (!jobNotes || !todoNotes) return false;
  return similarity(jobNotes, todoNotes) >= 0.96;
}

async function recheckAll() {
  const jobs = await getAll(JOBS);
  const todos = await getAll(TODOS);

  jobs.forEach((j) => (j.done = false));
  todos.forEach((t) => (t.done = false));

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
  tab: "today",  // today | month | todo | settings
  month: new Date().toISOString().slice(0, 7),
};

/* -------------------- Rendering -------------------- */
async function render() {
  if (state.tab === "today") return renderToday();
  if (state.tab === "month") return renderMonth();
  if (state.tab === "todo") return renderTodo();
  if (state.tab === "settings") return renderSettings();
}

function renderJobCard(j) {
  return `
    <div class="card ${j.done ? "done" : ""}">
      <div><b>${safeStr(j.category)}</b> ${safeStr(j.pn)}</div>
      <div style="color:#888;margin-top:6px;white-space:pre-wrap;">${safeStr(j.notes)}</div>
      <div style="margin-top:8px;">
        <button data-action="delete-job" data-id="${j.id}">Delete</button>
      </div>
    </div>
  `;
}

function renderTodoCard(t) {
  return `
    <div class="card ${t.done ? "done" : ""}">
      <div><b>${safeStr(t.category)}</b> ${safeStr(t.pn)}</div>
      <div style="color:#888;margin-top:6px;white-space:pre-wrap;">${safeStr(t.notes)}</div>
      <div style="margin-top:8px;">
        <button data-action="delete-todo" data-id="${t.id}">Delete</button>
      </div>
    </div>
  `;
}

async function renderToday() {
  const jobs = await getAll(JOBS);
  const today = todayISO();
  const list = jobs.filter((j) => j.date === today);

  view.innerHTML = `
    <h2>Today (${today.split("-").reverse().join(".")})</h2>
    ${list.length ? list.map(renderJobCard).join("") : `<p style="color:#999;">No entries for today.</p>`}
  `;
}

async function renderMonth() {
  const jobs = await getAll(JOBS);
  const list = jobs.filter((j) => safeStr(j.date).startsWith(state.month));

  view.innerHTML = `
    <h2>Month</h2>
    <input type="month" value="${state.month}" data-action="pick-month">
    <div style="margin-top:12px;">
      ${list.length ? list.map(renderJobCard).join("") : `<p style="color:#999;">No entries in this month.</p>`}
    </div>
  `;
}

async function renderTodo() {
  const todos = await getAll(TODOS);
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  view.innerHTML = `
    <h2>ToDo / OJT</h2>

    <h3>Open</h3>
    ${open.length ? open.map(renderTodoCard).join("") : `<p style="color:#999;">None</p>`}

    <h3>Done</h3>
    ${done.length ? done.map(renderTodoCard).join("") : `<p style="color:#999;">None</p>`}
  `;
}

function renderSettings() {
  view.innerHTML = `
    <h2>Settings</h2>
    <button data-action="backup">Backup</button>
    <button data-action="restore">Restore</button>
    <button data-action="recheck">Recheck All</button>
    <input type="file" id="restoreFile" accept="application/json" hidden>
  `;
}

/* -------------------- Forms -------------------- */
function jobForm() {
  view.innerHTML = `
    <h2>New Job</h2>
    <label>Category</label>
    <select id="jcat">
      <option value="CLS">CLS</option>
      <option value="INT">INT</option>
    </select>

    <label style="display:block;margin-top:10px;">P/N</label>
    <input id="jpn" placeholder="P/N">

    <label style="display:block;margin-top:10px;">Notes</label>
    <textarea id="jnotes" placeholder="Notes"></textarea>

    <div style="margin-top:12px;display:flex;gap:10px;">
      <button data-action="save-job">Create</button>
      <button data-action="cancel">Cancel</button>
    </div>
  `;
}

function todoForm() {
  view.innerHTML = `
    <h2>New ToDo</h2>
    <label>Category</label>
    <select id="tcat">
      <option value="CLS">CLS</option>
      <option value="INT">INT</option>
    </select>

    <label style="display:block;margin-top:10px;">P/N</label>
    <input id="tpn" placeholder="P/N">

    <label style="display:block;margin-top:10px;">Notes</label>
    <textarea id="tnotes" placeholder="Notes"></textarea>

    <div style="margin-top:12px;display:flex;gap:10px;">
      <button data-action="save-todo">Create</button>
      <button data-action="cancel">Cancel</button>
    </div>
  `;
}

/* -------------------- Backup / Restore -------------------- */
async function backup() {
  const data = {
    jobs: await getAll(JOBS),
    todos: await getAll(TODOS),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "worklog-backup.json";
  a.click();
}

async function restore(file) {
  if (!file) return;
  const text = await file.text();
  const data = JSON.parse(text);

  // overwrite existing by putting same IDs; user can clear manually if needed
  for (const j of data.jobs || []) await put(JOBS, j);
  for (const t of data.todos || []) await put(TODOS, t);

  await recheckAll();
  render();
}

/* -------------------- Global Click Handler -------------------- */
document.addEventListener("click", async (e) => {
  const action = e.target?.dataset?.action;
  const tab = e.target?.dataset?.tab;

  if (tab) {
    state.tab = tab;
    render();
    return;
  }

  if (!action) return;

  if (action === "new-job") {
    jobForm();
    return;
  }

  if (action === "new-todo") {
    todoForm();
    return;
  }

  if (action === "cancel") {
    render();
    return;
  }

  if (action === "save-job") {
    const job = {
      id: uid(),
      category: safeStr($("#jcat")?.value) || "CLS",
      pn: safeStr($("#jpn")?.value),
      notes: safeStr($("#jnotes")?.value),
      date: todayISO(),
      done: false,
    };
    await put(JOBS, job);
    await recheckAll();
    state.tab = "today";
    render();
    return;
  }

  if (action === "save-todo") {
    const todo = {
      id: uid(),
      category: safeStr($("#tcat")?.value) || "CLS",
      pn: safeStr($("#tpn")?.value),
      notes: safeStr($("#tnotes")?.value),
      done: false,
    };
    await put(TODOS, todo);
    await recheckAll();
    state.tab = "todo";
    render();
    return;
  }

  if (action === "delete-job") {
    const id = e.target.dataset.id;
    if (id && confirm("Delete this job?")) {
      await del(JOBS, id);
      await recheckAll();
      render();
    }
    return;
  }

  if (action === "delete-todo") {
    const id = e.target.dataset.id;
    if (id && confirm("Delete this ToDo?")) {
      await del(TODOS, id);
      await recheckAll();
      render();
    }
    return;
  }

  if (action === "backup") {
    backup();
    return;
  }

  if (action === "restore") {
    $("#restoreFile")?.click();
    return;
  }

  if (action === "recheck") {
    await recheckAll();
    render();
    return;
  }
});

/* -------------------- Change Handler -------------------- */
document.addEventListener("change", (e) => {
  if (e.target.id === "restoreFile") {
    restore(e.target.files?.[0]);
    return;
  }
  if (e.target.dataset.action === "pick-month") {
    state.month = e.target.value;
    render();
    return;
  }
});

/* -------------------- Init -------------------- */
(async () => {
  db = await openDB();
  await recheckAll();
  render();
})();
