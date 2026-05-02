// Subagent create modal — kicks off a POST /subagents from the UI.

import { escapeHtml, store, toast } from "/ui/app.js";

const PROVIDERS = ["claude", "codex", "glm", "opencode"];

export function openCreateModal({ sessions, defaultSessionId, onCreated }) {
  let modal = document.getElementById("create-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "create-modal";
    modal.className = "modal-backdrop hidden";
    document.body.appendChild(modal);
  }
  const saved = store.get("create.last", {});
  const sid = defaultSessionId ?? saved.aiSessionId ?? sessions[0]?.id ?? "";
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header>
        <h2>New subagent</h2>
        <button class="close" aria-label="close">×</button>
      </header>
      <form id="cm-form">
        <div class="form-row">
          <label>parent session</label>
          <select name="aiSessionId" required>
            ${sessions.map((s) => `
              <option value="${escapeHtml(s.id)}" ${s.id === sid ? "selected" : ""}>
                ${escapeHtml(s.name ?? s.id.slice(0, 8))} · ${escapeHtml(s.provider)}
              </option>
            `).join("")}
          </select>
        </div>
        <div class="form-row">
          <label>provider</label>
          <select name="provider">
            <option value="">(none — required if not plan-only)</option>
            ${PROVIDERS.map((p) => `<option value="${p}" ${p === (saved.provider ?? "glm") ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
        <div class="form-row">
          <label>title</label>
          <input name="title" required maxlength="120" placeholder="short label" value="${escapeHtml(saved.title ?? "")}"/>
        </div>
        <div class="form-row">
          <label>prompt</label>
          <textarea name="prompt" rows="8" required placeholder="what should the subagent do?">${escapeHtml(saved.prompt ?? "")}</textarea>
        </div>
        <details class="advanced">
          <summary>advanced</summary>
          <div class="form-row">
            <label>cwd</label>
            <input name="cwd" placeholder="(defaults to parent's cwd)" value="${escapeHtml(saved.cwd ?? "")}"/>
          </div>
          <div class="form-row">
            <label>effort</label>
            <select name="effort">
              <option value="">(default)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>
          <div class="form-row">
            <label>max attempts</label>
            <input name="maxAttempts" type="number" min="1" max="10" value="${escapeHtml(saved.maxAttempts ?? 2)}"/>
          </div>
          <div class="form-row">
            <label>timeout (seconds)</label>
            <input name="timeoutSeconds" type="number" min="60" max="86400" value="${escapeHtml(saved.timeoutSeconds ?? 1200)}"/>
          </div>
          <div class="form-row inline">
            <label><input type="checkbox" name="planOnly"/> plan-only (don't dispatch yet)</label>
          </div>
          <div class="form-row inline">
            <label><input type="checkbox" name="notifySupervisor" checked/> notify supervisor on completion</label>
          </div>
        </details>
        <footer>
          <button type="button" class="cancel">cancel</button>
          <button type="submit" class="primary">create + dispatch</button>
        </footer>
      </form>
    </div>
  `;

  modal.classList.remove("hidden");
  const close = () => modal.classList.add("hidden");
  modal.querySelector(".close").addEventListener("click", close);
  modal.querySelector(".cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  const escHandler = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);

  // Toggle the submit button label based on planOnly.
  const planOnlyChk = modal.querySelector('[name="planOnly"]');
  const submitBtn = modal.querySelector('button.primary');
  planOnlyChk.addEventListener("change", () => {
    submitBtn.textContent = planOnlyChk.checked ? "stage (no dispatch)" : "create + dispatch";
  });

  modal.querySelector("#cm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.planOnly = !!fd.get("planOnly");
    body.notifySupervisor = !!fd.get("notifySupervisor");
    if (body.maxAttempts) body.maxAttempts = Number(body.maxAttempts);
    if (body.timeoutSeconds) body.timeoutSeconds = Number(body.timeoutSeconds);
    if (!body.provider && !body.planOnly) {
      toast("provider required (or check plan-only)", "error");
      return;
    }
    // Persist non-volatile fields for next time.
    store.set("create.last", {
      aiSessionId: body.aiSessionId,
      provider: body.provider,
      title: body.title,
      prompt: body.prompt,
      cwd: body.cwd,
      maxAttempts: body.maxAttempts,
      timeoutSeconds: body.timeoutSeconds,
    });
    submitBtn.disabled = true;
    submitBtn.textContent = "creating…";
    try {
      const url = body.planOnly ? "/subagents?planOnly=1" : "/subagents";
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? `${r.status}`);
      toast(body.planOnly ? `staged ${(json.id ?? json.subagent?.id ?? "").slice(0, 8)}` : `dispatched ${(json.task?.id ?? json.subagent?.id ?? "").slice(0, 8)}`);
      close();
      onCreated?.();
    } catch (e) {
      toast(e.message, "error");
      submitBtn.disabled = false;
      submitBtn.textContent = body.planOnly ? "stage (no dispatch)" : "create + dispatch";
    }
  });

  // Focus the prompt textarea after a tick.
  setTimeout(() => modal.querySelector('[name="prompt"]')?.focus(), 50);
}
