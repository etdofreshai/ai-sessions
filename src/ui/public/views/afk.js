// AFK quick-start panel — compose an /afk Telegram prompt with the
// provider mix preview, then either copy it for pasting into Telegram
// or POST it directly as a turn into a chosen supervisor session.

import { escapeHtml, getJSON, store, toast } from "/ui/app.js";

const ROTATION = ["G", "G", "C", "G", "G", "C", "G", "G", "C", "R"];
const ROT_NAME = { G: "glm", C: "codex", R: "claude" };

export function mount(root) {
  const saved = store.get("afk.last", {});
  root.innerHTML = `
    <div class="view-header">
      <h1>AFK quick-start</h1>
      <div class="actions"></div>
    </div>

    <p class="muted" style="max-width:680px;">
      Compose an <code>/afk</code> prompt for a long-horizon job. The
      generated text follows the AFK skill format (until · parallelism
      · max-hours · overrides · description). Send it from the supervisor
      session you want to drive the loop — paste into Telegram, or POST
      directly as a turn.
    </p>

    <form id="afk-form" class="afk-form">
      <div class="form-row">
        <label>until: condition</label>
        <input name="until" required placeholder="every phase in master.md is checked off and the build passes" value="${escapeHtml(saved.until ?? "")}"/>
      </div>
      <div class="form-row">
        <label>work description (one paragraph; reads like a paragraph in your /afk message)</label>
        <textarea name="desc" rows="5" required placeholder="Port Wolfenstein 3D from original DOS C to modern C following the plan in /repo/master.md. Codex on rendering / I/O; GLM on translations; Claude reviews every 5–7 chunks.">${escapeHtml(saved.desc ?? "")}</textarea>
      </div>
      <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div>
          <label>parallelism</label>
          <input name="parallelism" type="number" min="1" max="8" value="${escapeHtml(saved.parallelism ?? 2)}"/>
        </div>
        <div>
          <label>max-hours</label>
          <input name="maxHours" type="number" min="1" max="48" value="${escapeHtml(saved.maxHours ?? 10)}"/>
        </div>
        <div>
          <label>max-iterations (optional)</label>
          <input name="maxIters" type="number" min="0" placeholder="(none)" value="${escapeHtml(saved.maxIters ?? "")}"/>
        </div>
      </div>
      <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div>
          <label>override glm (%)</label>
          <input name="ovGlm" type="number" min="0" max="200" placeholder="(default 60)" value="${escapeHtml(saved.ovGlm ?? "")}"/>
        </div>
        <div>
          <label>override codex (%)</label>
          <input name="ovCodex" type="number" min="0" max="200" placeholder="(default 30)" value="${escapeHtml(saved.ovCodex ?? "")}"/>
        </div>
        <div>
          <label>override claude (%)</label>
          <input name="ovClaude" type="number" min="0" max="200" placeholder="(default 10)" value="${escapeHtml(saved.ovClaude ?? "")}"/>
        </div>
      </div>
      <div class="form-row">
        <label>send to supervisor session (optional)</label>
        <select name="supervisorId">
          <option value="">— don't send, just generate the text —</option>
        </select>
      </div>
    </form>

    <h3 class="section-h">rotation preview (next 10 dispatch slots)</h3>
    <div class="rotation-strip" id="rot-strip"></div>

    <h3 class="section-h">generated /afk message</h3>
    <pre class="response" id="afk-out"></pre>
    <div class="action-row">
      <button id="afk-copy" type="button">copy</button>
      <button id="afk-send" type="button" class="primary">send as turn →</button>
    </div>
  `;

  // Populate supervisor session dropdown.
  getJSON("/sessions").then((sessions) => {
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const sel = root.querySelector('[name="supervisorId"]');
    sel.innerHTML += sessions.map((s) =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name ?? s.id.slice(0,8))} · ${escapeHtml(s.provider)}</option>`
    ).join("");
    if (saved.supervisorId) sel.value = saved.supervisorId;
  }).catch(() => {});

  const form = root.querySelector("#afk-form");
  const out = root.querySelector("#afk-out");
  const strip = root.querySelector("#rot-strip");

  const update = () => {
    const fd = new FormData(form);
    const o = Object.fromEntries(fd.entries());
    store.set("afk.last", o);
    out.textContent = compose(o);
    strip.innerHTML = rotationPreview(o);
  };
  form.addEventListener("input", update);
  update();

  root.querySelector("#afk-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.textContent);
      toast("copied to clipboard");
    } catch { toast("copy failed", "error"); }
  });

  root.querySelector("#afk-send").addEventListener("click", async () => {
    const fd = new FormData(form);
    const o = Object.fromEntries(fd.entries());
    if (!o.supervisorId) {
      toast("pick a supervisor session first", "error");
      return;
    }
    const text = compose(o);
    try {
      // Look up the AiSession's provider/sessionId, then POST a run.
      const ai = await getJSON(`/sessions/${encodeURIComponent(o.supervisorId)}`);
      const r = await fetch(`/providers/${encodeURIComponent(ai.provider)}/runs?stream=0`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aiSessionId: o.supervisorId,
          prompt: text,
          cwd: ai.cwd,
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`${r.status}: ${err.slice(0, 240)}`);
      }
      toast("sent to supervisor — watch /subagents for activity");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  return () => {};
}

function compose(o) {
  const overrides = [];
  if (o.ovGlm)    overrides.push(`glm=${o.ovGlm}`);
  if (o.ovCodex)  overrides.push(`codex=${o.ovCodex}`);
  if (o.ovClaude) overrides.push(`claude=${o.ovClaude}`);
  const lines = [
    `/afk until: ${o.until || "<until condition>"}`,
  ];
  const second = [];
  if (o.parallelism) second.push(`parallelism ${o.parallelism}`);
  if (o.maxHours)    second.push(`max-hours ${o.maxHours}`);
  if (o.maxIters)    second.push(`max-iterations ${o.maxIters}`);
  if (overrides.length) second.push(`overrides: ${overrides.join(",")}`);
  if (second.length) lines.push(`     ${second.join(" ")}`);
  if (o.desc) lines.push(`     ${o.desc.replace(/\n+/g, " ").trim()}`);
  return lines.join("\n");
}

function rotationPreview(o) {
  const weights = computeWeights(o);
  const slots = layoutRotation(weights);
  return slots.map((tag, i) => {
    const name = ROT_NAME[tag] ?? "?";
    return `<span class="slot s-${name}">${i + 1}<small>${name}</small></span>`;
  }).join("");
}

function computeWeights(o) {
  // Defaults: 6/3/1. Overrides are absolute percents; we normalize.
  let g = Number(o.ovGlm)    || 60;
  let c = Number(o.ovCodex)  || 30;
  let r = Number(o.ovClaude) || 10;
  // If all three were explicitly zeroed, fall back to defaults.
  if (g + c + r === 0) { g = 60; c = 30; r = 10; }
  const total = g + c + r;
  return { g: g / total, c: c / total, r: r / total };
}

function layoutRotation(w) {
  // 10 slots assigned via the largest-remainder method. Stable order:
  // GLM first, Codex second, Claude last (review).
  const slots = 10;
  const raw = { G: w.g * slots, C: w.c * slots, R: w.r * slots };
  const floors = { G: Math.floor(raw.G), C: Math.floor(raw.C), R: Math.floor(raw.R) };
  let remaining = slots - (floors.G + floors.C + floors.R);
  const remainders = [
    ["G", raw.G - floors.G],
    ["C", raw.C - floors.C],
    ["R", raw.R - floors.R],
  ].sort((a, b) => b[1] - a[1]);
  for (const [k] of remainders) {
    if (remaining-- <= 0) break;
    floors[k]++;
  }
  // Distribute G as a base, sprinkle C every floor(slots/Ccount) steps,
  // and R last to mimic the "G G C G G C G G C R" feel.
  const out = new Array(slots).fill("G");
  // Fill ratios: place C and R at evenly-spaced slot indices, working
  // backwards from the end so R lands last and Cs are distributed.
  const place = (tag, count) => {
    if (!count) return;
    const step = Math.max(1, Math.floor(slots / count));
    let idx = slots - 1;
    let placed = 0;
    while (placed < count && idx >= 0) {
      if (out[idx] === "G") {
        out[idx] = tag;
        placed++;
      }
      idx -= step;
      if (idx < 0 && placed < count) {
        // wrap around in case of odd spacing
        idx = slots - 1 - placed;
      }
    }
  };
  // R first so it claims the last available slot.
  place("R", floors.R);
  place("C", floors.C);
  return out;
}
