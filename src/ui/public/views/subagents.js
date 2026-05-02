// Subagents view — the heart of the dashboard.
// Live table per AiSession (or all sessions). Click row → drawer with
// the row's full state, events log, and final response.

import {
  escapeHtml, fmtSec, fmtAge, fmtAbs,
  statusBadge, getJSON, poll, store,
} from "/ui/app.js";

export function mount(root, ctx) {
  const filterSession = store.get("subagents.session", "");
  const filterStatus  = store.get("subagents.status", "");
  const showDeleted   = store.get("subagents.showDeleted", false);

  root.innerHTML = `
    <div class="view-header">
      <h1>Subagents</h1>
      <div class="actions">
        <span id="sa-count" class="muted mono"></span>
      </div>
    </div>
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
    <div id="sa-summary" class="view-controls"></div>
    <div id="sa-table"></div>
  `;

  const sel = root.querySelector("#sa-session");
  const stSel = root.querySelector("#sa-status");
  const delChk = root.querySelector("#sa-deleted");
  stSel.value = filterStatus;
  delChk.checked = !!showDeleted;

  // Populate session dropdown once.
  getJSON("/sessions").then((sessions) => {
    sel.innerHTML = `<option value="">— all —</option>` +
      sessions
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name ?? s.id.slice(0,8))} · ${escapeHtml(s.provider)}</option>`)
        .join("");
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

  if (selectedId) openSubagentDrawer(selectedId, ctx);

  return poll(rerender, 4000);
}

function paint(root, rows, selectedId, ctx, onSelect) {
  const now = Date.now();
  const order = { running: 0, created: 1, merge_failed: 2, failed: 3, cancelled: 4, completed: 5 };
  rows.sort((a, b) => {
    const oa = order[a.status] ?? 9, ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const sumLine = Object.entries(counts)
    .sort((a, b) => (order[a[0]] ?? 9) - (order[b[0]] ?? 9))
    .map(([s, n]) => `${statusBadge(s)} <span class="mono">${n}</span>`)
    .join(" &nbsp; ");
  root.querySelector("#sa-summary").innerHTML = sumLine || `<span class="muted">no subagents</span>`;
  root.querySelector("#sa-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    root.querySelector("#sa-table").innerHTML =
      `<div class="placeholder">no subagents match the current filters</div>`;
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
          <th class="num">age</th>
          <th class="num">attempts</th>
          <th>session</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const ageMs = now - Date.parse(r.updatedAt);
          const ageLabel = r.status === "running" ? `idle ${fmtSec(ageMs)}` : fmtSec(ageMs);
          return `
            <tr class="row ${r.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(r.id)}">
              <td>${statusBadge(r.status)}</td>
              <td class="mono">${escapeHtml(r.id.slice(0, 8))}</td>
              <td class="mono">${escapeHtml(r.provider ?? "—")}</td>
              <td class="title" title="${escapeHtml(r.title ?? "")}">${escapeHtml(r.title ?? "")}</td>
              <td class="num">${r.activityCount ?? 0}</td>
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

async function openSubagentDrawer(id, ctx) {
  const body = document.createElement("div");
  body.innerHTML = `<div class="muted mono">loading…</div>`;
  ctx.drawer({ title: id.slice(0, 8) + " · loading…", body });

  try {
    const [task, events] = await Promise.all([
      getJSON(`/subagents/${id}`),
      getJSON(`/subagents/${id}/events`),
    ]);
    paintDrawer(body, task, events);
    ctx.drawer({
      title: `${task.id.slice(0, 8)} · ${escapeHtml(task.title ?? "")}`,
      body,
    });
  } catch (e) {
    body.innerHTML = `<div class="placeholder">${escapeHtml(e.message)}</div>`;
  }
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

    <h3 style="margin:18px 0 6px;font-size:12px;color:var(--text-1);font-weight:500;text-transform:uppercase;letter-spacing:0.06em;">prompt</h3>
    <pre class="response">${escapeHtml(task.prompt ?? "")}</pre>

    ${task.response ? `
      <h3 style="margin:18px 0 6px;font-size:12px;color:var(--text-1);font-weight:500;text-transform:uppercase;letter-spacing:0.06em;">response</h3>
      <pre class="response">${escapeHtml(task.response)}</pre>
    ` : ""}

    <h3 style="margin:18px 0 6px;font-size:12px;color:var(--text-1);font-weight:500;text-transform:uppercase;letter-spacing:0.06em;">events (${events.length})</h3>
    ${events.length === 0 ? `<div class="muted mono">no events</div>` :
      events.map((e) => `
        <div class="event-row evt-${escapeHtml(e.eventType)}">
          <span class="ts">${escapeHtml(fmtAge(e.createdAt))}</span>
          <span class="body">${escapeHtml(e.eventType)}${e.message ? " · " + escapeHtml(e.message) : ""}</span>
        </div>
      `).join("")
    }

    <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap;">
      ${task.status === "running" ? `<button data-act="cancel">cancel</button>` : ""}
      ${task.status === "created" || task.status === "merge_failed" ? `<button data-act="dispatch">dispatch</button>` : ""}
      ${!task.deletedAt ? `<button data-act="delete">delete</button>` : ""}
    </div>
  `;

  body.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      try {
        if (act === "cancel") {
          await fetch(`/subagents/${task.id}/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "cancelled from console" }),
          });
        } else if (act === "dispatch") {
          await fetch(`/subagents/${task.id}/dispatch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          });
        } else if (act === "delete") {
          await fetch(`/subagents/${task.id}`, { method: "DELETE" });
        }
      } catch (e) {
        alert(e.message);
      }
    });
  });
}
