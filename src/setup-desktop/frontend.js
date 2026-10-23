import { styles } from './styles.js';
const token = Object.freeze({ id: 'jev.setup-studio.v1', local: false });
const roles = {
  scout: { title: 'Scout', subtitle: 'Read-only investigation · find entry points', icon: '⌕', model: 'gpt-5.6-luna', thinking: 'low' },
  worker: { title: 'Worker', subtitle: 'Small, clear implementation · focused checks', icon: '⌘', model: 'gpt-5.6-luna', thinking: 'low' },
  worker_strong: { title: 'Worker Strong', subtitle: 'Difficult implementation · deep reasoning', icon: '◇', model: 'gpt-6-astra', thinking: 'max' },
  sol: { title: 'Sol', subtitle: 'Fixed-model worker · no SoL-Pi integration', icon: '✦', model: 'gpt-5.6-sol', thinking: 'low' },
};
function el(tag, text = '', className = '') { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; }
function button(text, className, fn) { const b = el('button', text, 'btn ' + className); b.type = 'button'; b.onclick = fn; return b; }
function metadata(profile) {
  const name = profile.file.split(/[\\/]/).at(-1)?.replace(/\.md$/, '') ?? 'profile';
  const info = roles[name] ?? { title: name, subtitle: 'Profile to approve', icon: '◇' };
  const model = profile.content.match(/^model:\s*"?([^"\n]+)"?$/m)?.[1]?.trim() ?? 'Not specified';
  const thinking = profile.content.match(/^thinking:\s*(.+)$/m)?.[1]?.trim() ?? 'Not specified';
  return { ...info, model, thinking };
}

/** Plain browser module: scoped services only; no Node, Electron, remote scripts or fonts. */
export async function mount(root, host) {
  host.signal.throwIfAborted();
  const context = Object.freeze({ value: () => undefined, get abortSignal() { return host.signal; } });
  const cleanupContext = Object.freeze({ value: () => undefined });
  const style = el('style'); style.textContent = styles;
  const view = el('main', '', 'studio');
  const mode = host.theme?.mode ?? host.theme?.colorScheme;
  view.dataset.theme = mode === 'light' ? 'light' : 'dark';
  const shell = el('div', '', 'shell');
  const eyebrow = el('div', '', 'eyebrow'); eyebrow.append(el('span', '', 'spark'), el('span', 'JEV / SETUP STUDIO'));
  const hero = el('header', '', 'hero');
  const heading = el('div'); const h1 = el('h1'); h1.append(el('span', 'Start the work, '), el('span', 'with clarity.', 'title-accent'));
  heading.append(h1, el('p', 'Review fixed roles at a glance, verify the exact contents, then prepare. Execution and paid calls have not started.'));
  hero.append(heading, el('div', '✦', 'orb'));
  const steps = el('nav', '', 'steps'); steps.setAttribute('aria-label', 'Setup progress');
  const toolbar = el('div', '', 'toolbar'), actions = el('div', '', 'actions');
  const start = button('Start profile setup  ↗', 'primary', () => perform(() => service.start({ operation: 'setup', lease }, context)));
  const diagnose = button('Run free diagnostics', '', () => perform(() => service.start({ operation: 'status', lease }, context)));
  const cancel = button('Cancel', 'danger', () => perform(() => service.cancel({}, context)));
  actions.append(start, diagnose, cancel);
  toolbar.append(actions, el('span', '●  No automatic execution · no automatic charges', 'badge safe'));
  const notice = el('aside', '', 'notice'); const noticeText = el('div');
  noticeText.append(el('strong', 'Profile creation ≠ model execution'), el('p', 'Existing files, keys, and default models are preserved. Authentication, model access, and quotas are checked separately; a Sol profile alone does not activate SoL-Pi.'));
  notice.append(el('span', '◎', 'notice-icon'), noticeText);
  const error = el('div', '', 'error'); error.setAttribute('role', 'alert');
  const status = el('div', '', 'sr'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = el('section');
  const footer = el('footer', '', 'footer'); footer.append(el('span', 'LOCAL FIRST · EXACT REVIEW · NO AUTOMATIC RETRY'), el('span', 'Partial Windows support · v1 is not fully complete'));
  shell.append(eyebrow, hero, steps, toolbar, notice, error, status, content, footer); view.append(shell); root.replaceChildren(style, view);

  let state = { phase: 'idle' }, connected = false, pending = false, disposed = false, actionError = '', reviewId = '', lease = '';
  const reviewed = new Set();
  const binding = host.services.open({ services: [token], assertAccess: () => host.signal.throwIfAborted(),
    onError: reason => { actionError = reason instanceof Error ? reason.message : String(reason); render(); } });
  const service = binding.use(token);
  let unsubscribe = () => {};
  const busy = () => ['checking', 'review', 'creating'].includes(state.phase);
  async function perform(fn) {
    if (pending || disposed) return;
    pending = true; actionError = ''; renderControls();
    try { await fn(); } catch (reason) { actionError = reason instanceof Error ? reason.message : String(reason); }
    finally { pending = false; render(); }
  }
  function renderControls() {
    start.disabled = !connected || pending || busy(); diagnose.disabled = start.disabled;
    cancel.hidden = !busy(); cancel.disabled = pending;
  }
  function card(profile, preview = false) {
    const m = preview ? profile : metadata(profile);
    const card = el('article', '', 'card'), head = el('div', '', 'card-head'), title = el('div', '', 'role-title');
    title.append(el('h2', m.title), el('p', m.subtitle));
    head.append(el('div', m.icon, 'role-icon' + (m.title === 'Sol' ? ' mint' : '')), title);
    const tags = el('div', '', 'role-meta'); tags.append(el('span', m.model.split('/').at(-1), 'badge'), el('span', 'THINKING / ' + m.thinking.toUpperCase(), 'badge neutral'));
    card.append(head, tags, el('div', preview ? 'Fixed recommendation · not created or run yet' : m.model, 'role-model'));
    if (!preview) {
      const details = el('details'), summary = el('summary', 'Path · review full source');
      const source = el('pre', profile.content, 'source'); source.tabIndex = 0; source.setAttribute('aria-label', m.title + ' exact full contents');
      const label = el('label', '', 'ack'), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = reviewed.has(profile.file); checkbox.disabled = true;
      label.append(checkbox, el('span', 'I reviewed the full contents'));
      const unlock = () => { if (details.open && source.scrollHeight - source.scrollTop - source.clientHeight < 12) checkbox.disabled = false; };
      source.addEventListener('scroll', unlock); details.addEventListener('toggle', () => requestAnimationFrame(unlock));
      checkbox.onchange = () => { if (checkbox.checked) reviewed.add(profile.file); else reviewed.delete(profile.file); updateApproval(); };
      details.append(summary, el('div', profile.file, 'path'), source, label); card.append(details);
    }
    return card;
  }
  let approval, progress, clock;
  function updateApproval() {
    if (!approval || state.phase !== 'review') return;
    const count = state.review.profiles.length;
    approval.disabled = pending || reviewed.size !== count || Date.now() >= state.review.deadline;
    progress.textContent = `${reviewed.size} / ${count} source texts reviewed`;
    clock.textContent = `Review deadline: ${Math.max(0, Math.ceil((state.review.deadline - Date.now()) / 1000))}s`;
  }
  function review() {
    if (reviewId !== state.review.id) { reviewed.clear(); reviewId = state.review.id; }
    const grid = el('div', '', 'grid'); for (const profile of state.review.profiles) grid.append(card(profile));
    const bar = el('div', '', 'reviewbar'), text = el('div'); progress = el('strong'); clock = el('span', '', 'clock');
    text.append(progress, el('p', 'Approval creates only files missing from the displayed paths. Cancellation does not roll back partially created files.'));
    approval = button('Create reviewed profiles  →', 'primary', () => perform(() => service.decide({ id: state.review.id,
      packet: state.review.packet, accepted: true, reviewed: [...reviewed], lease }, context)));
    bar.append(text, clock, approval);
    const packet = el('details', '', 'packet'); packet.append(el('summary', 'Full exact approval request'), el('pre', state.review.packet, 'source'));
    content.append(grid, bar, packet); updateApproval();
  }
  function diagnostics(report) {
    const checks = el('div', '', 'checks');
    const rows = [ ['Standalone Node', report.node], ['PATH Pi / verification SDK', `${report.piVersion} / ${report.testedVersion}`],
      ['Standalone worker import', report.workerVersion === report.testedVersion ? 'Passed · no actual model execution' : 'Needs review'],
      ['Selected JEV backend', report.jevProvider ? report.jevProvider.ready && report.jevProvider.target
        ? `${report.jevProvider.target.backend} · ${report.jevProvider.target.model} · local configuration only`
        : report.jevProvider.error || 'Needs review' : report.jevKeyPresent ? 'TypeSafe key configured · validity unknown' : 'No TypeSafe key'],
      ...report.profiles.map(p => [p.name, p.status === 'valid' ? `Format valid · ${p.plan}` : p.status === 'missing' ? 'Not present · created after approval' : 'Existing file requires direct review']),
    ];
    for (const [label, value] of rows) { const node = el('div', '', 'check'); node.append(el('span', label), el('strong', value)); checks.append(node); }
    content.append(checks);
  }
  function render() {
    if (disposed) return;
    renderControls();
    const current = state.phase === 'review' ? 1 : state.phase === 'creating' || state.phase === 'complete' ? 2 : 0;
    steps.replaceChildren(...['Check environment', 'Review exact contents', 'Prepare after approval'].map((text, i) => { const n = el('div', '', 'step' + (i === current ? ' active' : i < current ? ' done' : '')); n.append(el('b', i < current ? '✓' : String(i + 1)), el('span', text)); return n; }));
    error.textContent = [actionError, state.phase === 'error' ? state.reason : ''].filter(Boolean).join('\n'); error.hidden = !error.textContent;
    status.textContent = state.phase === 'checking' ? 'Checking the local environment.' : state.phase === 'creating' ? 'Preparing approved profiles.' : state.phase === 'complete' ? 'Preparation is complete.' : state.phase === 'review' ? 'Review the profile source and approve it directly.' : '';
    content.replaceChildren(); approval = undefined;
    if (state.phase === 'review') { review(); return; }
    if (state.phase === 'complete' && state.report) { diagnostics(state.report); return; }
    if (state.phase === 'checking' || state.phase === 'creating') {
      const empty = el('div', '', 'empty'); empty.append(el('h2', state.phase === 'creating' ? 'Preparing only the approved contents.' : 'Checking the local environment.'), el('p', 'Checks run without API or model calls. Roles and models are not changed automatically while you wait.')); content.append(empty); return;
    }
    if (state.phase === 'complete' || state.phase === 'cancelled') {
      const empty = el('div', '', 'empty'); empty.append(el('h2', state.phase === 'complete' ? 'Preparation is complete. ✓' : 'Cancelled.'), el('p', state.phase === 'complete' ? 'Use free diagnostics to check profile formats. Actual work requests proceed only after separate execution approval.' : state.reason)); content.append(empty); return;
    }
    const grid = el('div', '', 'grid'); for (const info of Object.values(roles)) grid.append(card(info, true)); content.append(grid);
  }
  const onKey = event => { if (event.key === 'Escape' && busy() && !pending) { event.preventDefault(); void perform(() => service.cancel({}, context)); } };
  view.addEventListener('keydown', onKey);
  const timer = setInterval(updateApproval, 250);
  const heartbeat = setInterval(() => {
    if (connected && !disposed) void service.heartbeat({ lease }, context).catch(reason => {
      connected = false; actionError = reason instanceof Error ? reason.message : String(reason); render();
    });
  }, 1_000);
  function dispose() {
    if (disposed) return;
    // Explicit close requests cancellation; session shutdown/deadline also revoke pending approval.
    if (state.phase === 'review') void service.cancel({}, cleanupContext).catch(() => {});
    disposed = true; clearInterval(timer); clearInterval(heartbeat); unsubscribe(); host.signal.removeEventListener('abort', dispose);
    view.removeEventListener('keydown', onKey);
    void binding.dispose(cleanupContext).catch(() => {}); root.replaceChildren();
  }
  host.signal.addEventListener('abort', dispose, { once: true }); render();
  try {
    await binding.ready(context); host.signal.throwIfAborted();
    lease = (await service.attach({}, context)).lease; connected = true;
    unsubscribe = service.state.subscribe(next => { state = next; render(); });
    if (service.state.value) state = service.state.value; render();
  } catch (reason) { dispose(); throw reason; }
  return dispose;
}
