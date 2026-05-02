// ai-sessions console — single-page app.
//
// Vanilla ES modules; no build step. Each view exports `mount(el, ctx)`
// which paints into the content element and returns a cleanup function
// (called when the route changes). Views poll their own data on
// intervals; the router cancels them on unmount.

import { mount as mountDashboard } from "/ui/views/dashboard.js";
import { mount as mountSubagents } from "/ui/views/subagents.js";
import { mount as mountSessions  } from "/ui/views/sessions.js";
import { mount as mountHooks     } from "/ui/views/hooks.js";
import { mount as mountUsage     } from "/ui/views/usage.js";
import { mount as mountCrons     } from "/ui/views/crons.js";
import { mount as mountJobs      } from "/ui/views/jobs.js";
import { mount as mountTree      } from "/ui/views/tree.js";
import { mount as mountTimeline  } from "/ui/views/timeline.js";
import { mount as mountRuns      } from "/ui/views/runs.js";
import { mount as mountLogs      } from "/ui/views/logs.js";
import { mount as mountSession   } from "/ui/views/session.js";
import { mount as mountHelp      } from "/ui/views/help.js";
import { mount as mountAfk       } from "/ui/views/afk.js";

const ROUTES = {
  dashboard: { mount: mountDashboard, title: "Dashboard" },
  subagents: { mount: mountSubagents, title: "Subagents" },
  sessions:  { mount: mountSessions,  title: "Sessions" },
  session:   { mount: mountSession,   title: "Session" },
  hooks:     { mount: mountHooks,     title: "Hooks" },
  usage:     { mount: mountUsage,     title: "Usage" },
  crons:     { mount: mountCrons,     title: "Crons" },
  jobs:      { mount: mountJobs,      title: "Jobs" },
  tree:      { mount: mountTree,      title: "Tree" },
  timeline:  { mount: mountTimeline,  title: "Timeline" },
  runs:      { mount: mountRuns,      title: "Runs" },
  logs:      { mount: mountLogs,      title: "Logs" },
  afk:       { mount: mountAfk,       title: "AFK" },
  help:      { mount: mountHelp,      title: "Help" },
};

const content = document.getElementById("content");
const drawer  = document.getElementById("drawer");
const drawerBody  = document.getElementById("drawer-body");
const drawerTitle = document.getElementById("drawer-title");

let currentCleanup = null;

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "") || "dashboard";
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
  if (!window.location.hash) window.location.hash = "#/dashboard";
  render();
  pingServerMeta();
});

document.getElementById("drawer-close").addEventListener("click", closeDrawer);

// Escape closes drawer (and the create modal handles its own escape).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!drawer.classList.contains("hidden")) closeDrawer();
  }
});

// ─── Keyboard shortcuts ───────────────────────────────────────────
// vim-ish "g <letter>" for navigation. The first key arms a 1.2s
// window during which the second key dispatches. Skipped when the
// user is typing into an input/textarea/contenteditable.
const SHORTCUTS = {
  d: "dashboard",
  s: "subagents",
  S: "sessions",
  h: "hooks",
  u: "usage",
  c: "crons",
  j: "jobs",
  t: "tree",
  l: "logs",
  T: "timeline",
  r: "runs",
  a: "afk",
  "?": "help",
};
let chordArmed = false;
let chordTimer = null;
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  if (chordArmed) {
    chordArmed = false;
    clearTimeout(chordTimer);
    const route = SHORTCUTS[e.key];
    if (route) {
      e.preventDefault();
      window.location.hash = `#/${route}`;
    }
    return;
  }
  if (e.key === "g") {
    chordArmed = true;
    chordTimer = setTimeout(() => { chordArmed = false; }, 1200);
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    window.location.hash = `#/help`;
  }
});

// Click outside drawer (on the main content) closes it.
document.getElementById("content").addEventListener("click", (e) => {
  // Only close if the click reaches an empty area, not a row click.
  if (e.target.id === "content" && !drawer.classList.contains("hidden")) {
    closeDrawer();
  }
});

// Toast host element.
const toastHost = document.createElement("div");
toastHost.id = "toast-host";
document.body.appendChild(toastHost);

// Wire the sidebar's "enable notifications" button.
window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("notify-toggle");
  if (!btn) return;
  const refreshLabel = () => {
    if (typeof Notification === "undefined") {
      btn.textContent = "notifications n/a";
      btn.disabled = true;
    } else if (Notification.permission === "granted") {
      btn.textContent = "✓ notifications on";
      btn.classList.add("on");
    } else if (Notification.permission === "denied") {
      btn.textContent = "notifications blocked";
      btn.disabled = true;
    } else {
      btn.textContent = "enable notifications";
    }
  };
  refreshLabel();
  btn.addEventListener("click", async () => {
    await enableNotifications();
    refreshLabel();
    toast(Notification.permission === "granted"
      ? "notifications enabled"
      : "permission denied",
      Notification.permission === "granted" ? "success" : "error");
  });
});

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

// Reconnect banner — flips on after consecutive fetch failures and
// flips off as soon as one succeeds. Surfaces transient API outages
// without scaring the user on every blip.
let consecutiveFails = 0;
function setReconnect(state) {
  document.body.classList.toggle("reconnecting", state);
}
export async function getJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
    const json = await r.json();
    if (consecutiveFails > 0) {
      consecutiveFails = 0;
      setReconnect(false);
    }
    return json;
  } catch (e) {
    consecutiveFails++;
    if (consecutiveFails >= 2) setReconnect(true);
    throw e;
  }
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

// Toast: tiny floating notification used for action confirmations.
// Variant defaults to neutral; pass "error" or "success" for color.
export function toast(message, variant = "") {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${variant}`;
  el.textContent = String(message ?? "");
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.2s, transform 0.2s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 220);
  }, variant === "error" ? 5200 : 2400);
}

// ─── Browser notifications ────────────────────────────────────────
// Watches /subagents on a 5s interval (independent of any view's
// polling), tracks status transitions, and fires a desktop notification
// when a subagent flips to a terminal state. Useful for overnight AFK
// runs — you can leave the tab in the background and get pinged on
// completions/failures.
const lastStatus = new Map();
let notifyEnabled = (typeof Notification !== "undefined") && Notification.permission === "granted";

export async function enableNotifications() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") {
    notifyEnabled = true;
    return true;
  }
  if (Notification.permission === "denied") return false;
  const r = await Notification.requestPermission();
  notifyEnabled = r === "granted";
  return notifyEnabled;
}

const TERMINAL_LABEL = {
  completed: "✅ completed",
  failed: "❌ failed",
  merge_failed: "⚠️ merge failed",
  cancelled: "🚫 cancelled",
};

async function watchTerminalTransitions() {
  try {
    const rows = await fetch("/subagents?limit=200").then((r) => r.ok ? r.json() : []);
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const prev = lastStatus.get(r.id);
      lastStatus.set(r.id, r.status);
      // Only fire if we've seen the row before (skip first poll's
      // historical terminal rows) and it just transitioned to terminal.
      if (prev && prev !== r.status && TERMINAL_LABEL[r.status] && prev === "running") {
        if (notifyEnabled) {
          const n = new Notification(`${TERMINAL_LABEL[r.status]} · ${r.title ?? r.id.slice(0,8)}`, {
            body: `${r.provider ?? ""} · ${r.id.slice(0, 8)}`,
            tag: r.id,
          });
          n.onclick = () => {
            window.focus();
            window.location.hash = `#/subagents/${r.id}`;
          };
        }
      }
    }
  } catch { /* network blip */ }
}

// Tick every 5s globally, regardless of the active view.
setInterval(watchTerminalTransitions, 5000);
// Prime the lastStatus map so we don't fire on first page load.
setTimeout(watchTerminalTransitions, 1500);

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
