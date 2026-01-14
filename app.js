// ---------- PWA / Service Worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
  });
}

// ---------- IndexedDB ----------
const DB_NAME = "worklog_db";
const JOBS = "jobs";
const TODOS = "todos";
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    // v2 introduces "todos" store (keeps existing jobs)
    const req = indexedDB.open(DB_NAME, 2);

    req.onupgradeneeded = () => {
      const d = req.result;

      if (!d.objectStoreNames.contains(JOBS)) {
        const s = d.createObjectStore(JOBS, { keyPath: "id" });
        s.createIndex("date", "date");
        s.createIndex("createdAt", "createdAt");
        s.createIndex("search", "search");
      }

      if (!d.objectStoreNames.contains(TODOS)) {
        const t = d.createObjectStore(TODOS, { keyPath: "id" });
        t.createIndex("createdAt", "createdAt");
        t.createIndex("done", "done");
        t.createIndex("search", "search");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
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
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function uuid() {
  return (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function normalize(s = "") {
  return String(s).trim().toLowerCase();
}

function makeJobSearch(job) {
  // Include ISO date + EU date + all fields (incl. trainer)
  const iso = job.date || "";
  const de = iso ? fmtDate(iso) : "";
  return [iso, de, job.wo, job.tc, job.pn, job.trainer, job.text]
    .filter(Boolean).join(" ").toLowerCase();
}

function makeTodoSearch(todo) {
  return [todo.wo, todo.tc, todo.pn, todo.text]
    .filter(Boolean).join(" ").toLowerCase();
}

function groupByDate(jobs) {
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.date)) map.set(j.date, []);
    map.get(j.date).push(j);
  }
  const dates = [...map.keys()].sort((a, b) => b.localeCompare(a));
  return dates.map(date => ({
    date,
    items: map.get(date).sort((a, b) => b.createdAt - a.createdAt)
  }));
}

// ---------- Data access ----------
function getAllJobs() {
  return new Promise((resolve, reject) => {
    const req = store(JOBS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putJob(job) {
  return new Promise((resolve, reject) => {
    const req = store(JOBS, "readwrite").put(job);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteJob(id) {
  return new Promise((resolve, reject) => {
    const req = store(JOBS, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getAllTodos() {
  return new Promise((resolve, reject) => {
    const req = store(TODOS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putTodo(todo) {
  return new Promise((resolve, reject) => {
    const req = store(TODOS, "readwrite").put(todo);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteTodo(id) {
  return new Promise((resolve, reject) => {
    const req = store(TODOS, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- ToDo matching ----------
function todoMatchesJob(todo, job) {
  // Partial match logic:
  // - compare each field if todo has it
  // - and also allow free-text matching by substring on combined search strings
  const jobWO = normalize(job.wo);
  const jobTC = normalize(job.tc);
  const jobPN = normalize(job.pn);
  const jobText = normalize(job.text);
  const jobAll = normalize(job.search || "");

  const tWO = normalize(todo.wo);
  const tTC = normalize(todo.tc);
  const tPN = normalize(todo.pn);
  const tText = normalize(todo.text);
  const todoAll = normalize(todo.search || "");

  // Field-specific checks (only if todo has that field)
  if (tWO && jobWO && !jobWO.includes(tWO)) return false;
  if (tTC && jobTC && !jobTC.includes(tTC)) return false;
  if (tPN && jobPN && !jobPN.includes(tPN)) return false;

  // If todo has free-text, require it somewhere in jobAll
  if (tText && !jobAll.includes(tText)) return false;

  // If todo has no fields at all, it shouldn't match anything
  if (!tWO && !tTC && !tPN && !tText) return false;

  // Extra: if todoAll exists, allow match if jobAll contains todoAll (useful for single keyword todos)
  if (todoAll && jobAll.includes(todoAll)) return true;

  // If we got here, it's a valid match based on fields above
  return true;
}

async function applyTodoMatchingForJob(job) {
  const todos = await getAllTodos();
  const openTodos = todos.filter(t => !t.done);

  const matched = openTodos.filter(t => todoMatchesJob(t, job));

  if (!matched.length) {
    // remove match marker if previously set
    if (job.todoMatched) {
      job.todoMatched = false;
      job.matchedTodoIds = [];
      job.search = makeJobSearch(job);
      await putJob(job);
    }
    return;
  }

  // mark job as matched
  job.todoMatched = true;
  job.matchedTodoIds = matched.map(t => t.id);
  job.search = makeJobSearch(job);
  await putJob(job);

  // mark todos done (optional: you can change to "not auto-done", but you asked for auto recognition)
  const now = Date.now();
  for (const t of matched) {
    t.done = true;
    t.doneAt = now;
    t.matchedJobId = job.id;
    await putTodo(t);
  }
}

// ---------- UI rendering ----------
let currentTab = "today";

async function render() {
  if (currentTab === "today") return renderToday();
  if (currentTab === "days") return renderDays();
  if (currentTab === "bydate") return renderByDate();
  if (currentTab === "search") return renderSearch();
  if (currentTab === "todo") return renderTodo();
}

function cardJob(job, showDate = false) {
  const matchClass = job.todoMatched ? "card match" : "card";
  return `
    <div class="${matchClass}">
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <div>
          ${showDate ? `<div class="muted">${fmtDate(job.date)}</div>` : ``}
          <div>
            ${job.todoMatched ? `<span class="pill done">OJT MATCH</span>` : ``}
            ${job.wo ? `<span class="pill">W/O: ${escapeHtml(job.wo)}</span>` : ``}
            ${job.tc ? `<span class="pill">T/C: ${escapeHtml(job.tc)}</span>` : ``}
            ${job.pn ? `<span class="pill">P/N: ${escapeHtml(job.pn)}</span>` : ``}
            ${job.trainer ? `<span class="pill">Trainer: ${escapeHtml(job.trainer)}</span>` : ``}
          </div>
          ${job.text
            ? `<div style="margin-top:8px;">${escapeHtml(job.text).replace(/\n/g, "<br>")}</div>`
            : `<div class="muted" style="margin-top:8px;">(no notes)</div>`}
        </div>
        <div class="actions">
          <button class="btn" data-edit="${job.id}">Edit</button>
          <button class="btn danger" data-del="${job.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function bindJobActions() {
  document.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-del");
      if (confirm("Delete this entry?")) {
        await deleteJob(id);
        setStatus("Deleted.");
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
  const todays = jobs.filter(j => j.date === t).sort((a, b) => b.createdAt - a.createdAt);

  view.innerHTML = `
    <h2>Today (${fmtDate(t)})</h2>
    ${todays.length ? todays.map(cardJob).join("") : `<p class="muted">No entries for today yet.</p>`}
  `;
  bindJobActions();
}

async function renderDays() {
  const jobs = await getAllJobs();
  const grouped = groupByDate(jobs);

  view.innerHTML = `
    <h2>All Days</h2>
    ${grouped.length ? grouped.map(g => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:var(--text-strong)">${fmtDate(g.date)}</strong>
          <span class="muted">${g.items.length} job${g.items.length === 1 ? "" : "s"}</span>
        </div>
        <hr>
        ${g.items.map(j => cardJob(j)).join("")}
      </div>
    `).join("") : `<p class="muted">No entries yet.</p>`}
  `;
  bindJobActions();
}

async function renderByDate() {
  const jobs = await getAllJobs();
  const defaultDate = todayISO();

  view.innerHTML = `
    <h2>Select Date</h2>
    <input type="date" id="pickDate" value="${defaultDate}" />
    <div id="dateResults" style="margin-top:12px;"></div>
  `;

  const picker = $("#pickDate");
  const results = $("#dateResults");

  function showForDate(date) {
    const list = jobs.filter(j => j.date === date).sort((a, b) => b.createdAt - a.createdAt);
    results.innerHTML = list.length ? list.map(j => cardJob(j)).join("") : `<p class="muted">No entries for this date.</p>`;
    bindJobActions();
  }

  picker.addEventListener("change", () => showForDate(picker.value));
  showForDate(picker.value);
}

async function renderSearch() {
  view.innerHTML = `
    <h2>Search</h2>
    <input id="q" placeholder="Search W/O, T/C, P/N, Trainer, Notes, or Date (e.g. 2026-01-15 or 15.01.2026) …" />
    <div id="results" style="margin-top:10px;"></div>
  `;

  const input = $("#q");
  const results = $("#results");
  let jobs = await getAllJobs();

  function doSearch() {
    const q = normalize(input.value);
    if (!q) {
      results.innerHTML = `<p class="muted">Type to search.</p>`;
      return;
    }
    const hits = jobs
      .filter(j => (j.search || "").includes(q))
      .sort((a, b) => b.createdAt - a.createdAt);

    results.innerHTML = hits.length ? hits.map(j => cardJob(j, true)).join("") : `<p class="muted">No results.</p>`;
    bindJobActions();
  }

  input.addEventListener("input", doSearch);
  doSearch();
}

function todoCard(todo) {
  const doneBadge = todo.done ? `<span class="pill done">DONE</span>` : `<span class="pill">OPEN</span>`;
  const text = todo.text ? escapeHtml(todo.text) : `<span class="muted">(no keywords)</span>`;
  return `
    <div class="card ${todo.done ? "match" : ""}">
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <div>
          <div>${doneBadge}</div>
          <div style="margin-top:6px;">
            ${todo.wo ? `<span class="pill">W/O: ${escapeHtml(todo.wo)}</span>` : ``}
            ${todo.tc ? `<span class="pill">T/C: ${escapeHtml(todo.tc)}</span>` : ``}
            ${todo.pn ? `<span class="pill">P/N: ${escapeHtml(todo.pn)}</span>` : ``}
          </div>
          <div style="margin-top:8px;">${text}</div>
          ${todo.doneAt ? `<div class="muted" style="margin-top:8px;">Done at: ${new Date(todo.doneAt).toLocaleString()}</div>` : ``}
        </div>
        <div class="actions">
          ${!todo.done ? `<button class="btn" data-tododone="${todo.id}">Mark Done</button>` : ``}
          <button class="btn danger" data-tododel="${todo.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function bindTodoActions() {
  document.querySelectorAll("[data-tododel]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-tododel");
      if (confirm("Delete this ToDo?")) {
        await deleteTodo(id);
        setStatus("Deleted.");
        render();
      }
    };
  });

  document.querySelectorAll("[data-tododone]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-tododone");
      const todos = await getAllTodos();
      const t = todos.find(x => x.id === id);
      if (!t) return;
      t.done = true;
      t.doneAt = Date.now();
      await putTodo(t);
      setStatus("Marked done.");
      render();
    };
  });
}

async function renderTodo() {
  const todos = await getAllTodos();
  const open = todos.filter(t => !t.done).sort((a, b) => b.createdAt - a.createdAt);
  const done = todos.filter(t => t.done).sort((a, b) => b.doneAt - a.doneAt);

  view.innerHTML = `
    <h2>ToDo / OJT List</h2>

    <div class="card">
      <strong style="color:var(--text-strong)">Add ToDo</strong>
      <div class="row" style="margin-top:10px;">
        <div>
          <label>W/O (optional)</label>
          <input id="t_wo" placeholder="e.g. 123456" />
        </div>
        <div>
          <label>T/C (optional)</label>
          <input id="t_tc" placeholder="e.g. ABC-01" />
        </div>
      </div>
      <label>P/N (optional)</label>
      <input id="t_pn" placeholder="e.g. 98-7654-321" />

      <label>Keywords / Notes (optional)</label>
      <input id="t_text" placeholder="e.g. hydraulic leak / safety wire / inspection" />

      <div class="row" style="margin-top:12px;">
        <button class="btn primary" id="addTodoBtn">Add ToDo</button>
        <button class="btn" id="loadSampleBtn">Load sample list</button>
      </div>

      <p class="smallnote" style="margin-top:10px;">
        Auto match: When you save a job, the app checks open ToDos. If it matches (even partially), the job turns green and the ToDo becomes DONE.
      </p>
    </div>

    <h2>Open</h2>
    ${open.length ? open.map(todoCard).join("") : `<p class="muted">No open ToDos.</p>`}

    <h2>Done</h2>
    ${done.length ? done.map(todoCard).join("") : `<p class="muted">No done ToDos yet.</p>`}
  `;

  $("#addTodoBtn").onclick = async () => {
    const todo = {
      id: uuid(),
      wo: ($("#t_wo").value || "").trim(),
      tc: ($("#t_tc").value || "").trim(),
      pn: ($("#t_pn").value || "").trim(),
      text: ($("#t_text").value || "").trim(),
      done: false,
      createdAt: Date.now(),
      doneAt: null,
      matchedJobId: null
    };
    if (!todo.wo && !todo.tc && !todo.pn && !todo.text) {
      setStatus("Please fill at least one field.");
      return;
    }
    todo.search = makeTodoSearch(todo);
    await putTodo(todo);
    setStatus("ToDo added.");
    render();
  };

  $("#loadSampleBtn").onclick = async () => {
    const sample = [
      { wo: "OJT", tc: "INSPECTION", pn: "", text: "perform inspection and document findings" },
      { wo: "", tc: "TROUBLESHOOT", pn: "", text: "troubleshooting procedure" },
      { wo: "", tc: "", pn: "P/N", text: "replace part and log serial/batch" }
    ].map(x => ({
      id: uuid(),
      wo: x.wo, tc: x.tc, pn: x.pn, text: x.text,
      done: false,
      createdAt: Date.now(),
      doneAt: null,
      matchedJobId: null,
      search: makeTodoSearch(x)
    }));

    // Insert only if user confirms (avoid duplicates)
    if (!confirm("Load sample ToDo list?")) return;

    for (const t of sample) {
      t.search = makeTodoSearch(t);
      await putTodo(t);
    }
    setStatus("Sample list loaded.");
    render();
  };

  bindTodoActions();
}

// ---------- Form (New/Edit Job) ----------
function renderForm(existing = null) {
  const isEdit = !!existing;
  const d = existing?.date || todayISO();

  view.innerHTML = `
    <h2>${isEdit ? "Edit Job" : "New Job"}</h2>

    <label>Date</label>
    <input id="date" type="date" value="${escapeHtml(d)}" />

    <div class="row">
      <div>
        <label>W/O</label>
        <input id="wo" placeholder="e.g. 123456" value="${escapeHtml(existing?.wo || "")}" />
      </div>
      <div>
        <label>T/C</label>
        <input id="tc" placeholder="e.g. ABC-01" value="${escapeHtml(existing?.tc || "")}" />
      </div>
    </div>

    <label>P/N</label>
    <input id="pn" placeholder="e.g. 98-7654-321" value="${escapeHtml(existing?.pn || "")}" />

    <label>Trainer</label>
    <input id="trainer" placeholder="e.g. John Smith" value="${escapeHtml(existing?.trainer || "")}" />

    <label>Work performed (Notes)</label>
    <textarea id="text" placeholder="Short and clear: what did you do?">${escapeHtml(existing?.text || "")}</textarea>

    <div class="row" style="margin-top:12px;">
      <button id="saveBtn" class="btn primary">${isEdit ? "Save" : "Create"}</button>
      <button id="cancelBtn" class="btn">Cancel</button>
    </div>

    <p class="muted" style="margin-top:10px;">
      Tip: Search includes date, W/O, T/C, P/N, Trainer and Notes. Auto ToDo match turns the job green.
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
      trainer: ($("#trainer").value || "").trim(),
      text: ($("#text").value || "").trim(),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      todoMatched: existing?.todoMatched || false,
      matchedTodoIds: existing?.matchedTodoIds || []
    };

    if (!job.wo && !job.tc && !job.pn && !job.trainer && !job.text) {
      setStatus("Please fill at least one field.");
      return;
    }

    job.search = makeJobSearch(job);
    await putJob(job);

    // Apply ToDo matching AFTER saving
    await applyTodoMatchingForJob(job);

    setStatus(isEdit ? "Saved." : "Created.");
    currentTab = "today";
    render();
  };
}

// ---------- Backup / Restore ----------
async function backupToFile() {
  const jobs = await getAllJobs();
  const todos = await getAllTodos();

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    jobs,
    todos
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `worklog-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("Backup file created.");
}

async function restoreFromJsonText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    alert("Invalid backup file.");
    return;
  }

  if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.todos)) {
    alert("Backup format not recognized.");
    return;
  }

  if (!confirm("Restore will REPLACE current data. Continue?")) return;

  // Clear stores, then insert
  await new Promise((resolve, reject) => {
    const tx = db.transaction([JOBS, TODOS], "readwrite");
    tx.objectStore(JOBS).clear();
    tx.objectStore(TODOS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  for (const j of data.jobs) {
    // Rebuild search to ensure compatibility
    j.search = makeJobSearch(j);
    await putJob(j);
  }
  for (const t of data.todos) {
    t.search = makeTodoSearch(t);
    await putTodo(t);
  }

  setStatus("Restore complete.");
  currentTab = "today";
  render();
}

// ---------- Navigation ----------
document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => {
    currentTab = btn.getAttribute("data-tab");
    render();
  };
});

$("#addBtn").onclick = () => renderForm(null);

// Backup/Restore buttons
$("#backupBtn").onclick = () => backupToFile();

$("#restoreBtn").onclick = () => {
  $("#restoreInput").value = "";
  $("#restoreInput").click();
};

$("#restoreInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  await restoreFromJsonText(text);
});

// ---------- Init ----------
(async function init() {
  db = await openDB();
  render();
})();
