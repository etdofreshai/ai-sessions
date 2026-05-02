// Usage view — provider rate-limit windows as bars.
// Eligibility ribbon mirrors the AFK pacing rule: usedPct <= target_pct.

import { escapeHtml, fmtAge, getJSON, poll } from "/ui/app.js";

export function mount(root) {
  root.innerHTML = `
    <div class="view-header">
      <h1>Usage</h1>
      <div class="actions"><span id="us-eligible" class="muted mono"></span></div>
    </div>
    <div class="view-controls"><span class="muted">refresh every 15s</span></div>
    <div id="us-content"></div>
  `;

  const rerender = async () => {
    let usage;
    try {
      usage = await getJSON("/usage");
    } catch (e) {
      root.querySelector("#us-content").innerHTML =
        `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    paint(root, usage);
  };
  return poll(rerender, 15000);
}

function paint(root, usage) {
  // /usage returns a map of provider -> { windows: [{ kind, usedPct,
  // resetAt, openedAt }, ...], lastObservedAt? }. Be defensive about
  // shape — older builds may not include all fields.
  const providers = Object.keys(usage ?? {}).sort();
  if (!providers.length) {
    root.querySelector("#us-content").innerHTML =
      `<div class="placeholder">no usage data</div>`;
    return;
  }
  const eligibleCount = providers.filter((p) => isEligible(usage[p])).length;
  root.querySelector("#us-eligible").textContent =
    `${eligibleCount}/${providers.length} eligible`;

  const html = providers.map((p) => {
    const u = usage[p] ?? {};
    const windows = u.windows ?? [];
    const elig = isEligible(u) ? "eligible" : "gated";
    const eligClass = isEligible(u) ? "s-running" : "s-failed";
    return `
      <section style="margin-bottom:18px;border:1px solid var(--line);border-radius:6px;padding:14px 18px;background:var(--bg-1);">
        <header style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
          <div>
            <strong style="font-family:var(--mono);font-size:14px;color:var(--text)">${escapeHtml(p)}</strong>
            <span class="muted mono" style="margin-left:8px;">${u.lastObservedAt ? "obs " + fmtAge(u.lastObservedAt) : ""}</span>
          </div>
          <span class="badge ${eligClass}">${elig}</span>
        </header>
        ${windows.map((w) => bar(w)).join("") || `<div class="muted mono">no window data</div>`}
      </section>
    `;
  }).join("");
  root.querySelector("#us-content").innerHTML = html;
}

function bar(w) {
  const used = clampPct(w.usedPct);
  const target = clampPct(timeTargetPct(w));
  const over = used > target;
  const cls = used >= 100 ? "over" : (over ? "warn" : "");
  return `
    <div class="bar-row ${cls}">
      <span class="label">${escapeHtml(w.kind ?? "?")}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${used}%"></div>
        <div class="bar-target" style="left:${target}%" title="time target ${target.toFixed(1)}%"></div>
      </div>
      <span class="val">${used.toFixed(1)}% / target ${target.toFixed(1)}%</span>
    </div>
  `;
}

function clampPct(n) {
  if (n == null || isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Number(n)));
}

function timeTargetPct(w) {
  const opened = w.openedAt ? Date.parse(w.openedAt) : null;
  const reset  = w.resetAt  ? Date.parse(w.resetAt)  : null;
  if (!opened || !reset || reset <= opened) return 0;
  const t = (Date.now() - opened) / (reset - opened);
  return Math.max(0, Math.min(1, t)) * 100;
}

function isEligible(u) {
  const ws = u?.windows ?? [];
  if (!ws.length) return true;
  return ws.every((w) => clampPct(w.usedPct) <= clampPct(timeTargetPct(w)));
}
