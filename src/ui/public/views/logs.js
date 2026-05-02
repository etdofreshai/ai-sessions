// Logs view — tails the in-memory log buffer fed by patched
// console.log/warn/error.

import { escapeHtml, fmtAge, getJSON, poll, store } from "/ui/app.js";

export function mount(root) {
  const filter = store.get("logs.filter", "");
  const onlySubagent = store.get("logs.onlySub", false);
  const autoScroll = store.get("logs.autoScroll", true);

  root.innerHTML = `
    <div class="view-header">
      <h1>Logs</h1>
      <div class="actions"><span id="lg-count" class="muted mono"></span></div>
    </div>
    <div class="view-controls">
      <label>filter
        <input id="lg-filter" placeholder="substring" value="${escapeHtml(filter)}" style="width:240px"/>
      </label>
      <label><input type="checkbox" id="lg-onlysub" ${onlySubagent ? "checked" : ""}/> only [subagents]</label>
      <label><input type="checkbox" id="lg-auto" ${autoScroll ? "checked" : ""}/> auto-scroll</label>
      <span class="muted">refresh every 3s · capacity 4000 lines</span>
    </div>
    <div id="lg-tail" class="log-tail"></div>
  `;

  const fIn = root.querySelector("#lg-filter");
  const sChk = root.querySelector("#lg-onlysub");
  const aChk = root.querySelector("#lg-auto");
  const tail = root.querySelector("#lg-tail");
  fIn.addEventListener("input", () => store.set("logs.filter", fIn.value));
  sChk.addEventListener("change", () => store.set("logs.onlySub", sChk.checked));
  aChk.addEventListener("change", () => store.set("logs.autoScroll", aChk.checked));

  const rerender = async () => {
    let res;
    try {
      res = await getJSON("/logs?limit=2000");
    } catch (e) {
      tail.innerHTML = `<div class="placeholder">${escapeHtml(e.message)}</div>`;
      return;
    }
    let lines = res.lines ?? [];
    if (sChk.checked) lines = lines.filter((l) => l.text.includes("[subagents]"));
    if (fIn.value.trim()) {
      const f = fIn.value.toLowerCase();
      lines = lines.filter((l) => l.text.toLowerCase().includes(f));
    }
    root.querySelector("#lg-count").textContent = `${lines.length} of ${res.size}`;
    tail.innerHTML = lines.map((l) => {
      const cls = l.text.includes("[subagents]") ? "subagent"
        : l.level === "error" ? "error"
        : l.level === "warn"  ? "warn"
        : "";
      const ts = l.ts ? new Date(l.ts).toLocaleTimeString() : "";
      return `<div class="log-line ${cls}"><span class="muted">${escapeHtml(ts)}</span> ${escapeHtml(l.text)}</div>`;
    }).join("");
    if (aChk.checked) tail.scrollTop = tail.scrollHeight;
  };
  return poll(rerender, 3000);
}
