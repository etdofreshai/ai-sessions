// Tree view — for one supervisor session, render its subagents as a
// dependency graph. Vertical layered layout: tasks with no upstream deps
// land in column 0; each subsequent column is one hop deeper.
//
// SVG hand-rolled (no D3); a topo layering is plenty for the volumes
// AFK loops produce (typically <100 nodes).

import { escapeHtml, fmtAge, getJSON, poll, store } from "/ui/app.js";

const COL_W = 240;
const ROW_H = 64;
const NODE_W = 200;
const NODE_H = 48;
const PAD_X = 24;
const PAD_Y = 24;

export function mount(root, ctx) {
  const initialSession = ctx.params?.[0] ?? store.get("tree.session", "");

  root.innerHTML = `
    <div class="view-header">
      <h1>Tree</h1>
      <div class="actions"><span id="tr-count" class="muted mono"></span></div>
    </div>
    <div class="view-controls">
      <label>session
        <select id="tr-session" style="min-width:280px"></select>
      </label>
      <span class="muted">refresh every 6s · click a node to drill in</span>
    </div>
    <div id="tr-content"><div class="placeholder">choose a session</div></div>
  `;

  const sel = root.querySelector("#tr-session");
  // Populate sessions dropdown.
  getJSON("/sessions").then((sessions) => {
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    sel.innerHTML = `<option value="">— pick a session —</option>` +
      sessions.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name ?? s.id.slice(0,8))} · ${escapeHtml(s.provider)}</option>`).join("");
    if (initialSession) sel.value = initialSession;
    rerender();
  }).catch(() => {});

  sel.addEventListener("change", () => {
    store.set("tree.session", sel.value);
    rerender();
  });

  let unsubscribe = null;
  const rerender = () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    const sid = sel.value;
    if (!sid) {
      root.querySelector("#tr-content").innerHTML =
        `<div class="placeholder">choose a session</div>`;
      return;
    }
    const tick = async () => {
      try {
        const tasks = await getJSON(`/subagents?aiSessionId=${encodeURIComponent(sid)}&includeDeleted=1`);
        const deps = await loadAllDeps(tasks);
        paint(root, tasks, deps);
        root.querySelector("#tr-count").textContent = `${tasks.length} nodes · ${deps.length} edges`;
      } catch (e) {
        root.querySelector("#tr-content").innerHTML =
          `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      }
    };
    unsubscribe = poll(tick, 6000);
  };

  return () => { if (unsubscribe) unsubscribe(); };
}

async function loadAllDeps(tasks) {
  // /subagents/:id/dependencies returns one row per edge from this id.
  // Keep concurrent fetches reasonable; AFK loops rarely exceed 50
  // outstanding tasks at a time.
  const all = await Promise.all(
    tasks.map((t) =>
      getJSON(`/subagents/${t.id}/dependencies`).catch(() => []),
    ),
  );
  const out = [];
  tasks.forEach((t, i) => {
    for (const d of all[i] ?? []) {
      out.push({ from: d.dependsOnTaskId, to: t.id });
    }
  });
  return out;
}

function paint(root, tasks, deps) {
  if (!tasks.length) {
    root.querySelector("#tr-content").innerHTML =
      `<div class="placeholder">no subagents for this session yet</div>`;
    return;
  }
  // Layer assignment: depth = max(depth(parent)) + 1; nodes with no
  // incoming edges land at depth 0.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const incoming = new Map(tasks.map((t) => [t.id, []]));
  const outgoing = new Map(tasks.map((t) => [t.id, []]));
  for (const e of deps) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to).push(e.from);
    outgoing.get(e.from).push(e.to);
  }
  const depth = new Map();
  const compute = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // cycle — shouldn't happen but bail
    seen.add(id);
    const ins = incoming.get(id) ?? [];
    const d = ins.length === 0 ? 0 : Math.max(...ins.map((p) => compute(p, seen) + 1));
    depth.set(id, d);
    return d;
  };
  tasks.forEach((t) => compute(t.id));

  // Group by depth, then sort within column by createdAt for stability.
  const cols = new Map();
  for (const t of tasks) {
    const d = depth.get(t.id) ?? 0;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(t);
  }
  for (const arr of cols.values()) {
    arr.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  const maxDepth = Math.max(0, ...cols.keys());
  const maxRow = Math.max(0, ...[...cols.values()].map((c) => c.length - 1));
  const width = (maxDepth + 1) * COL_W + PAD_X * 2;
  const height = (maxRow + 1) * ROW_H + PAD_Y * 2 + 20;

  const pos = new Map();
  for (const [d, arr] of cols) {
    arr.forEach((t, i) => {
      pos.set(t.id, {
        x: PAD_X + d * COL_W + (COL_W - NODE_W) / 2,
        y: PAD_Y + i * ROW_H,
      });
    });
  }

  const edges = deps.map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return "";
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x,          y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="tree-edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" />`;
  }).join("");

  const nodes = tasks.map((t) => {
    const p = pos.get(t.id);
    if (!p) return "";
    return `
      <g class="tree-node" data-id="${escapeHtml(t.id)}" style="cursor:pointer;">
        <rect class="tree-node-rect s-${escapeHtml(t.status)}"
              x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}"
              rx="6" ry="6" stroke-width="1.5" />
        <text class="tree-node-text" x="${p.x + 10}" y="${p.y + 18}">
          ${escapeHtml((t.title ?? "").slice(0, 28))}
        </text>
        <text class="tree-node-meta" x="${p.x + 10}" y="${p.y + 36}">
          ${escapeHtml(t.id.slice(0, 8))} · ${escapeHtml(t.status)}${t.provider ? " · " + escapeHtml(t.provider) : ""} · msgs ${t.activityCount ?? 0} · ${fmtAge(t.updatedAt)}
        </text>
      </g>
    `;
  }).join("");

  root.querySelector("#tr-content").innerHTML = `
    <svg class="tree-canvas" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      ${edges}
      ${nodes}
    </svg>
  `;
  root.querySelectorAll(".tree-node").forEach((g) => {
    g.addEventListener("click", () => {
      window.location.hash = `#/subagents/${g.dataset.id}`;
    });
  });
}
