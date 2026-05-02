// Runs view — recent provider runs across all sessions. Click a row
// to open the drawer with the full prompt + output preview.

import {
  escapeHtml, fmtAge, fmtAbs, fmtSec, getJSON, poll, store,
} from "/ui/app.js";

const STATUS = {
  pending:    "s-created",
  running:    "s-running",
  completed:  "s-completed",
  failed:     "s-failed",
  cancelled:  "s-cancelled",
};

export function mount(root, ctx) {
  const filterStatus = store.get("runs.status", "");
  const limit = store.get("runs.limit", 200);

  root.innerHTML = `
    <div class="view-header">
      <h1>Runs</h1>
      <div class="actions"><span id="rn-count" class="muted mono"></span></div>
    </div>
    <div class="view-controls">
      <label>status
        <select id="rn-status">
          <option value="">— any —</option>
          <option value="pending">pending</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </label>
      <label>limit
        <input id="rn-limit" type="number" min="20" max="1000" value="${limit}" style="width:80px"/>
      </label>
      <span class="muted">refresh every 5s</span>
    </div>
    <div id="rn-table"></div>
  `;
  const stSel = root.querySelector("#rn-status");
  const lIn = root.querySelector("#rn-limit");
  stSel.value = filterStatus;
  stSel.addEventListener("change", () => store.set("runs.status", stSel.value));
  lIn.addEventListener("change", () => store.set("runs.limit", Number(lIn.value)));

  const rerender = async () => {
    const qs = new URLSearchParams();
    if (stSel.value) qs.set("status", stSel.value);
    qs.set("limit", String(lIn.value || 200));
    let rows;
    try {
      rows = await getJSON(`/runs?${qs.toString()}`);
    } catch (e) {
      root.querySelector("#rn-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    const byId = new Map(rows.map((r) => [r.runId, r]));
    root.querySelector("#rn-count").textContent = `${rows.length} runs`;
    root.querySelector("#rn-table").innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>status</th>
            <th>id</th>
            <th>provider</th>
            <th>session</th>
            <th>prompt</th>
            <th class="num">duration</th>
            <th class="num">age</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const dur = r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.createdAt) : null;
            return `
              <tr class="row" data-id="${escapeHtml(r.runId)}">
                <td><span class="badge ${STATUS[r.status] ?? ""}"><span class="dot-status"></span>${escapeHtml(r.status)}</span></td>
                <td class="mono" title="${escapeHtml(r.runId)}">${escapeHtml(r.runId.slice(0, 8))}</td>
                <td class="mono">${escapeHtml(r.provider)}</td>
                <td class="mono">${r.aiSessionId
                  ? `<a href="#/session/${escapeHtml(r.aiSessionId)}">${escapeHtml(r.aiSessionId.slice(0, 8))}</a>`
                  : "—"}</td>
                <td class="title" title="${escapeHtml((r.prompt ?? "").slice(0, 240))}">${escapeHtml((r.prompt ?? "").slice(0, 80))}</td>
                <td class="num">${dur != null ? fmtSec(dur) : (r.status === "running" ? "live" : "—")}</td>
                <td class="num" title="${escapeHtml(fmtAbs(r.createdAt))}">${fmtAge(r.createdAt)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
    root.querySelectorAll("tr.row").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const r = byId.get(tr.dataset.id);
        if (r) openRunDrawer(r, ctx);
      });
    });
  };
  return poll(rerender, 5000);
}

function openRunDrawer(r, ctx) {
  const body = document.createElement("div");
  const kv = (k, v) => `<div class="k">${escapeHtml(k)}</div><div class="v">${v}</div>`;
  const dur = r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.createdAt) : null;
  body.innerHTML = `
    <div class="kv">
      ${kv("status", `<span class="badge ${STATUS[r.status] ?? ""}"><span class="dot-status"></span>${escapeHtml(r.status)}</span>`)}
      ${kv("provider", `<span class="mono">${escapeHtml(r.provider)}</span>`)}
      ${kv("run id", `<span class="mono">${escapeHtml(r.runId)}</span>`)}
      ${kv("ai-session", r.aiSessionId
        ? `<a href="#/session/${escapeHtml(r.aiSessionId)}"><span class="mono">${escapeHtml(r.aiSessionId)}</span></a>`
        : "—")}
      ${kv("provider session", `<span class="mono">${escapeHtml(r.sessionId ?? "—")}</span>`)}
      ${kv("cwd", `<span class="mono">${escapeHtml(r.cwd ?? "—")}</span>`)}
      ${kv("created", `${escapeHtml(fmtAbs(r.createdAt))} <span class="muted">(${fmtAge(r.createdAt)} ago)</span>`)}
      ${kv("ended", r.endedAt ? escapeHtml(fmtAbs(r.endedAt)) : "<span class='muted'>—</span>")}
      ${kv("duration", dur != null ? fmtSec(dur) : "—")}
      ${kv("yolo", r.yolo ? "yes" : "no")}
      ${kv("internal", r.internal ? "yes" : "no")}
    </div>
    <h3 class="section-h">prompt</h3>
    <pre class="response">${escapeHtml(r.prompt ?? "")}</pre>
    ${r.outputPreview ? `<h3 class="section-h">output preview</h3><pre class="response">${escapeHtml(r.outputPreview)}</pre>` : ""}
    ${r.error ? `<h3 class="section-h">error</h3><pre class="response" style="color:var(--bad)">${escapeHtml(r.error)}</pre>` : ""}
  `;
  ctx.drawer({
    title: `${r.runId.slice(0, 8)} · ${r.provider}`,
    body,
  });
}
