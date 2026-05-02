// Hooks view — tail of the hook_events table.
// Optional filter by inner-harness session_id.

import { escapeHtml, fmtAge, fmtAbs, getJSON, poll, store } from "/ui/app.js";

export function mount(root) {
  const filterSession = store.get("hooks.session", "");
  const limit = store.get("hooks.limit", 200);

  root.innerHTML = `
    <div class="view-header">
      <h1>Hooks</h1>
      <div class="actions"><span id="hk-count" class="muted mono"></span></div>
    </div>
    <div class="view-controls">
      <label>session_id (provider session)
        <input id="hk-session" placeholder="(blank = all)" value="${escapeHtml(filterSession)}" style="width:380px"/>
      </label>
      <label>limit
        <input id="hk-limit" type="number" min="20" max="1000" value="${limit}" style="width:80px"/>
      </label>
      <span class="muted">refresh every 5s</span>
    </div>
    <div id="hk-table"></div>
  `;

  const sIn = root.querySelector("#hk-session");
  const lIn = root.querySelector("#hk-limit");
  sIn.addEventListener("change", () => store.set("hooks.session", sIn.value));
  lIn.addEventListener("change", () => store.set("hooks.limit", Number(lIn.value)));

  const rerender = async () => {
    const qs = new URLSearchParams();
    if (sIn.value.trim()) qs.set("session_id", sIn.value.trim());
    qs.set("limit", String(lIn.value || 200));
    let rows;
    try {
      rows = await getJSON(`/hooks?${qs.toString()}`);
    } catch (e) {
      root.querySelector("#hk-table").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    rows.sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
    root.querySelector("#hk-count").textContent = `${rows.length} events`;
    root.querySelector("#hk-table").innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>age</th>
            <th>harness</th>
            <th>event</th>
            <th>tool</th>
            <th>session</th>
            <th>ai-session</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="mono" title="${escapeHtml(fmtAbs(r.receivedAt))}">${fmtAge(r.receivedAt)}</td>
              <td class="mono">${escapeHtml(r.harness ?? "")}</td>
              <td class="mono" style="color:var(--accent-2)">${escapeHtml(r.eventName ?? "")}</td>
              <td class="mono" title="${escapeHtml(r.toolName ?? "")}">${escapeHtml(r.toolName ?? "—")}</td>
              <td class="mono" title="${escapeHtml(r.sessionId ?? "")}">${escapeHtml((r.sessionId ?? "—").slice(0, 12))}</td>
              <td class="mono">${r.aiSessionId ? `<a href="#/subagents/${escapeHtml(r.aiSessionId)}">${escapeHtml(r.aiSessionId.slice(0, 8))}</a>` : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };
  return poll(rerender, 5000);
}
