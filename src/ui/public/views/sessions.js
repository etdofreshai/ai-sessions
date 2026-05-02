// Sessions view — every AiSession on this server.

import { escapeHtml, fmtAge, fmtAbs, getJSON, poll } from "/ui/app.js";

export function mount(root) {
  root.innerHTML = `
    <div class="view-header">
      <h1>Sessions</h1>
      <div class="actions"><span id="se-count" class="muted mono"></span></div>
    </div>
    <div id="se-table"></div>
  `;
  const rerender = async () => {
    let rows;
    try {
      rows = await getJSON("/sessions");
    } catch (e) {
      root.querySelector("#se-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    root.querySelector("#se-count").textContent = `${rows.length} sessions`;
    root.querySelector("#se-table").innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>id</th>
            <th>name</th>
            <th>provider</th>
            <th>cwd</th>
            <th>updated</th>
            <th>created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((s) => `
            <tr class="row">
              <td class="mono" title="${escapeHtml(s.id)}">${escapeHtml(s.id.slice(0, 8))}</td>
              <td class="title" title="${escapeHtml(s.name ?? "")}">${escapeHtml(s.name ?? "—")}</td>
              <td class="mono">${escapeHtml(s.provider)}</td>
              <td class="mono" title="${escapeHtml(s.cwd ?? "")}">${escapeHtml(s.cwd ?? "—")}</td>
              <td class="mono" title="${escapeHtml(fmtAbs(s.updatedAt))}">${fmtAge(s.updatedAt)}</td>
              <td class="mono" title="${escapeHtml(fmtAbs(s.createdAt))}">${fmtAge(s.createdAt)}</td>
              <td><a href="#/subagents/${escapeHtml(s.id)}">subagents →</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };
  return poll(rerender, 6000);
}
