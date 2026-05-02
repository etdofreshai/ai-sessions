// Timeline view — subagents on a horizontal time axis. Useful for
// seeing parallelism and duration patterns at a glance.

import {
  escapeHtml, fmtSec, fmtAge, fmtAbs, getJSON, poll, store,
} from "/ui/app.js";

const ROW_H = 22;
const PAD_X = 8;
const PAD_Y = 28;
const LABEL_W = 220;

export function mount(root, ctx) {
  const initialSession = ctx.params?.[0] ?? store.get("timeline.session", "");
  const initialRange   = store.get("timeline.range", "60m");

  root.innerHTML = `
    <div class="view-header">
      <h1>Timeline</h1>
      <div class="actions"><span id="tl-count" class="muted mono"></span></div>
    </div>
    <div class="view-controls">
      <label>session
        <select id="tl-session" style="min-width:280px"></select>
      </label>
      <label>range
        <select id="tl-range">
          <option value="15m">last 15 minutes</option>
          <option value="60m">last hour</option>
          <option value="6h">last 6 hours</option>
          <option value="24h">last 24 hours</option>
          <option value="all">all time</option>
        </select>
      </label>
      <span class="muted">refresh every 6s · click a bar to drill in</span>
    </div>
    <div id="tl-content"><div class="placeholder">choose a session</div></div>
  `;

  const sel = root.querySelector("#tl-session");
  const range = root.querySelector("#tl-range");
  range.value = initialRange;

  getJSON("/sessions").then((sessions) => {
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    sel.innerHTML = `<option value="">— pick a session —</option>` +
      sessions.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name ?? s.id.slice(0,8))} · ${escapeHtml(s.provider)}</option>`).join("");
    if (initialSession) sel.value = initialSession;
    rerender();
  }).catch(() => {});

  sel.addEventListener("change", () => { store.set("timeline.session", sel.value); rerender(); });
  range.addEventListener("change", () => { store.set("timeline.range", range.value); rerender(); });

  let unsubscribe = null;
  const rerender = () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    const sid = sel.value;
    if (!sid) {
      root.querySelector("#tl-content").innerHTML =
        `<div class="placeholder">choose a session</div>`;
      return;
    }
    const tick = async () => {
      try {
        const tasks = await getJSON(`/subagents?aiSessionId=${encodeURIComponent(sid)}&includeDeleted=1`);
        paint(root, tasks, range.value);
      } catch (e) {
        root.querySelector("#tl-content").innerHTML =
          `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      }
    };
    unsubscribe = poll(tick, 6000);
  };

  return () => { if (unsubscribe) unsubscribe(); };
}

function rangeMs(r) {
  switch (r) {
    case "15m": return 15 * 60 * 1000;
    case "60m": return 60 * 60 * 1000;
    case "6h":  return 6 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    default:    return null;
  }
}

function paint(root, tasks, rangeKey) {
  const now = Date.now();
  const winMs = rangeMs(rangeKey);
  const cutoff = winMs ? now - winMs : 0;
  // Only show tasks with at least started (something to draw).
  const visible = tasks
    .filter((t) => t.startedAt || t.createdAt)
    .filter((t) => {
      if (!winMs) return true;
      const end = t.finishedAt ? Date.parse(t.finishedAt) : now;
      return end >= cutoff;
    })
    .sort((a, b) => (a.startedAt ?? a.createdAt ?? "").localeCompare(b.startedAt ?? b.createdAt ?? ""));

  root.querySelector("#tl-count").textContent = `${visible.length} subagents in range`;

  if (!visible.length) {
    root.querySelector("#tl-content").innerHTML =
      `<div class="placeholder">no subagents in this range</div>`;
    return;
  }

  // Compute time bounds.
  let minTs = Infinity;
  let maxTs = now;
  for (const t of visible) {
    const s = Date.parse(t.startedAt ?? t.createdAt);
    const e = t.finishedAt ? Date.parse(t.finishedAt) : now;
    if (!isNaN(s)) minTs = Math.min(minTs, s);
    if (!isNaN(e)) maxTs = Math.max(maxTs, e);
  }
  if (winMs) minTs = Math.max(minTs, now - winMs);
  if (!isFinite(minTs)) minTs = now - 60_000;

  const width = 980;
  const barArea = width - LABEL_W - PAD_X * 2;
  const span = Math.max(1, maxTs - minTs);
  const xOf = (ts) => LABEL_W + PAD_X + ((ts - minTs) / span) * barArea;
  const height = PAD_Y + visible.length * ROW_H + 14;

  // X-axis ticks: 5 evenly-spaced labels.
  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const ts = minTs + (span * i) / 5;
    ticks.push({ ts, x: xOf(ts) });
  }

  const bars = visible.map((t, i) => {
    const start = Date.parse(t.startedAt ?? t.createdAt);
    const end   = t.finishedAt ? Date.parse(t.finishedAt) : now;
    const x1 = xOf(start);
    const x2 = xOf(end);
    const w = Math.max(2, x2 - x1);
    const y = PAD_Y + i * ROW_H;
    const dur = end - start;
    return `
      <g class="tl-row" data-id="${escapeHtml(t.id)}" style="cursor:pointer">
        <text class="tl-label" x="${PAD_X}" y="${y + ROW_H / 2 + 4}">
          ${escapeHtml(t.id.slice(0, 8))} · ${escapeHtml((t.title ?? "").slice(0, 22))}
        </text>
        <rect class="tl-bar s-${escapeHtml(t.status)}"
              x="${x1}" y="${y + 3}" width="${w}" height="${ROW_H - 6}"
              rx="3" ry="3">
          <title>${escapeHtml(t.status)} · ${escapeHtml(t.provider ?? "?")} · ${fmtSec(dur)} · started ${escapeHtml(fmtAbs(t.startedAt ?? t.createdAt))}</title>
        </rect>
        <text class="tl-bartext" x="${x1 + 6}" y="${y + ROW_H / 2 + 4}">
          ${fmtSec(dur)}
        </text>
      </g>
    `;
  }).join("");

  const tickLines = ticks.map((tk) => `
    <line class="tl-tick" x1="${tk.x}" y1="${PAD_Y - 4}" x2="${tk.x}" y2="${height - 6}"/>
    <text class="tl-ticklabel" x="${tk.x}" y="${PAD_Y - 8}" text-anchor="middle">
      ${escapeHtml(new Date(tk.ts).toLocaleTimeString())}
    </text>
  `).join("");

  // "now" marker.
  const nowX = xOf(now);
  const nowMarker = `
    <line class="tl-now" x1="${nowX}" y1="${PAD_Y - 6}" x2="${nowX}" y2="${height - 6}"/>
  `;

  root.querySelector("#tl-content").innerHTML = `
    <svg class="tree-canvas" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      ${tickLines}
      ${bars}
      ${nowMarker}
    </svg>
  `;
  root.querySelectorAll(".tl-row").forEach((g) => {
    g.addEventListener("click", () => {
      window.location.hash = `#/subagents/${g.dataset.id}`;
    });
  });
}
