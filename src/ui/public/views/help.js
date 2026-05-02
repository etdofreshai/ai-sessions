// Help — keyboard shortcuts + a one-line description of each view.
// Loaded once; no polling.

export function mount(root) {
  root.innerHTML = `
    <div class="view-header">
      <h1>Help</h1>
      <div class="actions"></div>
    </div>

    <section class="help-section">
      <h2>views</h2>
      <ul>
        <li><strong>Subagents</strong> — every delegated work unit. Default landing. Click a row for the drawer.</li>
        <li><strong>Sessions</strong> — every AiSession. Click "open →" for the session detail page (transcript + subagents + actions).</li>
        <li><strong>Hooks</strong> — tail of every PreToolUse / PostToolUse / Stop / SessionStart / Notification event the harness has logged.</li>
        <li><strong>Usage</strong> — provider 5h / 7d / monthly bars. The white tick is the linear time-target; the AFK eligibility rule is "usedPct ≤ target".</li>
        <li><strong>Crons</strong> — scheduled wake-ups. AFK heartbeats and cap-resume crons live here.</li>
        <li><strong>Jobs</strong> — long-running shell jobs (deploys, batch curls, etc).</li>
        <li><strong>Tree</strong> — for one supervisor, render its subagents as a layered dependency graph. Click a node to drill in.</li>
        <li><strong>Logs</strong> — server stdout/stderr tail (in-memory ring buffer of 4000 lines). One-click filter for [subagents] only.</li>
        <li><strong>AFK</strong> — quick-start panel. Compose an /afk prompt with provider mix preview before sending it to Telegram.</li>
      </ul>
    </section>

    <section class="help-section">
      <h2>shortcuts</h2>
      <ul class="kbd-list">
        <li><kbd>Esc</kbd> — close drawer / modal</li>
        <li><kbd>click</kbd> a row — open drawer</li>
        <li><kbd>click</kbd> empty content — close drawer</li>
        <li><kbd>?</kbd> — open this help page</li>
        <li><kbd>g</kbd> then a letter — navigate</li>
      </ul>
      <p class="muted mono" style="margin:8px 0 4px;">navigation chords:</p>
      <ul class="kbd-list">
        <li><kbd>g</kbd><kbd>d</kbd> dashboard · <kbd>g</kbd><kbd>s</kbd> subagents · <kbd>g</kbd><kbd>S</kbd> sessions</li>
        <li><kbd>g</kbd><kbd>h</kbd> hooks · <kbd>g</kbd><kbd>u</kbd> usage · <kbd>g</kbd><kbd>c</kbd> crons · <kbd>g</kbd><kbd>j</kbd> jobs</li>
        <li><kbd>g</kbd><kbd>t</kbd> tree · <kbd>g</kbd><kbd>T</kbd> timeline · <kbd>g</kbd><kbd>r</kbd> runs · <kbd>g</kbd><kbd>l</kbd> logs · <kbd>g</kbd><kbd>a</kbd> afk</li>
      </ul>
    </section>

    <section class="help-section">
      <h2>concepts</h2>
      <ul>
        <li><strong>Subagent (this UI)</strong> = a row in <code>sub_agent_tasks</code>. Durable, has dependencies, retry budget, timeout, response.</li>
        <li><strong>Sub-agent (internal)</strong> = the runtime row in <code>sub_agents</code>. The thing that actually owns the provider session and routes hooks. Each running subagent above has one of these.</li>
        <li><strong>Status flow</strong>: <code>created</code> → <code>running</code> → (<code>completed</code> | <code>failed</code> | <code>merge_failed</code> | <code>cancelled</code>). Stale running rows auto-fail or auto-retry on the server's 30s tick.</li>
        <li><strong>Eligibility (AFK)</strong>: a provider is eligible if usedPct ≤ time-proportional target on every window. Rotation default: 6 GLM, 3 Codex, 1 Claude (review) per 10 chunks.</li>
        <li><strong>Effort</strong>: low for most chunks; medium for "needs a little thought"; high only for planning, review, bug-fix, hard semantic translations.</li>
      </ul>
    </section>

    <section class="help-section">
      <h2>endpoints</h2>
      <ul>
        <li><code>GET /</code> — server meta</li>
        <li><code>GET /openapi.json</code> — machine-readable API</li>
        <li><code>GET /sessions</code> · <code>GET /sessions/:id</code></li>
        <li><code>POST /subagents</code> · <code>?planOnly=1</code></li>
        <li><code>GET /subagents</code> · <code>?aiSessionId=&status=&includeDeleted=1</code></li>
        <li><code>GET /subagents/runnable?aiSessionId=</code></li>
        <li><code>GET/PATCH/DELETE /subagents/:id</code></li>
        <li><code>GET /subagents/:id/{events,dependencies}</code></li>
        <li><code>POST /subagents/:id/{dispatch,cancel,complete,fail,merge-failed,dependencies}</code></li>
        <li><code>GET /hooks · /usage · /crons · /jobs · /logs</code></li>
      </ul>
    </section>
  `;
  return () => {};
}
