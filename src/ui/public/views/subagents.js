// Subagents view — the heart of the dashboard.
// Live table per AiSession (or all sessions). Click row → drawer with
// the row's full state, events log, and final response.

import {
  escapeHtml, fmtSec, fmtAge, fmtAbs,
  statusBadge, getJSON, poll, store, toast,
} from "/ui/app.js";
import { openCreateModal } from "/ui/views/create.js";

// Lightweight diff colorizer — wraps each line in a span with a class
// based on the leading char so CSS can color it. No syntax-aware
// parsing; just enough to make the diff readable.
function colorizeDiff(pre) {
  if (!pre) return;
  const text = pre.textContent;
  const lines = text.split(/\r?\n/);
  pre.innerHTML = lines.map((line) => {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-meta";
    else if (line.startsWith("@@")) cls = "diff-hunk";
    else if (line.startsWith("+")) cls = "diff-add";
    else if (line.startsWith("-")) cls = "diff-del";
    else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "diff-meta";
    return `<span class="${cls}">${escapeHtmlLine(line)}</span>`;
  }).join("\n");
}
function escapeHtmlLine(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// Client-side activity buffer keyed by task id. Each entry is the last
// SPARK_LEN samples of activityCount (oldest first). We compute deltas
// on render to draw sparklines without server changes.
const SPARK_LEN = 30;
const activityBuf = new Map();
function recordSample(t) {
  const key = t.id;
  const arr = activityBuf.get(key) ?? [];
  arr.push(Number(t.activityCount ?? 0));
  if (arr.length > SPARK_LEN) arr.splice(0, arr.length - SPARK_LEN);
  activityBuf.set(key, arr);
  return arr;
}
function sparkline(samples) {
  // Render deltas (per-poll activity rate) as a tiny inline SVG.
  if (samples.length < 2) return `<span class="muted mono">—</span>`;
  const deltas = [];
  for (let i = 1; i < samples.length; i++) deltas.push(Math.max(0, samples[i] - samples[i - 1]));
  const max = Math.max(1, ...deltas);
  const w = 80, h = 18;
  const stepX = w / Math.max(1, deltas.length - 1);
  const pts = deltas.map((d, i) => `${(i * stepX).toFixed(1)},${(h - (d / max) * h).toFixed(1)}`).join(" ");
  const last = deltas[deltas.length - 1] ?? 0;
  const stroke = last > 0 ? "var(--accent)" : "var(--muted)";
  return `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">
      <polyline fill="none" stroke="${stroke}" stroke-width="1.4" points="${pts}" />
    </svg>
  `;
}

export function mount(root, ctx) {
  const filterSession = store.get("subagents.session", "");
  const filterStatus  = store.get("subagents.status", "");
  const showDeleted   = store.get("subagents.showDeleted", false);

  root.innerHTML = `
    <div class="view-header">
      <h1>Subagents</h1>
      <div class="actions">
        <button id="sa-new" title="Create a new subagent">+ new subagent</button>
        <span id="sa-count" class="muted mono"></span>
      </div>
    </div>
    <div id="sa-summary-cards" class="summary-strip"></div>
    <div class="view-controls">
      <label>session
        <select id="sa-session"><option value="">— all —</option></select>
      </label>
      <label>status
        <select id="sa-status">
          <option value="">— any —</option>
          <option value="created">created</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="merge_failed">merge_failed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </label>
      <label><input type="checkbox" id="sa-deleted" /> show deleted</label>
      <span class="muted">refresh every 4s</span>
    </div>
    <div id="sa-table"></div>
  `;

  const sel = root.querySelector("#sa-session");
  const stSel = root.querySelector("#sa-status");
  const delChk = root.querySelector("#sa-deleted");
  stSel.value = filterStatus;
  delChk.checked = !!showDeleted;

  // Populate session dropdown once.
  let sessionsCache = [];
  getJSON("/sessions").then((sessions) => {
    sessionsCache = sessions;
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    sel.innerHTML = `<option value="">— all —</option>` +
      sessions.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name ?? s.id.slice(0,8))} · ${escapeHtml(s.provider)}</option>`).join("");
    sel.value = filterSession;
  }).catch(() => {});

  let lastRows = [];
  let selectedId = ctx.params?.[0] ?? null;

  const rerender = async () => {
    const session = sel.value;
    const status  = stSel.value;
    const deleted = delChk.checked ? "1" : "0";
    const qs = new URLSearchParams();
    if (session) qs.set("aiSessionId", session);
    if (status) qs.set("status", status);
    if (deleted === "1") qs.set("includeDeleted", "1");
    let rows;
    try {
      rows = await getJSON(`/subagents?${qs.toString()}`);
    } catch (e) {
      root.querySelector("#sa-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    lastRows = rows;
    rows.forEach(recordSample);
    paintSummary(root, rows);
    paint(root, rows, selectedId, ctx, (id) => {
      selectedId = id;
      openSubagentDrawer(id, ctx);
    });
  };

  sel.addEventListener("change", () => {
    store.set("subagents.session", sel.value);
    rerender();
  });
  stSel.addEventListener("change", () => {
    store.set("subagents.status", stSel.value);
    rerender();
  });
  delChk.addEventListener("change", () => {
    store.set("subagents.showDeleted", delChk.checked);
    rerender();
  });
  root.querySelector("#sa-new").addEventListener("click", () => {
    openCreateModal({
      sessions: sessionsCache,
      defaultSessionId: sel.value || sessionsCache[0]?.id,
      onCreated: () => rerender(),
    });
  });

  if (selectedId) openSubagentDrawer(selectedId, ctx);

  return poll(rerender, 4000);
}

function paintSummary(root, rows) {
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const running = counts.running ?? 0;
  const created = counts.created ?? 0;
  const failed = (counts.failed ?? 0) + (counts.merge_failed ?? 0);
  const completed = counts.completed ?? 0;
  // Recent activity rate: total deltas across all running rows over the
  // last sample (4s).
  let recentDelta = 0;
  for (const r of rows) {
    if (r.status !== "running") continue;
    const arr = activityBuf.get(r.id);
    if (arr && arr.length >= 2) {
      recentDelta += Math.max(0, arr[arr.length - 1] - arr[arr.length - 2]);
    }
  }
  const card = (label, value, cls = "") => `
    <div class="card ${cls}">
      <div class="v">${value}</div>
      <div class="k">${label}</div>
    </div>
  `;
  root.querySelector("#sa-summary-cards").innerHTML = `
    ${card("running",   `<span class="s-running mono">${running}</span>`,   running ? "alive" : "")}
    ${card("queued",    `<span class="s-created mono">${created}</span>`)}
    ${card("done",      `<span class="s-completed mono">${completed}</span>`)}
    ${card("failed",    `<span class="s-failed mono">${failed}</span>`,    failed ? "alert" : "")}
    ${card("msgs/4s",   `<span class="mono">${recentDelta}</span>`,        recentDelta ? "alive" : "")}
  `;
}

function paint(root, rows, selectedId, ctx, onSelect) {
  const now = Date.now();
  const order = { running: 0, created: 1, merge_failed: 2, failed: 3, cancelled: 4, completed: 5 };
  rows.sort((a, b) => {
    const oa = order[a.status] ?? 9, ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  root.querySelector("#sa-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    root.querySelector("#sa-table").innerHTML =
      `<div class="placeholder">no subagents match the current filters · click <strong>+ new subagent</strong> to create one</div>`;
    return;
  }

  const html = `
    <table class="data">
      <thead>
        <tr>
          <th>status</th>
          <th>id</th>
          <th>provider</th>
          <th>title</th>
          <th class="num">msgs</th>
          <th>activity</th>
          <th class="num">age</th>
          <th class="num">attempts</th>
          <th>session</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const ageMs = now - Date.parse(r.updatedAt);
          const ageLabel = r.status === "running" ? `idle ${fmtSec(ageMs)}` : fmtSec(ageMs);
          const samples = activityBuf.get(r.id) ?? [];
          return `
            <tr class="row ${r.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(r.id)}">
              <td>${statusBadge(r.status)}</td>
              <td class="mono">${escapeHtml(r.id.slice(0, 8))}</td>
              <td class="mono">${escapeHtml(r.provider ?? "—")}</td>
              <td class="title" title="${escapeHtml(r.title ?? "")}">${escapeHtml(r.title ?? "")}</td>
              <td class="num">${r.activityCount ?? 0}</td>
              <td class="spark">${sparkline(samples)}</td>
              <td class="num" title="${escapeHtml(fmtAbs(r.updatedAt))}">${ageLabel}</td>
              <td class="num">${r.attemptCount ?? 0}/${r.maxAttempts ?? 0}</td>
              <td class="mono" title="${escapeHtml(r.aiSessionId)}">${escapeHtml(r.aiSessionId.slice(0, 8))}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
  root.querySelector("#sa-table").innerHTML = html;
  root.querySelectorAll("tr.row").forEach((tr) => {
    tr.addEventListener("click", () => onSelect(tr.dataset.id));
  });
}

// Drawer auto-refresh — when the open subagent is still `running`, we
// re-fetch its row + events every 4s so the user sees the events log
// tick in real time. The interval is cleared when the drawer closes
// (via app.closeDrawer triggering a global event we listen to here)
// or when this view unmounts.
let drawerRefreshTimer = null;
let drawerCurrentId = null;

function stopDrawerRefresh() {
  if (drawerRefreshTimer) clearInterval(drawerRefreshTimer);
  drawerRefreshTimer = null;
  drawerCurrentId = null;
}

async function openSubagentDrawer(id, ctx) {
  stopDrawerRefresh();
  drawerCurrentId = id;
  const body = document.createElement("div");
  body.innerHTML = `<div class="muted mono">loading…</div>`;
  ctx.drawer({ title: id.slice(0, 8) + " · loading…", body });

  const refresh = async () => {
    if (drawerCurrentId !== id) return;
    try {
      const [task, events] = await Promise.all([
        getJSON(`/subagents/${id}`),
        getJSON(`/subagents/${id}/events`),
      ]);
      paintDrawer(body, task, events);
      ctx.drawer({
        title: `${task.id.slice(0, 8)} · ${task.title ?? ""}`,
        body,
      });
      // Stop polling once the row is terminal — nothing more will arrive.
      const terminal = ["completed", "failed", "merge_failed", "cancelled"];
      if (terminal.includes(task.status)) stopDrawerRefresh();
    } catch (e) {
      body.innerHTML = `<div class="placeholder">${escapeHtml(e.message)}</div>`;
    }
  };
  await refresh();
  drawerRefreshTimer = setInterval(refresh, 4000);

  // If the drawer's close button is hit, stop our refresh too.
  document.getElementById("drawer-close")?.addEventListener("click", stopDrawerRefresh, { once: true });
}

function paintDrawer(body, task, events) {
  const kv = (k, v) => `<div class="k">${escapeHtml(k)}</div><div class="v">${v}</div>`;
  const link = (label, href) => `<a href="${href}">${escapeHtml(label)}</a>`;

  body.innerHTML = `
    <div class="kv">
      ${kv("status", statusBadge(task.status))}
      ${kv("provider", `<span class="mono">${escapeHtml(task.provider ?? "—")}</span>`)}
      ${kv("id", `<span class="mono">${escapeHtml(task.id)}</span>`)}
      ${kv("session", link(task.aiSessionId.slice(0, 8), `#/subagents/${task.aiSessionId}`))}
      ${kv("title", escapeHtml(task.title ?? "—"))}
      ${kv("attempts", `${task.attemptCount}/${task.maxAttempts}`)}
      ${kv("msgs", `${task.activityCount ?? 0}`)}
      ${kv("timeout", `${task.timeoutSeconds}s`)}
      ${kv("notify", task.notifySupervisor ? "yes" : "<span class='muted'>silent</span>")}
      ${kv("created", `${escapeHtml(fmtAbs(task.createdAt))} <span class="muted">(${fmtAge(task.createdAt)} ago)</span>`)}
      ${kv("started", task.startedAt ? `${escapeHtml(fmtAbs(task.startedAt))}` : "<span class='muted'>—</span>")}
      ${kv("updated", `${escapeHtml(fmtAbs(task.updatedAt))} <span class="muted">(${fmtAge(task.updatedAt)} ago)</span>`)}
      ${kv("finished", task.finishedAt ? escapeHtml(fmtAbs(task.finishedAt)) : "<span class='muted'>—</span>")}
      ${task.cwd ? kv("cwd", `<span class="mono">${escapeHtml(task.cwd)}</span>`) : ""}
      ${task.worktreePath ? kv("worktree", `<span class="mono">${escapeHtml(task.worktreePath)}</span>`) : ""}
      ${task.branchName ? kv("branch", `<span class="mono">${escapeHtml(task.branchName)}</span>`) : ""}
      ${task.subAgentId ? kv("runtime", `<span class="mono">${escapeHtml(task.subAgentId.slice(0,8))}</span>`) : ""}
    </div>

    <h3 class="section-h">prompt</h3>
    <pre class="response">${escapeHtml(task.prompt ?? "")}</pre>

    ${task.response ? `
      <h3 class="section-h">response</h3>
      <pre class="response">${escapeHtml(task.response)}</pre>
    ` : ""}

    <h3 class="section-h">events (${events.length})</h3>
    ${events.length === 0 ? `<div class="muted mono">no events</div>` :
      events.map((e) => `
        <div class="event-row evt-${escapeHtml(e.eventType)}">
          <span class="ts">${escapeHtml(fmtAge(e.createdAt))}</span>
          <span class="body">${escapeHtml(e.eventType)}${e.message ? " · " + escapeHtml(e.message) : ""}</span>
        </div>
      `).join("")
    }

    <div class="action-row">
      ${task.status === "running" ? `<button data-act="cancel">cancel</button>` : ""}
      ${task.status === "created" || task.status === "merge_failed" ? `<button data-act="dispatch">dispatch</button>` : ""}
      ${task.worktreePath ? `<button data-act="diff">view diff</button>` : ""}
      ${!task.deletedAt ? `<button data-act="delete">delete</button>` : ""}
    </div>
    <div id="drawer-diff"></div>
  `;

  body.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      try {
        if (act === "cancel") {
          const r = await fetch(`/subagents/${task.id}/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "cancelled from console" }),
          });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
          toast("cancelled");
        } else if (act === "dispatch") {
          const r = await fetch(`/subagents/${task.id}/dispatch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
          toast("dispatched");
        } else if (act === "delete") {
          const r = await fetch(`/subagents/${task.id}`, { method: "DELETE" });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
          toast("deleted");
        } else if (act === "diff") {
          const slot = body.querySelector("#drawer-diff");
          slot.innerHTML = `<h3 class="section-h">diff</h3><pre class="response">loading…</pre>`;
          const r = await fetch(`/subagents/${task.id}/diff`);
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error ?? `${r.status}`);
          slot.innerHTML = `
            <h3 class="section-h">diff (${escapeHtml(j.args?.join(" ") ?? "")})</h3>
            <pre class="response diff-block">${escapeHtml(j.diff || "(no changes)")}</pre>
          `;
          colorizeDiff(slot.querySelector(".diff-block"));
        }
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });
}
