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

// ---------- Constants ----------
const CATEGORIES = ["CLS", "INT"];
const CAT_FILTERS = ["ALL", "CLS", "INT"];

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const statusEl = $("#status");

function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  if (msg) setTimeout(() => {
    if (statusEl.textContent === msg) statusEl.textContent = "";
  }, 1800);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function currentMonthISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`; // yyyy-mm
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function fmtMonth(ym) {
  const [y, m] = ym.split("-");
  return `${m}.${y}`;
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
  const iso = job.date || "";
  const de = iso ? fmtDate(iso) : "";
  return [iso, de, job.category, job.wo, job.tc, job.pn, job.trainer, job.text]
    .filter(Boolean).join(" ").toLowerCase();
}

function makeTodoSearch(todo) {
  return [todo.category, todo.wo, todo.tc, todo.pn, todo.text]
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

function categorySelect(id, value) {
  const v = CATEGORIES.includes(value) ? value : "CLS";
  const opts = CATEGORIES.map(c => `<option value="${c}" ${v === c ? "selected" : ""}>${c}</option>`).join("");
  return `<select id="${id}">${opts}</select>`;
}

function categoryPill(cat) {
  return cat ? `<span class="pill">CAT: ${escapeHtml(cat)}</span>` : "";
}

function applyCatFilter(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter(x => (x.category || "CLS") === filter);
}

function renderCatToggle(current, prefix) {
  const btn = (val, label) => `
    <button class="btn ${current === val ? "primary" : ""}" id="${prefix}_${val}">${label}</button>
  `;
  return `
    <div class="card">
      <strong style="color:var(--text-strong)">Filter</strong>
      <div class="row" style="margin-top:10px;">
        ${btn("ALL", "ALL")}
        ${btn("CLS", "CLS")}
        ${btn("INT", "INT")}
      </div>
    </div>
  `;
}

function bindCatToggle(prefix, onChange) {
  for (const f of CAT_FILTERS) {
    const el = $(`#${prefix}_${f}`);
    if (el) el.onclick = () => onChange(f);
  }
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
  // category must match
  if (todo.category && job.category && todo.category !== job.category) return false;

  const jobWO = normalize(job.wo);
  const jobTC = normalize(job.tc);
  const jobPN = normalize(job.pn);
  const jobAll = normalize(job.search || "");

  const tWO = normalize(todo.wo);
  const tTC = normalize(todo.tc);
  const tPN = normalize(todo.pn);
  const tText = normalize(todo.text);
  const todoAll = normalize(todo.search || "");

  if (tWO && jobWO && !jobWO.includes(tWO)) return false;
  if (tTC && jobTC && !jobTC.includes(tTC)) return false;
  if (tPN && jobPN && !jobPN.includes(tPN)) return false;
  if (tText && !jobAll.includes(tText)) return false;

  if (!tWO && !tTC && !tPN && !tText) return false;

  if (todoAll && jobAll.includes(todoAll)) return true;
  return true;
}

async function applyTodoMatchingForJob(job) {
  const todos = await getAllTodos();
  const openTodos = todos.filter(t => !t.done);
  const matched = openTodos.filter(t => todoMatchesJob(t, job));

  if (!matched.length) {
    if (job.todoMatched) {
      job.todoMatched = false;
      job.matchedTodoIds = [];
      job.search = makeJobSearch(job);
      await putJob(job);
    }
    return;
  }

  job.todoMatched = true;
  job.matchedTodoIds = matched.map(t => t.id);
  job.search = makeJobSearch(job);
  await putJob(job);

  const now = Date.now();
  for (const t of matched) {
    t.done = true;
    t.doneAt = now;
    t.matchedJobId = job.id;
    await putTodo(t);
  }
}

// ---------- UI state ----------
let currentTab = "today";
let dateMode = "day"; // day | month
let jobsCatFilter = "ALL";
let todoCatFilter = "ALL";

// ---------- UI building ----------
function cardJob(job, showDate = false) {
  const matchClass = job.todoMatched ? "card match" : "card";
  return `
    <div class="${matchClass}">
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <div>
          ${showDate ? `<div class="muted">${fmtDate(job.date)}</div>` : ``}
          <div>
            ${job.todoMatched ? `<span class="pill done">OJT MATCH</span>` : ``}
            ${categoryPill(job.category)}
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

function todoCard(todo) {
  const doneBadge = todo.done ? `<span class="pill done">DONE</span>` : `<span class="pill">OPEN</span>`;
  const text = todo.text ? escapeHtml(todo.text) : `<span class="muted">(no keywords)</span>`;
  return `
    <div class="card ${todo.done ? "match" : ""}">
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <div>
          <div>
            ${doneBadge}
            ${todo.category ? `<span class="pill">CAT: ${escapeHtml(todo.category)}</span>` : ``}
          </div>
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

// ---------- Tabs ----------
async function render() {
  if (currentTab === "today") return renderToday();
  if (currentTab === "days") return renderDays();
  if (currentTab === "bydate") return renderByDate();
  if (currentTab === "search") return renderSearch();
  if (currentTab === "todo") return renderTodo();
}

async function renderToday() {
  const jobs = await getAllJobs();
  const t = todayISO();
  const todaysAll = jobs.filter(j => (j.date === t));

  // normalize old data: default category CLS if missing
  for (const j of todaysAll) if (!j.category) j.category = "CLS";

  const todays = applyCatFilter(todaysAll, jobsCatFilter).sort((a, b) => b.createdAt - a.createdAt);

  view.innerHTML = `
    <h2>Today (${fmtDate(t)})</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_today")}
    ${todays.length ? todays.map(j => cardJob(j)).join("") : `<p class="muted">No entries for this filter.</p>`}
  `;

  bindCatToggle("jobfilter_today", (f) => { jobsCatFilter = f; renderToday(); });
  bindJobActions();
}

async function renderDays() {
  const jobs = await getAllJobs();
  for (const j of jobs) if (!j.category) j.category = "CLS";
  const filtered = applyCatFilter(jobs, jobsCatFilter);
  const grouped = groupByDate(filtered);

  view.innerHTML = `
    <h2>All Days</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_days")}
    ${grouped.length ? grouped.map(g => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:var(--text-strong)">${fmtDate(g.date)}</strong>
          <span class="muted">${g.items.length} job${g.items.length === 1 ? "" : "s"}</span>
        </div>
        <hr>
        ${g.items.map(j => cardJob(j)).join("")}
      </div>
    `).join("") : `<p class="muted">No entries for this filter.</p>`}
  `;

  bindCatToggle("jobfilter_days", (f) => { jobsCatFilter = f; renderDays(); });
  bindJobActions();
}

async function renderByDate() {
  const jobs = await getAllJobs();
  for (const j of jobs) if (!j.category) j.category = "CLS";

  const defaultDay = todayISO();
  const defaultMonth = currentMonthISO();

  view.innerHTML = `
    <h2>Date</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_date")}

    <div class="card">
      <strong style="color:var(--text-strong)">Mode</strong>
      <div class="row" style="margin-top:10px;">
        <button class="btn ${dateMode === "day" ? "primary" : ""}" id="modeDayBtn">Day</button>
        <button class="btn ${dateMode === "month" ? "primary" : ""}" id="modeMonthBtn">Month</button>
      </div>

      <div id="dayWrap" style="margin-top:12px; ${dateMode === "day" ? "" : "display:none;"}">
        <label>Select day</label>
        <input type="date" id="pickDay" value="${defaultDay}" />
      </div>

      <div id="monthWrap" style="margin-top:12px; ${dateMode === "month" ? "" : "display:none;"}">
        <label>Select month</label>
        <input type="month" id="pickMonth" value="${defaultMonth}" />
      </div>
    </div>

    <div id="dateResults" style="margin-top:12px;"></div>
  `;

  bindCatToggle("jobfilter_date", (f) => { jobsCatFilter = f; renderByDate(); });

  const results = $("#dateResults");

  function showForDay(dayIso) {
    const listAll = jobs.filter(j => j.date === dayIso);
    const list = applyCatFilter(listAll, jobsCatFilter).sort((a, b) => b.createdAt - a.createdAt);

    results.innerHTML = list.length
      ? list.map(j => cardJob(j)).join("")
      : `<p class="muted">No entries for this day + filter.</p>`;
    bindJobActions();
  }

  function showForMonth(ym) {
    const listAll = jobs.filter(j => (j.date || "").startsWith(ym + "-"));
    const list = applyCatFilter(listAll, jobsCatFilter).sort((a, b) =>
      (b.date || "").localeCompare(a.date || "") || (b.createdAt - a.createdAt)
    );

    results.innerHTML = list.length
      ? `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="color:var(--text-strong)">Month: ${fmtMonth(ym)}</strong>
            <span class="muted">${list.length} job${list.length === 1 ? "" : "s"}</span>
          </div>
          <hr>
          ${list.map(j => cardJob(j, true)).join("")}
        </div>
      `
      : `<p class="muted">No entries for this month + filter.</p>`;
    bindJobActions();
  }

  $("#modeDayBtn").onclick = () => { dateMode = "day"; renderByDate(); };
  $("#modeMonthBtn").onclick = () => { dateMode = "month"; renderByDate(); };

  const dayInput = $("#pickDay");
  const monthInput = $("#pickMonth");

  if (dayInput) dayInput.addEventListener("change", () => showForDay(dayInput.value));
  if (monthInput) monthInput.addEventListener("change", () => showForMonth(monthInput.value));

  if (dateMode === "day") showForDay(defaultDay);
  else showForMonth(defaultMonth);
}

async function renderSearch() {
  const jobs = await getAllJobs();
  for (const j of jobs) if (!j.category) j.category = "CLS";

  view.innerHTML = `
    <h2>Search</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_search")}
    <input id="q" placeholder="Search CLS/INT, W/O, T/C, P/N, Trainer, Notes, or Date …" />
    <div id="results" style="margin-top:10px;"></div>
  `;

  bindCatToggle("jobfilter_search", (f) => { jobsCatFilter = f; renderSearch(); });

  const input = $("#q");
  const results = $("#results");

  function doSearch() {
    const q = normalize(input.value);
    if (!q) {
      results.innerHTML = `<p class="muted">Type to search.</p>`;
      return;
    }

    const hitsAll = jobs.filter(j => (j.search || "").includes(q));
    const hits = applyCatFilter(hitsAll, jobsCatFilter).sort((a, b) => b.createdAt - a.createdAt);

    results.innerHTML = hits.length
      ? hits.map(j => cardJob(j, true)).join("")
      : `<p class="muted">No results for this filter.</p>`;
    bindJobActions();
  }

  input.addEventListener("input", doSearch);
  doSearch();
}

async function renderTodo() {
  const todos = await getAllTodos();
  for (const t of todos) if (!t.category) t.category = "CLS";

  const openAll = todos.filter(t => !t.done);
  const doneAll = todos.filter(t => t.done);

  // per-category "all done" banners
  const banners = [];
  for (const cat of CATEGORIES) {
    const total = todos.filter(t => t.category === cat).length;
    const open = openAll.filter(t => t.category === cat).length;
    if (total > 0 && open === 0) {
      banners.push(`
        <div class="card match">
          <strong style="color:var(--text-strong)">All ${cat} OJT done ✅</strong>
          <div class="muted" style="margin-top:6px;">No open ${cat} ToDos remaining.</div>
        </div>
      `);
    }
  }

  const open = applyCatFilter(openAll, todoCatFilter).sort((a, b) => b.createdAt - a.createdAt);
  const done = applyCatFilter(doneAll, todoCatFilter).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  // default category in Add-ToDo follows current filter if CLS/INT, else CLS
  const defaultCat = (todoCatFilter === "CLS" || todoCatFilter === "INT") ? todoCatFilter : "CLS";

  view.innerHTML = `
    <h2>ToDo / OJT List</h2>

    ${renderCatToggle(todoCatFilter, "todofilter")}
    ${banners.join("")}

    <div class="card">
      <strong style="color:var(--text-strong)">Add ToDo</strong>

      <label>Category (required)</label>
      ${categorySelect("t_cat", defaultCat)}

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
      </div>

      <p class="smallnote" style="margin-top:10px;">
        Auto match: When you save a job, the app checks OPEN ToDos with the same category (CLS/INT).
        If it matches (even partially), the job turns green and the ToDo becomes DONE.
      </p>
    </div>

    <h2>Open</h2>
    ${open.length ? open.map(todoCard).join("") : `<p class="muted">No open ToDos for this filter.</p>`}

    <h2>Done</h2>
    ${done.length ? done.map(todoCard).join("") : `<p class="muted">No done ToDos for this filter.</p>`}
  `;

  bindCatToggle("todofilter", (f) => { todoCatFilter = f; renderTodo(); });

  $("#addTodoBtn").onclick = async () => {
    const todo = {
      id: uuid(),
      category: ($("#t_cat").value || "CLS").trim(),
      wo: ($("#t_wo").value || "").trim(),
      tc: ($("#t_tc").value || "").trim(),
      pn: ($("#t_pn").value || "").trim(),
      text: ($("#t_text").value || "").trim(),
      done: false,
      createdAt: Date.now(),
      doneAt: null,
      matchedJobId: null
    };

    if (!CATEGORIES.includes(todo.category)) {
      setStatus("Please select a category.");
      return;
    }

    if (!todo.wo && !todo.tc && !todo.pn && !todo.text) {
      setStatus("Please fill at least one field.");
      return;
    }

    todo.search = makeTodoSearch(todo);
    await putTodo(todo);
    setStatus("ToDo added.");
    renderTodo();
  };

  bindTodoActions();
}

// ---------- Job form ----------
function renderForm(existing = null) {
  const isEdit = !!existing;
  const d = existing?.date || todayISO();
  const cat = existing?.category && CATEGORIES.includes(existing.category) ? existing.category : "CLS";

  view.innerHTML = `
    <h2>${isEdit ? "Edit Job" : "New Job"}</h2>

    <label>Category (required)</label>
    ${categorySelect("category", cat)}

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
  `;

  $("#cancelBtn").onclick = () => render();

  $("#saveBtn").onclick = async () => {
    const category = ($("#category").value || "").trim();
    if (!CATEGORIES.includes(category)) {
      setStatus("Please select a category.");
      return;
    }

    const job = {
      id: existing?.id || uuid(),
      category,
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
    await applyTodoMatchingForJob(job);

    setStatus(isEdit ? "Saved." : "Created.");
    currentTab = "today";
    render();
  };
}

// ---------- Backup / Restore / Import ----------
async function backupToFile() {
  const jobs = await getAllJobs();
  const todos = await getAllTodos();
  const payload = { version: 1, exportedAt: new Date().toISOString(), jobs, todos };

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
  try { data = JSON.parse(text); } catch { alert("Invalid backup file."); return; }
  if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.todos)) {
    alert("Backup format not recognized.");
    return;
  }
  if (!confirm("Restore will REPLACE current data. Continue?")) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([JOBS, TODOS], "readwrite");
    tx.objectStore(JOBS).clear();
    tx.objectStore(TODOS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  for (const j of data.jobs) {
    if (!j.category) j.category = "CLS";
    j.search = makeJobSearch(j);
    await putJob(j);
  }
  for (const t of data.todos) {
    if (!t.category) t.category = "CLS";
    t.search = makeTodoSearch(t);
    await putTodo(t);
  }

  setStatus("Restore complete.");
  currentTab = "today";
  render();
}

function parseCsvTodos(csvText) {
  // CSV columns:
  // category,wo,tc,pn,text
  // If first column is not CLS/INT -> old format wo,tc,pn,text (defaults category CLS)
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = normalize(lines[0]);
  const hasHeader = first.includes("wo") && first.includes("tc");
  const start = hasHeader ? 1 : 0;

  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    const maybeCat = (cols[0] || "").toUpperCase();

    if (maybeCat === "CLS" || maybeCat === "INT") {
      out.push({
        category: maybeCat,
        wo: cols[1] || "",
        tc: cols[2] || "",
        pn: cols[3] || "",
        text: cols.slice(4).join(",") || ""
      });
    } else {
      out.push({
        category: "CLS",
        wo: cols[0] || "",
        tc: cols[1] || "",
        pn: cols[2] || "",
        text: cols.slice(3).join(",") || ""
      });
    }
  }
  return out;
}

async function importTodos(items) {
  const existing = await getAllTodos();
  const existingKeys = new Set(existing.map(t => normalize(t.search || "")));
  const now = Date.now();
  let added = 0;

  for (const x of items) {
    const todo = {
      id: uuid(),
      category: (x.category || x.cat || "CLS").trim().toUpperCase(),
      wo: (x.wo || "").trim(),
      tc: (x.tc || "").trim(),
      pn: (x.pn || "").trim(),
      text: (x.text || "").trim(),
      done: false,
      createdAt: now,
      doneAt: null,
      matchedJobId: null
    };

    if (!CATEGORIES.includes(todo.category)) continue;
    if (!todo.wo && !todo.tc && !todo.pn && !todo.text) continue;

    todo.search = makeTodoSearch(todo);
    const key = normalize(todo.search);
    if (key && existingKeys.has(key)) continue;
    existingKeys.add(key);

    await putTodo(todo);
    added++;
  }
  return added;
}

// ---------- Navigation (bottom tabs + top buttons) ----------
document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => {
    currentTab = btn.getAttribute("data-tab");
    render();
  };
});

if ($("#addBtn")) $("#addBtn").onclick = () => renderForm(null);

if ($("#backupBtn")) $("#backupBtn").onclick = () => backupToFile();

if ($("#restoreBtn")) $("#restoreBtn").onclick = () => {
  $("#restoreInput").value = "";
  $("#restoreInput").click();
};

if ($("#restoreInput")) $("#restoreInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  await restoreFromJsonText(text);
});

if ($("#importTodoBtn")) $("#importTodoBtn").onclick = () => {
  $("#importTodoInput").value = "";
  $("#importTodoInput").click();
};

if ($("#importTodoInput")) $("#importTodoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const text = await file.text();
  let items = [];

  if (file.type === "text/csv" || file.name.toLowerCase().endsWith(".csv")) {
    items = parseCsvTodos(text);
  } else {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
      else if (parsed && Array.isArray(parsed.todos)) items = parsed.todos;
      else throw new Error("bad");
    } catch {
      alert("Invalid ToDo file. Use JSON array or CSV.");
      return;
    }
  }

  const added = await importTodos(items);
  setStatus(`Imported ToDos: ${added}`);
  currentTab = "todo";
  render();
});

// ---------- Init ----------
(async function init() {
  db = await openDB();
  render();
})();
