// ai-sessions console — single-page app.
//
// Vanilla ES modules; no build step. Each view exports `mount(el, ctx)`
// which paints into the content element and returns a cleanup function
// (called when the route changes). Views poll their own data on
// intervals; the router cancels them on unmount.

import { mount as mountSubagents } from "/ui/views/subagents.js";
import { mount as mountSessions  } from "/ui/views/sessions.js";
import { mount as mountHooks     } from "/ui/views/hooks.js";
import { mount as mountUsage     } from "/ui/views/usage.js";
import { mount as mountCrons     } from "/ui/views/crons.js";
import { mount as mountJobs      } from "/ui/views/jobs.js";
import { mount as mountTree      } from "/ui/views/tree.js";
import { mount as mountLogs      } from "/ui/views/logs.js";

const ROUTES = {
  subagents: { mount: mountSubagents, title: "Subagents" },
  sessions:  { mount: mountSessions,  title: "Sessions" },
  hooks:     { mount: mountHooks,     title: "Hooks" },
  usage:     { mount: mountUsage,     title: "Usage" },
  crons:     { mount: mountCrons,     title: "Crons" },
  jobs:      { mount: mountJobs,      title: "Jobs" },
  tree:      { mount: mountTree,      title: "Tree" },
  logs:      { mount: mountLogs,      title: "Logs" },
};

const content = document.getElementById("content");
const drawer  = document.getElementById("drawer");
const drawerBody  = document.getElementById("drawer-body");
const drawerTitle = document.getElementById("drawer-title");

let currentCleanup = null;

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "") || "subagents";
  const [route, ...rest] = h.split("/");
  return { route, params: rest };
}

function setActiveNav(route) {
  document.querySelectorAll("#nav nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function render() {
  const { route, params } = parseHash();
  const def = ROUTES[route] ?? ROUTES.subagents;
  setActiveNav(route in ROUTES ? route : "subagents");
  document.title = `${def.title} · ai-sessions`;
  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error(e); }
    currentCleanup = null;
  }
  content.innerHTML = "";
  const ctx = { params, drawer: openDrawer, closeDrawer };
  try {
    currentCleanup = def.mount(content, ctx);
  } catch (e) {
    content.innerHTML = `<div class="placeholder">view crashed: ${escapeHtml(e?.message ?? String(e))}</div>`;
    console.error(e);
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", () => {
  if (!window.location.hash) window.location.hash = "#/subagents";
  render();
  pingServerMeta();
});

document.getElementById("drawer-close").addEventListener("click", closeDrawer);

// ─── Drawer helpers (any view can call these) ──────────────────────
export function openDrawer({ title, body }) {
  drawerTitle.textContent = title ?? "";
  drawerBody.replaceChildren(body);
  drawer.classList.remove("hidden");
}
export function closeDrawer() {
  drawer.classList.add("hidden");
  drawerBody.replaceChildren();
}

// ─── Server meta (shown in sidebar footer) ─────────────────────────
async function pingServerMeta() {
  try {
    const r = await fetch("/").then((r) => r.json());
    const el = document.getElementById("server-meta");
    el.innerHTML = `
      <div>${escapeHtml(r.name)} · v${escapeHtml(r.version ?? "?")}</div>
      <div class="muted">${escapeHtml(r.git?.shortSha ?? "")} · ${escapeHtml(r.git?.branch ?? "")}</div>
    `;
  } catch {
    // ignore
  }
}

// ─── Shared utilities used by views ────────────────────────────────
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

export function fmtSec(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtAge(iso) {
  if (!iso) return "—";
  return fmtSec(Date.now() - Date.parse(iso));
}

export function fmtAbs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  return d.toLocaleString();
}

export function statusBadge(status) {
  const cls = `s-${status}`;
  return `<span class="badge ${cls}"><span class="dot-status"></span>${escapeHtml(status)}</span>`;
}

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

// Used by views to set up a polling loop with auto-cleanup.
// Returns an unsubscribe function suitable for returning from mount().
export function poll(fn, intervalMs) {
  let cancelled = false;
  let timer = null;
  const tick = async () => {
    if (cancelled) return;
    try {
      await fn();
    } catch (e) {
      console.error(e);
    }
    if (!cancelled) timer = setTimeout(tick, intervalMs);
  };
  tick();
  // surface the latest poll time in the sidebar footer
  const footer = document.getElementById("last-poll");
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!cancelled && footer) {
      footer.textContent = `polled ${fmtSec(Date.now() - startedAt)}`;
    }
  }, 1000);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    clearInterval(heartbeat);
    if (footer) footer.textContent = "";
  };
}

// LocalStorage helpers — views remember their last filters across
// reloads. Keep keys namespaced so we don't collide with anything.
const LS_PREFIX = "ais.";
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); }
    catch { /* ignore quota */ }
  },
};
