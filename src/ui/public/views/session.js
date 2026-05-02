// Session detail view — one AiSession's metadata + transcript +
// subagents + actions. Hash route: #/session/:id

import {
  escapeHtml, fmtAge, fmtAbs, statusBadge,
  getJSON, poll, toast,
} from "/ui/app.js";

export function mount(root, ctx) {
  const id = ctx.params?.[0];
  if (!id) {
    root.innerHTML = `<div class="placeholder">no session id; pick one from <a href="#/sessions">Sessions</a></div>`;
    return () => {};
  }
  root.innerHTML = `<div class="placeholder">loading…</div>`;

  let providerSessionId = null;
  let provider = null;

  const rerender = async () => {
    let ai;
    try {
      ai = await getJSON(`/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
      root.innerHTML = `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    provider = ai.provider;
    providerSessionId = ai.sessionId;

    // Subagents owned by this session.
    let subs = [];
    try {
      subs = await getJSON(`/subagents?aiSessionId=${encodeURIComponent(id)}`);
    } catch { /* keep going */ }

    // Transcript (provider-specific endpoint). Best-effort.
    let transcript = null;
    if (ai.sessionId) {
      try {
        transcript = await getJSON(`/providers/${encodeURIComponent(ai.provider)}/sessions/${encodeURIComponent(ai.sessionId)}`);
      } catch { /* may not have started yet */ }
    }

    paint(root, ai, subs, transcript);
  };

  return poll(rerender, 8000);
}

function paint(root, ai, subs, transcript) {
  const channels = ai.channels ?? {};
  const tg = channels.telegram ?? {};
  const order = { running: 0, created: 1, merge_failed: 2, failed: 3, cancelled: 4, completed: 5 };
  const running = subs.filter((s) => s.status === "running").length;
  const recent = subs.slice().sort((a, b) =>
    (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
  );

  root.innerHTML = `
    <div class="view-header">
      <h1>Session · ${escapeHtml(ai.name ?? ai.id.slice(0, 8))}</h1>
      <div class="actions">
        <a href="#/sessions" class="muted">← all sessions</a>
        <button id="se-rename">rename</button>
        <button id="se-delete" class="danger">delete</button>
      </div>
    </div>

    <div class="kv" style="grid-template-columns:130px 1fr 130px 1fr;max-width:900px;">
      <div class="k">id</div><div class="v"><span class="mono">${escapeHtml(ai.id)}</span></div>
      <div class="k">provider</div><div class="v"><span class="mono">${escapeHtml(ai.provider)}</span></div>
      <div class="k">cwd</div><div class="v"><span class="mono">${escapeHtml(ai.cwd ?? "—")}</span></div>
      <div class="k">model</div><div class="v"><span class="mono">${escapeHtml(ai.model ?? "—")}</span></div>
      <div class="k">created</div><div class="v"><span class="mono" title="${escapeHtml(fmtAbs(ai.createdAt))}">${fmtAge(ai.createdAt)} ago</span></div>
      <div class="k">updated</div><div class="v"><span class="mono" title="${escapeHtml(fmtAbs(ai.updatedAt))}">${fmtAge(ai.updatedAt)} ago</span></div>
      <div class="k">provider session</div><div class="v"><span class="mono">${escapeHtml(ai.sessionId ?? "(not started)")}</span></div>
      <div class="k">effort</div><div class="v"><span class="mono">${escapeHtml(ai.reasoningEffort ?? "—")}</span></div>
      <div class="k">telegram chat</div><div class="v"><span class="mono">${escapeHtml(tg.chatId ?? "—")}</span></div>
      <div class="k">telegram thread</div><div class="v"><span class="mono">${escapeHtml(tg.threadId ?? "—")}</span></div>
    </div>

    <h3 class="section-h">subagents (${subs.length}, ${running} running)</h3>
    ${subs.length === 0 ? `<div class="muted mono">no subagents</div>` : `
      <table class="data" style="margin-bottom:24px;">
        <thead><tr>
          <th>status</th>
          <th>id</th>
          <th>provider</th>
          <th>title</th>
          <th class="num">msgs</th>
          <th class="num">age</th>
        </tr></thead>
        <tbody>
          ${recent.slice(0, 50).map((r) => `
            <tr class="row" data-id="${escapeHtml(r.id)}">
              <td>${statusBadge(r.status)}</td>
              <td class="mono">${escapeHtml(r.id.slice(0, 8))}</td>
              <td class="mono">${escapeHtml(r.provider ?? "—")}</td>
              <td class="title" title="${escapeHtml(r.title ?? "")}">${escapeHtml(r.title ?? "")}</td>
              <td class="num">${r.activityCount ?? 0}</td>
              <td class="num">${fmtAge(r.updatedAt)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `}

    <h3 class="section-h">transcript</h3>
    ${transcript == null
      ? `<div class="muted mono">${ai.sessionId ? "(provider session not yet readable — agent may still be initializing)" : "(no provider session yet — send a message to start)"}</div>`
      : transcriptHtml(transcript)}
  `;

  root.querySelectorAll("tr.row").forEach((tr) => {
    tr.addEventListener("click", () => {
      window.location.hash = `#/subagents/${tr.dataset.id}`;
    });
  });

  root.querySelector("#se-rename")?.addEventListener("click", async () => {
    const nm = prompt("New name (blank = auto-summarize)", ai.name ?? "");
    if (nm == null) return;
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(ai.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nm }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("renamed");
    } catch (e) { toast(e.message, "error"); }
  });

  root.querySelector("#se-delete")?.addEventListener("click", async () => {
    if (!confirm(`Delete session ${ai.id.slice(0, 8)}? Provider session is NOT affected.`)) return;
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(ai.id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("deleted");
      window.location.hash = "#/sessions";
    } catch (e) { toast(e.message, "error"); }
  });
}

function transcriptHtml(detail) {
  // Different providers have slightly different shapes. The shared
  // contract is detail.messages[] with { role, content, ts? } — be
  // defensive about anything beyond that.
  const messages = detail?.messages;
  if (!Array.isArray(messages)) {
    return `<div class="muted mono">(no messages)</div>`;
  }
  if (messages.length === 0) {
    return `<div class="muted mono">(empty transcript)</div>`;
  }
  const max = 60;
  const tail = messages.slice(Math.max(0, messages.length - max));
  return `
    <div class="transcript">
      ${messages.length > max ? `<div class="muted mono" style="margin-bottom:6px;">(showing last ${max} of ${messages.length})</div>` : ""}
      ${tail.map((m) => {
        const role = m.role ?? "?";
        const text = typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => c?.text ?? c?.content ?? "").join("\n")
            : JSON.stringify(m.content);
        const ts = m.ts ? `<span class="muted" title="${escapeHtml(fmtAbs(m.ts))}">${fmtAge(m.ts)} ago</span>` : "";
        const cls = role === "user" ? "user" : role === "assistant" ? "assistant" : "system";
        return `
          <div class="msg msg-${cls}">
            <div class="msg-head">${escapeHtml(role)} ${ts}</div>
            <pre class="msg-body">${escapeHtml((text || "").slice(0, 4000))}</pre>
          </div>
        `;
      }).join("")}
    </div>
  `;
}
