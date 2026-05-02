// Jobs view — long-running shell jobs / background workers.

import { escapeHtml, fmtAge, fmtAbs, getJSON, poll } from "/ui/app.js";

export function mount(root) {
  root.innerHTML = `
    <div class="view-header">
      <h1>Jobs</h1>
      <div class="actions"><span id="jb-count" class="muted mono"></span></div>
    </div>
    <div id="jb-table"></div>
  `;
  const rerender = async () => {
    let rows;
    try {
      rows = await getJSON("/jobs");
    } catch (e) {
      root.querySelector("#jb-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    root.querySelector("#jb-count").textContent = `${rows.length} jobs`;
    if (!rows.length) {
      root.querySelector("#jb-table").innerHTML =
        `<div class="placeholder">no jobs</div>`;
      return;
    }
    const STATUS = {
      pending:    "s-created",
      running:    "s-running",
      succeeded:  "s-completed",
      failed:     "s-failed",
      cancelled:  "s-cancelled",
    };
    root.querySelector("#jb-table").innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>status</th>
            <th>id</th>
            <th>kind</th>
            <th>label</th>
            <th>session</th>
            <th>created</th>
            <th>finished</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((j) => `
            <tr>
              <td><span class="badge ${STATUS[j.status] ?? ""}"><span class="dot-status"></span>${escapeHtml(j.status)}</span></td>
              <td class="mono" title="${escapeHtml(j.id)}">${escapeHtml(j.id.slice(0, 8))}</td>
              <td class="mono">${escapeHtml(j.kind)}</td>
              <td class="title">${escapeHtml(j.label ?? "—")}</td>
              <td class="mono">${j.aiSessionId ? `<a href="#/subagents/${escapeHtml(j.aiSessionId)}">${escapeHtml(j.aiSessionId.slice(0, 8))}</a>` : "—"}</td>
              <td class="mono" title="${escapeHtml(fmtAbs(j.createdAt))}">${fmtAge(j.createdAt)}</td>
              <td class="mono">${j.finishedAt ? fmtAge(j.finishedAt) : "—"}</td>
              <td>${j.status === "running" || j.status === "pending"
                  ? `<button data-id="${escapeHtml(j.id)}" data-act="cancel">cancel</button>`
                  : ""}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    root.querySelectorAll('button[data-act="cancel"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await fetch(`/jobs/${btn.dataset.id}/cancel`, { method: "POST" });
          rerender();
        } catch (e) { alert(e.message); }
      });
    });
  };
  return poll(rerender, 5000);
}
