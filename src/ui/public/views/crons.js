// Crons view — scheduled wake-ups (AFK heartbeat, resume, custom).

import { escapeHtml, fmtAge, fmtAbs, getJSON, poll } from "/ui/app.js";

export function mount(root) {
  root.innerHTML = `
    <div class="view-header">
      <h1>Crons</h1>
      <div class="actions"><span id="cr-count" class="muted mono"></span></div>
    </div>
    <div id="cr-table"></div>
  `;
  const rerender = async () => {
    let rows;
    try {
      rows = await getJSON("/crons");
    } catch (e) {
      root.querySelector("#cr-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    rows.sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
    root.querySelector("#cr-count").textContent = `${rows.length} crons`;
    if (!rows.length) {
      root.querySelector("#cr-table").innerHTML =
        `<div class="placeholder">no scheduled jobs</div>`;
      return;
    }
    root.querySelector("#cr-table").innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>name</th>
            <th>cron</th>
            <th>kind</th>
            <th>next run</th>
            <th>last run</th>
            <th>last error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((c) => `
            <tr>
              <td class="mono">${escapeHtml(c.name)}</td>
              <td class="mono">${escapeHtml(c.cron)}</td>
              <td class="mono">${escapeHtml(c.target?.kind ?? "?")}</td>
              <td class="mono" title="${escapeHtml(fmtAbs(c.nextRunAt))}">in ${fmtAge(c.nextRunAt).startsWith("-") ? "now" : fmtAge(c.nextRunAt)}</td>
              <td class="mono" title="${escapeHtml(fmtAbs(c.lastRunAt))}">${c.lastRunAt ? fmtAge(c.lastRunAt) + " ago" : "—"}</td>
              <td class="mono" style="color:var(--bad)">${escapeHtml((c.lastError ?? "").slice(0, 60))}</td>
              <td>
                <button data-act="del" data-name="${escapeHtml(c.name)}" title="Delete this cron">delete</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    root.querySelectorAll('button[data-act="del"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!confirm(`Delete cron "${name}"?`)) return;
        try {
          await fetch(`/crons/${encodeURIComponent(name)}`, { method: "DELETE" });
          rerender();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  };
  return poll(rerender, 8000);
}
