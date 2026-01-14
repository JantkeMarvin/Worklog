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
  }, 2000);
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
  return `${yyyy}-${mm}`;
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

function ensureCategory(x) {
  if (!x.category) x.category = "CLS";
  if (!CATEGORIES.includes(x.category)) x.category = "CLS";
  return x;
}

// ---------- Matching helpers (YOUR RULE) ----------
function normalizePNExact(s = "") {
  // P/N must match 100% -> we only standardize case + trim
  return String(s).trim().toUpperCase();
}

function normalizeNotes(s = "") {
  // Notes similarity uses ALL characters -> only trim ends
  return String(s).trim();
}

// Levenshtein distance (for similarity)
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;

  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[bl];
}

function similarityRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

const NOTES_MATCH_THRESHOLD = 0.96;

// ---------- Search helpers ----------
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
    items: map.get(date).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
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
  const btn = (val) => `
    <button class="btn ${current === val ? "primary" : ""}" id="${prefix}_${val}">${val}</button>
  `;
  return `
    <div class="card">
      <strong style="color:var(--text-strong)">Filter</strong>
      <div class="row" style="margin-top:10px;">
        ${btn("ALL")}
        ${btn("CLS")}
        ${btn("INT")}
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

// ---------- Matching logic (FINAL) ----------
// If JOB has P/N -> ONLY P/N (100% exact after trim+uppercase)
// If JOB has NO P/N -> ONLY Notes (>=96% similarity; all characters count)
function todoMatchesJob(todo, job) {
  // category must match
  if (todo.category && job.category && todo.category !== job.category) return false;

  const jobPN = normalizePNExact(job.pn || "");
  const todoPN = normalizePNExact(todo.pn || "");

  const jobNotes = normalizeNotesAllChars(job.text || "");
  const todoNotes = normalizeNotesAllChars(todo.text || "");

  // If Job has P/N -> REQUIRE: PN exact + notes similarity
  if (jobPN.length > 0) {
    if (!todoPN) return false;
    if (todoPN !== jobPN) return false;

    // notes must also be present and match >= 96%
    if (!jobNotes || !todoNotes) return false;

    const a = todoNotes.slice(0, 1500);
    const b = jobNotes.slice(0, 1500);

    if (b.includes(a)) return true;
    return similarityRatio(a, b) >= NOTES_MATCH_THRESHOLD;
  }

  // If Job has NO P/N -> match ONLY by notes >= 96%
  if (!jobNotes || !todoNotes) return false;

  const a = todoNotes.slice(0, 1500);
  const b = jobNotes.slice(0, 1500);

  if (b.includes(a)) return true;
  return similarityRatio(a, b) >= NOTES_MATCH_THRESHOLD;
}
// When saving a job: match OPEN todos
async function applyTodoMatchingForJob(job) {
  const todos = (await getAllTodos()).map(ensureCategory);
  const openTodos = todos.filter(t => !t.done);
  const matched = openTodos.filter(t => todoMatchesJob(t, job));
  if (!matched.length) return;

  job.todoMatched = true;
  job.matchedTodoIds = Array.from(new Set([...(job.matchedTodoIds || []), ...matched.map(t => t.id)]));
  job.search = makeJobSearch(job);
  await putJob(job);

  const now = Date.now();
  for (const t of matched) {
    t.done = true;
    t.doneAt = now;
    t.matchedJobId = job.id;
    t.search = makeTodoSearch(t);
    await putTodo(t);
  }
}

// When saving a todo: match existing jobs (reverse direction)
async function applyJobMatchingForTodo(todo) {
  if (todo.done) return;

  const jobs = (await getAllJobs()).map(ensureCategory);
  const candidates = jobs
    .filter(j => j.category === todo.category)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const match = candidates.find(j => todoMatchesJob(todo, j));
  if (!match) return;

  todo.done = true;
  todo.doneAt = Date.now();
  todo.matchedJobId = match.id;
  todo.search = makeTodoSearch(todo);
  await putTodo(todo);

  match.todoMatched = true;
  match.matchedTodoIds = Array.from(new Set([...(match.matchedTodoIds || []), todo.id]));
  match.search = makeJobSearch(match);
  await putJob(match);
}

// Recheck all (adds new matches; does NOT revert DONE -> OPEN)
async function recheckAll() {
  setStatus("Recheck running…");

  const jobs = (await getAllJobs()).map(ensureCategory);
  const todos = (await getAllTodos()).map(ensureCategory);

  for (const j of jobs) {
    j.search = makeJobSearch(j);
    await putJob(j);
  }
  for (const t of todos) {
    t.search = makeTodoSearch(t);
    await putTodo(t);
  }

  const openTodos = (await getAllTodos()).map(ensureCategory).filter(t => !t.done);
  for (const t of openTodos) {
    await applyJobMatchingForTodo(t);
  }

  const jobs2 = (await getAllJobs()).map(ensureCategory);
  for (const j of jobs2) {
    const remaining = (await getAllTodos()).map(ensureCategory).filter(t => !t.done);
    if (remaining.length === 0) break;
    await applyTodoMatchingForJob(j);
  }

  setStatus("Recheck done.");
  await render();
}

// ---------- UI state ----------
let currentTab = "today";
let dateMode = "day"; // day | month
let jobsCatFilter = "ALL";
let todoCatFilter = "ALL";

// ---------- UI ----------
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
      const jobs = (await getAllJobs()).map(ensureCategory);
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
            ${categoryPill(todo.category)}
          </div>
          <div style="margin-top:6px;">
            ${todo.wo ? `<span class="pill">W/O: ${escapeHtml(todo.wo)}</span>` : ``}
            ${todo.tc ? `<span class="pill">T/C: ${escapeHtml(todo.tc)}</span>` : ``}
            ${todo.pn ? `<span class="pill">P/N: ${escapeHtml(todo.pn)}</span>` : ``}
          </div>
          <div style="margin-top:8px;">${text}</div>
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
      const todos = (await getAllTodos()).map(ensureCategory);
      const t = todos.find(x => x.id === id);
      if (!t) return;
      t.done = true;
      t.doneAt = Date.now();
      t.search = makeTodoSearch(t);
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
  const jobs = (await getAllJobs()).map(ensureCategory);
  const t = todayISO();
  const todaysAll = jobs.filter(j => j.date === t);
  const todays = applyCatFilter(todaysAll, jobsCatFilter).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  view.innerHTML = `
    <h2>Today (${fmtDate(t)})</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_today")}
    ${todays.length ? todays.map(cardJob).join("") : `<p class="muted">No entries for this filter.</p>`}
  `;

  bindCatToggle("jobfilter_today", (f) => { jobsCatFilter = f; renderToday(); });
  bindJobActions();
}

async function renderDays() {
  const jobs = (await getAllJobs()).map(ensureCategory);
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
        ${g.items.map(cardJob).join("")}
      </div>
    `).join("") : `<p class="muted">No entries for this filter.</p>`}
  `;

  bindCatToggle("jobfilter_days", (f) => { jobsCatFilter = f; renderDays(); });
  bindJobActions();
}

async function renderByDate() {
  const jobs = (await getAllJobs()).map(ensureCategory);
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
    const list = applyCatFilter(listAll, jobsCatFilter).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    results.innerHTML = list.length ? list.map(cardJob).join("") : `<p class="muted">No entries for this day + filter.</p>`;
    bindJobActions();
  }

  function showForMonth(ym) {
    const listAll = jobs.filter(j => (j.date || "").startsWith(ym + "-"));
    const list = applyCatFilter(listAll, jobsCatFilter).sort((a, b) =>
      (b.date || "").localeCompare(a.date || "") || ((b.createdAt || 0) - (a.createdAt || 0))
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
  const jobs = (await getAllJobs()).map(ensureCategory);

  view.innerHTML = `
    <h2>Search</h2>
    ${renderCatToggle(jobsCatFilter, "jobfilter_search")}
    <input id="q" placeholder="Search W/O, T/C, P/N, Trainer, Notes, or Date …" />
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
    const hits = applyCatFilter(hitsAll, jobsCatFilter).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    results.innerHTML = hits.length ? hits.map(j => cardJob(j, true)).join("") : `<p class="muted">No results for this filter.</p>`;
    bindJobActions();
  }

  input.addEventListener("input", doSearch);
  doSearch();
}

async function renderTodo() {
  const todos = (await getAllTodos()).map(ensureCategory);

  const openAll = todos.filter(t => !t.done);
  const doneAll = todos.filter(t => t.done);

  const open = applyCatFilter(openAll, todoCatFilter).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const done = applyCatFilter(doneAll, todoCatFilter).sort((a, b) => ((b.doneAt || 0) - (a.doneAt || 0)));

  view.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <h2 style="margin:0;">ToDo / OJT List</h2>
      <button class="btn" id="recheckBtn">Recheck All</button>
    </div>

    ${renderCatToggle(todoCatFilter, "todofilter")}

    <div class="card">
      <strong style="color:var(--text-strong)">Add ToDo</strong>

      <label>Category (required)</label>
      ${categorySelect("t_cat", (todoCatFilter === "CLS" || todoCatFilter === "INT") ? todoCatFilter : "CLS")}

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

      <label>Notes / Keywords (optional)</label>
      <input id="t_text" placeholder="free text" />

      <div class="row" style="margin-top:12px;">
        <button class="btn primary" id="addTodoBtn">Add ToDo</button>
      </div>

      <p class="smallnote" style="margin-top:10px;">
        Matching:
        <br>• If Job has P/N → P/N must match 100% (case-insensitive).
        <br>• If Job has no P/N → Notes must match ≥ 96% (all characters count).
      </p>
    </div>

    <h2>Open</h2>
    ${open.length ? open.map(todoCard).join("") : `<p class="muted">No open ToDos for this filter.</p>`}

    <h2>Done</h2>
    ${done.length ? done.map(todoCard).join("") : `<p class="muted">No done ToDos for this filter.</p>`}
  `;

  bindCatToggle("todofilter", (f) => { todoCatFilter = f; renderTodo(); });

  $("#recheckBtn").onclick = async () => {
    if (!confirm("Recheck all OPEN ToDos against existing Jobs?")) return;
    await recheckAll();
  };

  $("#addTodoBtn").onclick = async () => {
    const todo = ensureCategory({
      id: uuid(),
      category: ($("#t_cat").value || "CLS").trim().toUpperCase(),
      wo: ($("#t_wo").value || "").trim(),
      tc: ($("#t_tc").value || "").trim(),
      pn: ($("#t_pn").value || "").trim(),
      text: ($("#t_text").value || "").trim(),
      done: false,
      createdAt: Date.now(),
      doneAt: null,
      matchedJobId: null
    });

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

    await applyJobMatchingForTodo(todo);

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
    <textarea id="text" placeholder="What did you do?">${escapeHtml(existing?.text || "")}</textarea>

    <div class="row" style="margin-top:12px;">
      <button id="saveBtn" class="btn primary">${isEdit ? "Save" : "Create"}</button>
      <button id="cancelBtn" class="btn">Cancel</button>
    </div>
  `;

  $("#cancelBtn").onclick = () => render();

  $("#saveBtn").onclick = async () => {
    const category = ($("#category").value || "").trim().toUpperCase();
    if (!CATEGORIES.includes(category)) {
      setStatus("Please select a category.");
      return;
    }

    const job = ensureCategory({
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
    });

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
if ($("#backupBtn")) $("#backupBtn").onclick = async () => {
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
};

if ($("#restoreBtn")) $("#restoreBtn").onclick = () => {
  $("#restoreInput").value = "";
  $("#restoreInput").click();
};

if ($("#restoreInput")) $("#restoreInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();

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
    ensureCategory(j);
    j.search = makeJobSearch(j);
    await putJob(j);
  }
  for (const t of data.todos) {
    ensureCategory(t);
    t.search = makeTodoSearch(t);
    await putTodo(t);
  }

  setStatus("Restore complete.");
  currentTab = "today";
  render();
});

// Import ToDos: JSON array or CSV
function parseCsvTodos(csvText) {
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
      out.push({ category: maybeCat, wo: cols[1] || "", tc: cols[2] || "", pn: cols[3] || "", text: cols.slice(4).join(",") || "" });
    } else {
      out.push({ category: "CLS", wo: cols[0] || "", tc: cols[1] || "", pn: cols[2] || "", text: cols.slice(3).join(",") || "" });
    }
  }
  return out;
}

async function importTodos(items) {
  const existing = (await getAllTodos()).map(ensureCategory);
  const existingKeys = new Set(existing.map(t => normalize(t.search || "")));
  const now = Date.now();
  let added = 0;

  for (const x of items) {
    const todo = ensureCategory({
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
    });

    if (!todo.wo && !todo.tc && !todo.pn && !todo.text) continue;

    todo.search = makeTodoSearch(todo);
    const key = normalize(todo.search);
    if (key && existingKeys.has(key)) continue;
    existingKeys.add(key);

    await putTodo(todo);
    await applyJobMatchingForTodo(todo);
    added++;
  }
  return added;
}

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

// ---------- Navigation ----------
document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => {
    currentTab = btn.getAttribute("data-tab");
    render();
  };
});

if ($("#addBtn")) $("#addBtn").onclick = () => renderForm(null);

// ---------- Init ----------
(async function init() {
  db = await openDB();

  const jobs = await getAllJobs();
  for (const j of jobs) {
    const jj = ensureCategory(j);
    jj.search = makeJobSearch(jj);
    await putJob(jj);
  }
  const todos = await getAllTodos();
  for (const t of todos) {
    const tt = ensureCategory(t);
    tt.search = makeTodoSearch(tt);
    await putTodo(tt);
  }

  render();
})();
// ===== FIX: Buttons immer aktiv (auch nach neuem Render) =====
document.addEventListener("click", (e) => {

  // Tabs unten (Today / All Days / Date / Search / ToDo)
  const tabBtn = e.target.closest("button[data-tab]");
  if (tabBtn) {
    currentTab = tabBtn.dataset.tab;
    render();
    return;
  }

  // + New Job Button
  if (e.target.closest("#addJobBtn")) {
    renderJobForm();
    return;
  }

  // + New ToDo Button
  if (e.target.closest("#addTodoBtn")) {
    renderTodoForm();
    return;
  }
});


