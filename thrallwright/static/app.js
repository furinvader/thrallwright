import terminalLibrary from '/vendor/terminal.js';

const { Terminal, FitAddon } = terminalLibrary;
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="thrallwright-token"]').content;
let snapshot = null;
let selectedId = null;
let terminal = null;
let fitAddon = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let fatalConnection = false;
let selectedTab = 'changes';
let refreshPromise = null;
let sessionsSignature = '';

function notify(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function api(path, options = {}) {
  const headers = { 'X-Thrallwright-Token': token, ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 403) {
      fatalConnection = true;
      throw new Error('The server token changed or access was rejected. Reload this page to reconnect.');
    }
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch { /* Non-JSON failure. */ }
    throw new Error(message);
  }
  return response;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectedSession() {
  return snapshot?.sessions.find((item) => item.id === selectedId);
}

function updateControls() {
  const session = selectedSession();
  const running = session?.status === 'running';
  $('stop').disabled = !running;
  $('interrupt').disabled = !running;
  $('download').disabled = !session;
  if (terminal) terminal.options.disableStdin = !running || socket?.readyState !== WebSocket.OPEN;
  $('terminal-title').textContent = session?.title || 'Ready when you are';
  if (session?.recording_error) notify(`Transcript recording failed: ${session.recording_error}. The terminal is still running.`);
}

function renderSessions() {
  const signature = JSON.stringify([snapshot.sessions, selectedId]);
  if (signature === sessionsSignature) return;
  sessionsSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const session of snapshot.sessions) {
    const button = element('button', 'session-card');
    button.classList.toggle('selected', session.id === selectedId);
    button.setAttribute('aria-pressed', String(session.id === selectedId));
    const status = ['running', 'stopping', 'exited', 'stopped', 'failed', 'interrupted'].includes(session.status)
      ? session.status : 'unknown';
    button.append(element('strong', 'session-title', session.title));
    const detail = element('span', 'session-detail');
    detail.append(element('span', `status-dot ${status}`, '●'), document.createTextNode(`${session.kind} · ${status}`));
    button.append(detail);
    button.addEventListener('click', () => selectSession(session.id));
    fragment.append(button);
  }
  if (!snapshot.sessions.length) fragment.append(element('p', 'muted no-sessions', 'A fresh workbench. Your sessions will appear here.'));
  $('sessions').replaceChildren(fragment);
  $('session-count').textContent = String(snapshot.sessions.filter((item) => item.status === 'running').length);
  updateControls();
}

function displayGit(result, empty = 'No changes.') {
  return (result.text?.trimEnd() || empty) + (result.truncated ? '\n\n[Output limited to 256 KiB]' : '');
}

function renderWorkflow(workflow) {
  $('workflow-steps').replaceChildren();
  $('workflow-title').textContent = 'Workflow state';
  if (!workflow.exists) {
    $('workflow-json').textContent = 'No workflow file yet.\n\nFrom a shell session:\ncp examples/workflow.json .thrallwright/workflow.json\n\nAny valid JSON is shown here. A steps array also becomes a checklist. Changes refresh automatically.';
    return;
  }
  if (workflow.error) {
    $('workflow-json').textContent = `Cannot read workflow state:\n${workflow.error}\n\nThe file may be mid-write. Retrying automatically.`;
    return;
  }
  const data = workflow.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (typeof data.title === 'string') $('workflow-title').textContent = data.title;
    if (Array.isArray(data.steps)) {
      for (const step of data.steps.slice(0, 100)) {
        if (!step || typeof step !== 'object') continue;
        const line = element('div', 'workflow-step');
        const status = typeof step.status === 'string' ? step.status : 'pending';
        line.append(element('span', 'step-symbol', status === 'done' ? '✓' : status === 'running' ? '◉' : '○'));
        const copy = element('div');
        copy.append(element('strong', '', String(step.title || step.id || 'Untitled step')),
                    element('small', 'muted', status));
        line.append(copy);
        $('workflow-steps').append(line);
      }
    }
  }
  $('workflow-json').textContent = JSON.stringify(data, null, 2);
}

async function loadDiff() {
  const result = await (await api('/api/diff')).json();
  $('diff-unstaged').textContent = displayGit(result.unstaged, 'No unstaged tracked changes.');
  $('diff-staged').textContent = displayGit(result.staged, 'No staged changes.');
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const first = !snapshot;
      snapshot = await (await api('/api/workspace')).json();
      $('workspace-path').textContent = snapshot.workspace;
      $('workspace-path').title = snapshot.workspace;
      $('new-session').disabled = false;
      $('start-first').disabled = false;
      $('git-status').textContent = displayGit(snapshot.git);
      renderSessions();
      renderWorkflow(snapshot.workflow);
      if (snapshot.warnings.length) notify(snapshot.warnings.join('\n'));
      $('last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()} · every 3s`;
      if (first) {
        let remembered;
        try { remembered = localStorage.getItem(`thrallwright:${snapshot.workspace}`); } catch { /* Optional persistence. */ }
        const candidate = snapshot.sessions.find((item) => item.id === remembered) || snapshot.sessions[0];
        if (candidate) selectSession(candidate.id);
      }
      if (selectedTab === 'diff') await loadDiff();
    } catch (error) {
      notify(error.message);
      $('last-refresh').textContent = 'Workspace disconnected';
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

function send(message, target = socket) {
  if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(message));
}

function fitTerminal() {
  if (!terminal || $('terminal').hidden) return;
  fitAddon.fit();
  const cols = Math.max(2, Math.min(400, terminal.cols));
  const rows = Math.max(2, Math.min(200, terminal.rows));
  terminal.resize(cols, rows);
  send({ type: 'resize', cols, rows });
}

function connectTerminal(id) {
  if (id !== selectedId || fatalConnection) return;
  terminal?.dispose();
  terminal = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    scrollback: 5000, disableStdin: true,
    theme: { background: '#18201e', foreground: '#e1e6df', cursor: '#c5dfac', selectionBackground: '#506149' },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open($('terminal'));
  const view = terminal;
  const currentSocket = new WebSocket(`ws://${location.host}/ws/${encodeURIComponent(id)}`, `thrallwright.${token}`);
  socket = currentSocket;
  view.onData((data) => {
    if (socket !== currentSocket || selectedSession()?.status !== 'running') return;
    if (data.length > 65536 || currentSocket.bufferedAmount > 131072) {
      notify('That paste is too large or the connection is busy. Paste smaller pieces.');
      return;
    }
    const characters = Array.from(data);
    for (let offset = 0; offset < characters.length; offset += 2000) {
      send({ type: 'input', data: characters.slice(offset, offset + 2000).join('') }, currentSocket);
    }
  });
  currentSocket.onopen = () => {
    if (socket !== currentSocket) return;
    reconnectAttempts = 0;
    $('connection-state').textContent = 'Connected · click the terminal to type';
    updateControls();
    requestAnimationFrame(fitTerminal);
    view.focus();
  };
  currentSocket.onmessage = (event) => {
    if (socket !== currentSocket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { notify('Invalid terminal response. Reload the page.'); return; }
    if (message.type === 'output') {
      view.write(message.data, () => send({ type: 'ack', seq: message.seq }, currentSocket));
    } else if (message.type === 'ready' || message.type === 'exit') {
      const index = snapshot.sessions.findIndex((item) => item.id === id);
      if (index >= 0) snapshot.sessions[index] = message.session;
      renderSessions();
      if (message.session.status !== 'running') {
        $('connection-state').textContent = `${message.session.status} · saved output (not a running process)`;
      }
    } else if (message.type === 'error') notify(message.message);
  };
  currentSocket.onclose = () => {
    if (socket !== currentSocket) return;
    updateControls();
    $('connection-state').textContent = 'Disconnected · reconnecting to this session…';
    if (!fatalConnection) {
      reconnectTimer = setTimeout(() => connectTerminal(id), Math.min(5000, 500 * 2 ** reconnectAttempts++));
    }
  };
  currentSocket.onerror = () => { /* onclose reconnects; polling detects server restarts. */ };
}

function selectSession(id) {
  if (selectedId === id && socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  const previous = socket;
  socket = null;
  previous?.close();
  selectedId = id;
  reconnectAttempts = 0;
  try { localStorage.setItem(`thrallwright:${snapshot.workspace}`, id); } catch { /* Optional. */ }
  $('empty').hidden = true;
  $('terminal').hidden = false;
  renderSessions();
  connectTerminal(id);
}

function openDialog() {
  $('profile').replaceChildren();
  for (const profile of snapshot.profiles) {
    const option = element('option', '', `${profile.label}${profile.available ? '' : ' — not installed'}`);
    option.value = profile.id;
    option.disabled = !profile.available;
    $('profile').append(option);
  }
  const available = snapshot.profiles.find((item) => item.available);
  if (available) $('profile').value = available.id;
  $('launch').disabled = !available;
  $('form-error').hidden = true;
  $('session-dialog').showModal();
}

$('new-session').addEventListener('click', openDialog);
$('start-first').addEventListener('click', openDialog);
$('close-dialog').addEventListener('click', () => $('session-dialog').close());
$('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('launch').disabled = true;
  try {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({
      kind: $('profile').value, title: $('session-name').value,
    }) })).json();
    snapshot.sessions.unshift(session);
    $('session-dialog').close();
    $('session-name').value = '';
    notify('');
    selectSession(session.id);
    void refresh();
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
  } finally { $('launch').disabled = false; }
});

for (const action of ['interrupt', 'stop']) {
  $(action).addEventListener('click', async () => {
    if (!selectedId) return;
    if (action === 'stop' && !confirm('Stop this session and its foreground job? Unsaved work in that process may be lost.')) return;
    $(action).disabled = true;
    try { await api(`/api/sessions/${selectedId}/${action}`, { method: 'POST' }); await refresh(); }
    catch (error) { notify(error.message); }
    finally { updateControls(); }
  });
}
$('download').addEventListener('click', async () => {
  try {
    const response = await api(`/api/sessions/${selectedId}/transcript`);
    const url = URL.createObjectURL(await response.blob());
    const link = element('a');
    link.href = url;
    link.download = `thrallwright-${selectedId}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message); }
});
$('refresh').addEventListener('click', () => { notify(''); void refresh(); });
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', async () => {
    selectedTab = button.dataset.tab;
    for (const tab of ['changes', 'workflow', 'diff']) {
      $(`panel-${tab}`).hidden = tab !== selectedTab;
      $(`tab-${tab}`).setAttribute('aria-selected', String(tab === selectedTab));
    }
    if (selectedTab === 'diff') {
      try { await loadDiff(); } catch (error) { notify(error.message); }
    }
  });
}
new ResizeObserver(() => requestAnimationFrame(fitTerminal)).observe($('terminal'));
window.addEventListener('beforeunload', () => { socket?.close(); });
(async function poll() { await refresh(); setTimeout(poll, 3000); })();
