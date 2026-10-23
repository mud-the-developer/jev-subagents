import { styles } from './styles.js';
const token = Object.freeze({ id: 'jev.task-review.v1', local: false });
function el(tag, text = '', cls = '') { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; }

/** Exact approval through scoped services; no Electron/Node/global Pi API or remote assets. */
export async function mount(root, host) {
  host.signal.throwIfAborted();
  const context = Object.freeze({ value: () => undefined, get abortSignal() { return host.signal; } });
  const cleanupContext = Object.freeze({ value: () => undefined });
  const style = el('style'); style.textContent = styles + '\n.studio{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.review-grid{grid-template-columns:1fr}.review-grid .source{font-size:12px;max-height:300px}.review-summary{margin-bottom:18px}.review-summary .check{min-width:0}.review-summary pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;margin:6px 0}.risk-list{margin:8px 0 0;padding-left:19px;font-size:12px;color:var(--muted)}.risk-list li{margin-top:5px}.approve-risks{padding:0;margin:12px 0}.task-title{overflow-wrap:anywhere}.review-grid .card{animation:none}';
  const view = el('main', '', 'studio');
  view.dataset.theme = (host.theme?.mode ?? host.theme?.colorScheme) === 'light' ? 'light' : 'dark';
  const shell = el('div', '', 'shell'), hero = el('header', '', 'hero'), heading = el('div');
  const title = el('h1'); title.append(el('span', 'Before execution, '), el('span', 'one clear approval.', 'title-accent'));
  heading.append(title, el('p', 'Review task and role source once, and review execution authority separately. The full JSON is preserved in optional details.'),
    el('p', 'Jump directly: Alt+tab number (Alt+2 when Task Review is the second tab). Ctrl+Alt+B hides or shows the panel; hiding it during review may cancel the request.'));
  hero.append(heading, el('div', '✓', 'orb'));
  const eyebrow = el('div', 'JEV / TASK REVIEW', 'eyebrow'), error = el('div', '', 'error'), content = el('section');
  error.setAttribute('role', 'alert');
  const status = el('div', '', 'sr'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const footer = el('footer', '', 'footer'); footer.append(el('span', 'EXACT SCOPE · SINGLE USE · NO AUTOMATIC RETRY'), el('span', 'Initial setup: separate JEV Setup Studio'));
  shell.append(eyebrow, hero, error, status, content, footer); view.append(shell); root.replaceChildren(style, view);
  let state = { phase: 'idle' }, rendered = '', lease = '', connected = false, pending = false, disposed = false, actionError = '';
  const reviewed = new Set(); let approve, cancel, clock, riskCheck;
  const binding = host.services.open({ services: [token], assertAccess: () => host.signal.throwIfAborted(),
    onError: reason => { actionError = reason instanceof Error ? reason.message : String(reason); controls(); } });
  const service = binding.use(token); let unsubscribe = () => {};
  async function perform(fn) {
    if (pending || disposed) return; pending = true; actionError = ''; controls();
    try { await fn(); } catch (reason) { actionError = reason instanceof Error ? reason.message : String(reason); }
    finally { pending = false; render(); }
  }
  function controls() {
    error.textContent = actionError; error.hidden = !actionError;
    const left = state.phase === 'review' ? state.review.deadline === null ? null : Math.max(0, state.review.deadline - Date.now()) : 0;
    if (clock) clock.textContent = left === null ? 'Waiting for response · no time limit' : `Review deadline: ${Math.ceil(left / 1000)}s · no automatic retry after expiry`;
    if (approve) approve.disabled = !connected || pending || left === 0 || reviewed.size !== 3 || !riskCheck?.checked;
    if (cancel) cancel.disabled = !connected || pending;
  }
  function detail(section) {
    const card = el('article', '', 'card'), details = el('details'), summary = el('summary', section.title);
    const pre = el('pre', section.text, 'source'); pre.tabIndex = 0;
    pre.setAttribute('aria-label', section.title);
    const label = el('label', '', 'ack'), check = el('input'); check.type = 'checkbox'; check.disabled = true;
    label.append(check, el('span', 'I checked to the end and reviewed this source.'));
    const unlock = () => {
      if (details.open && pre.clientHeight > 0 && pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 3) check.disabled = false;
    };
    details.addEventListener('toggle', () => requestAnimationFrame(unlock)); pre.addEventListener('scroll', unlock);
    check.addEventListener('change', () => { if (!check.disabled && check.checked) reviewed.add(section.id); else reviewed.delete(section.id); controls(); });
    details.append(summary, pre, label); card.append(details); return card;
  }
  function render() {
    if (disposed) return;
    const key = state.phase + ':' + (state.phase === 'review' ? state.review.id : '');
    if (key === rendered) { controls(); return; }
    rendered = key; reviewed.clear(); approve = cancel = clock = riskCheck = undefined; content.replaceChildren();
    status.textContent = state.phase === 'review' ? 'Execution approval pending. Review the three source texts.' : state.phase;
    if (state.phase !== 'review') {
      const empty = el('div', '', 'empty');
      empty.append(el('h2', state.phase === 'approved' ? 'Approved this execution only.' : state.phase === 'cancelled' ? 'Cancelled execution approval.' : 'No task is awaiting approval.'),
        el('p', state.phase === 'idle' ? 'Execution review appears here after JEV delegation candidate selection. Opening this screen does not call JEV or a worker.' : state.reason + ' Execution/verification results are available in the original tool output.'));
      content.append(empty); controls(); return;
    }
    const r = state.review, s = r.summary, seconds = s.seconds ?? 120;
    const runtime = seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600}h (${seconds}s)`
      : seconds % 60 === 0 ? `${seconds / 60}m (${seconds}s)` : `${seconds}s`;
    const summary = el('div', '', 'checks review-summary');
    for (const [name, value] of [['Task summary (source below)', s.task], ['Role', s.role], ['Model / thinking', s.model + ' / ' + s.thinking], ['Directory', s.cwd],
      ['Permissions · limits', s.tools.join(', ') + ` · ${s.maxModelCalls === null ? 'Until normal SDK completion · no call limit' : `SDK ${s.maxModelCalls} calls`} · execution after approval ${runtime}`]]) {
      const box = el('div', '', 'check'); if (name === 'Permissions · limits') box.style.gridColumn = '1 / -1';
      box.append(el('span', name), el('strong', value, 'task-title')); summary.append(box);
    }
    const verification = el('aside', '', 'notice'), v = el('details');
    v.append(el('summary', s.verification.startsWith('{') || s.verification.startsWith('Exact verification command') ? 'Separate verification command · expand exact command/argv' : 'No separate verification · result is unverified'), el('pre', s.verification, 'source'));
    verification.append(v);
    const notice = el('aside', '', 'notice'), warnings = el('div'), list = el('ul', '', 'risk-list');
    warnings.append(el('strong', 'Boundaries to know before approval')); for (const risk of r.risks) list.append(el('li', risk)); warnings.append(list); notice.append(warnings);
    const toggle = el('button', 'Expand / collapse all source', 'btn'); toggle.type = 'button';
    const grid = el('div', '', 'grid review-grid'); for (const section of r.sections) grid.append(detail(section));
    toggle.addEventListener('click', () => {
      const entries = [...grid.querySelectorAll('details')], open = entries.some(entry => !entry.open);
      for (const entry of entries) entry.open = open;
    });
    const technical = el('details', '', 'notice'), technicalSummary = el('summary', 'Technical details · full exact JSON (optional)');
    technical.append(technicalSummary, el('pre', r.packet, 'source')); technical.querySelector('pre').tabIndex = 0;
    const bar = el('div', '', 'reviewbar'), barText = el('div'); clock = el('span', '', 'clock');
    const ack = el('label', '', 'ack approve-risks'); riskCheck = el('input'); riskCheck.type = 'checkbox';
    ack.append(riskCheck, el('span', 'I accept the permissions, costs, limits, and lack of rollback above, and approve this exact execution only.'));
    riskCheck.addEventListener('change', controls); barText.append(clock, ack, el('p', 'All three source reviews and consent are required for approval. Ctrl+Enter does not approve.'));
    const actions = el('div', '', 'actions'); cancel = el('button', 'Cancel · do not execute', 'btn danger'); cancel.type = 'button';
    approve = el('button', 'Approve reviewed execution', 'btn primary'); approve.type = 'button';
    cancel.addEventListener('click', () => perform(() => service.cancel({ lease }, context)));
    approve.addEventListener('click', () => {
      controls(); if (approve.disabled || state.phase !== 'review') return;
      const current = state.review;
      void perform(() => service.decide({ lease, id: current.id, packet: current.packet, reviewed: [...reviewed], accepted: true }, context));
    });
    actions.append(cancel, approve); bar.append(barText, actions); content.append(summary, verification, notice, toggle, grid, technical, bar); controls();
  }
  const onKey = event => { if (event.key === 'Escape' && state.phase === 'review' && connected && !pending) {
    event.preventDefault(); void perform(() => service.cancel({ lease }, context));
  } };
  view.addEventListener('keydown', onKey);
  const clockTimer = setInterval(controls, 250), heartbeat = setInterval(() => {
    if (connected && !disposed) void service.heartbeat({ lease }, context).catch(reason => {
      connected = false; actionError = reason instanceof Error ? reason.message : String(reason); controls();
    });
  }, 1000);
  function dispose() {
    if (disposed) return;
    if (state.phase === 'review' && lease) void service.cancel({ lease }, cleanupContext).catch(() => {});
    disposed = true; connected = false; clearInterval(clockTimer); clearInterval(heartbeat); unsubscribe();
    view.removeEventListener('keydown', onKey); host.signal.removeEventListener('abort', dispose);
    void binding.dispose(cleanupContext).catch(() => {}); root.replaceChildren();
  }
  host.signal.addEventListener('abort', dispose, { once: true }); render();
  try {
    await binding.ready(context); host.signal.throwIfAborted(); lease = (await service.attach({}, context)).lease; connected = true;
    unsubscribe = service.state.subscribe(next => { state = next; render(); }); if (service.state.value) state = service.state.value; render();
  } catch (reason) { dispose(); throw reason; }
  return dispose;
}
