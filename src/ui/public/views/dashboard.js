// Dashboard — high-level overview of the whole server. Counts,
// throughput, errors, what's running. Becomes the new landing page.

import {
  escapeHtml, fmtSec, getJSON, poll,
} from "/ui/app.js";

export function mount(root) {
  root.innerHTML = `<div class="placeholder">loading…</div>`;

  const rerender = async () => {
    let s;
    try {
      s = await getJSON("/stats");
    } catch (e) {
      root.innerHTML = `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    paint(root, s);
  };
  return poll(rerender, 5000);
}

function paint(root, s) {
  const sa = s.subagents;
  const hk = s.hooks;
  const card = (label, value, hint = "", cls = "") => `
    <div class="card ${cls}">
      <div class="v">${value}</div>
      <div class="k">${label}</div>
      ${hint ? `<div class="hint muted mono">${hint}</div>` : ""}
    </div>
  `;
  const longestRun = sa.longestRunningMs != null
    ? fmtSec(sa.longestRunningMs)
    : "—";
  const hookEvents = Object.entries(hk.byEvent ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const hookHarness = Object.entries(hk.byHarness ?? {})
    .sort((a, b) => b[1] - a[1]);
  const subStatus = Object.entries(sa.byStatus ?? {})
    .sort((a, b) => b[1] - a[1]);

  root.innerHTML = `
    <div class="view-header">
      <h1>Dashboard</h1>
      <div class="actions">
        <span class="muted mono">refresh every 5s</span>
      </div>
    </div>

    <h3 class="section-h">subagents</h3>
    <div class="dash-grid">
      ${card("running now",       `<span class="s-running mono">${sa.runningNow}</span>`, sa.longestRunningMs ? `oldest ${longestRun}` : "", sa.runningNow ? "alive" : "")}
      ${card("created (1h)",      `<span class="mono">${sa.createdLastHour}</span>`)}
      ${card("completed (1h)",    `<span class="s-completed mono">${sa.completedLastHour}</span>`)}
      ${card("failed (1h)",       `<span class="s-failed mono">${sa.failedLastHour}</span>`, "", sa.failedLastHour ? "alert" : "")}
      ${card("total tasks",       `<span class="mono">${sa.total}</span>`, statusLineHtml(subStatus))}
    </div>

    <h3 class="section-h">hooks</h3>
    <div class="dash-grid">
      ${card("events (1m)",  `<span class="mono">${hk.lastMinute}</span>`, hk.lastMinute ? "live" : "", hk.lastMinute ? "alive" : "")}
      ${card("events (1h)",  `<span class="mono">${hk.lastHour}</span>`)}
      ${card("events (all)", `<span class="mono">${hk.total}</span>`)}
      ${card("by harness (1h)", harnessLineHtml(hookHarness))}
      ${card("top events (1h)", topEventsHtml(hookEvents))}
    </div>

    <h3 class="section-h">infrastructure</h3>
    <div class="dash-grid">
      ${card("sessions",          `<span class="mono">${s.sessions.total}</span>`, `${s.sessions.activeLastHour} active in last hour`)}
      ${card("jobs",              `<span class="mono">${s.jobs.total}</span>`, jobsLineHtml(Object.entries(s.jobs.byStatus ?? {})))}
      ${card("crons",             `<span class="mono">${s.crons.total}</span>`)}
    </div>

    <p class="muted mono" style="margin-top:24px;">Generated ${escapeHtml(s.generatedAt)} · go to <a href="#/subagents">subagents</a>, <a href="#/hooks">hooks</a>, <a href="#/usage">usage</a>, <a href="#/logs">logs</a> for detail.</p>
  `;
}

function statusLineHtml(entries) {
  if (!entries.length) return "";
  return entries.map(([s, n]) => `<span class="s-${s}">${escapeHtml(s)}=${n}</span>`).join("  ");
}
function harnessLineHtml(entries) {
  if (!entries.length) return `<span class="muted mono">—</span>`;
  return `<span class="mono">${entries.map(([h, n]) => `${escapeHtml(h)}=${n}`).join("  ")}</span>`;
}
function topEventsHtml(entries) {
  if (!entries.length) return `<span class="muted mono">—</span>`;
  return `<div class="mono" style="font-size:11px;line-height:1.7">${entries.map(([e, n]) => `${escapeHtml(e)} <span class="muted">${n}</span>`).join("<br/>")}</div>`;
}
function jobsLineHtml(entries) {
  if (!entries.length) return "";
  return entries.map(([s, n]) => `${escapeHtml(s)}=${n}`).join("  ");
}
