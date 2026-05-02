// Logs view — streams new log lines via SSE and applies client-side
// filtering. Server keeps a 4000-line ring buffer fed by patched
// console.{log,warn,error}.

import { escapeHtml, store } from "/ui/app.js";

const RENDER_CAP = 3000;

export function mount(root) {
  const filter = store.get("logs.filter", "");
  const onlySubagent = store.get("logs.onlySub", false);
  const autoScroll = store.get("logs.autoScroll", true);

  root.innerHTML = `
    <div class="view-header">
      <h1>Logs</h1>
      <div class="actions">
        <span id="lg-count" class="muted mono"></span>
        <span id="lg-status" class="muted mono"></span>
      </div>
    </div>
    <div class="view-controls">
      <label>filter
        <input id="lg-filter" placeholder="substring" value="${escapeHtml(filter)}" style="width:240px"/>
      </label>
      <label><input type="checkbox" id="lg-onlysub" ${onlySubagent ? "checked" : ""}/> only [subagents]</label>
      <label><input type="checkbox" id="lg-auto" ${autoScroll ? "checked" : ""}/> auto-scroll</label>
      <span class="muted">live · capacity 4000 lines · backfill 500</span>
    </div>
    <div id="lg-tail" class="log-tail"></div>
  `;

  const fIn = root.querySelector("#lg-filter");
  const sChk = root.querySelector("#lg-onlysub");
  const aChk = root.querySelector("#lg-auto");
  const tail = root.querySelector("#lg-tail");
  const statusEl = root.querySelector("#lg-status");
  const countEl = root.querySelector("#lg-count");

  fIn.addEventListener("input", () => {
    store.set("logs.filter", fIn.value);
    repaint();
  });
  sChk.addEventListener("change", () => {
    store.set("logs.onlySub", sChk.checked);
    repaint();
  });
  aChk.addEventListener("change", () => {
    store.set("logs.autoScroll", aChk.checked);
  });

  let lines = [];
  let es = null;
  let connected = false;

  function passes(line) {
    if (sChk.checked && !line.text.includes("[subagents]")) return false;
    const f = fIn.value.trim().toLowerCase();
    if (f && !line.text.toLowerCase().includes(f)) return false;
    return true;
  }

  function classify(line) {
    if (line.text.includes("[subagents]")) return "subagent";
    if (line.level === "error") return "error";
    if (line.level === "warn") return "warn";
    return "";
  }

  function rowHtml(line) {
    const cls = classify(line);
    const ts = line.ts ? new Date(line.ts).toLocaleTimeString() : "";
    return `<div class="log-line ${cls}"><span class="muted">${escapeHtml(ts)}</span> ${escapeHtml(line.text)}</div>`;
  }

  function repaint() {
    const filtered = lines.filter(passes);
    const tailSlice = filtered.slice(-RENDER_CAP);
    tail.innerHTML = tailSlice.map(rowHtml).join("");
    countEl.textContent = `${filtered.length} of ${lines.length}`;
    if (aChk.checked) tail.scrollTop = tail.scrollHeight;
  }

  function append(line) {
    lines.push(line);
    if (lines.length > 4000) lines.splice(0, lines.length - 4000);
    if (passes(line)) {
      const div = document.createElement("div");
      const cls = classify(line);
      const ts = line.ts ? new Date(line.ts).toLocaleTimeString() : "";
      div.className = `log-line ${cls}`;
      div.innerHTML = `<span class="muted">${escapeHtml(ts)}</span> ${escapeHtml(line.text)}`;
      tail.appendChild(div);
      // Keep the visible DOM bounded.
      while (tail.childElementCount > RENDER_CAP) tail.removeChild(tail.firstChild);
      if (aChk.checked) tail.scrollTop = tail.scrollHeight;
    }
    countEl.textContent = `${tail.childElementCount} of ${lines.length}`;
  }

  function connect() {
    statusEl.textContent = "connecting…";
    es = new EventSource("/logs/stream?backfill=500");
    es.onopen = () => {
      connected = true;
      statusEl.textContent = "live";
    };
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        append(line);
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      if (connected) statusEl.textContent = "reconnecting…";
      // EventSource auto-reconnects; nothing else to do.
    };
  }

  connect();
  return () => {
    if (es) es.close();
  };
}
