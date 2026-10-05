(() => {
  'use strict';

  const STATUS_LABELS = {
    RUNNING: 'Running',
    WAITING_ON_USER: 'Waiting on user',
    WAITING_ON_AGENT: 'Waiting on agent',
    BLOCKED: 'Blocked',
    DONE: 'Done',
  };
  const MESSAGE_LABELS = { NOTE: 'Note', HANDOFF: 'Handoff', QUESTION: 'Question', ANSWER: 'Answer' };
  const state = {
    token: null,
    principal: null,
    sessions: [],
    sessionFilterOptions: { agentNames: [], agentModels: [], machines: [], environments: [], branches: [] },
    sessionSummary: null,
    sessionTotal: 0,
    sessionLimit: 200,
    messages: [],
    principals: [],
    connections: [],
    connectionBefore: null,
    connectionLoading: false,
    connectionGeneration: 0,
    ownership: [],
    selectedSessionId: '',
    selectedSessionSnapshot: null,
    messageMode: 'workspace',
    drawerReturn: null,
    drawerReturnSessionId: '',
    composeTarget: null,
    senderSessions: [],
    composeGeneration: 0,
    sending: false,
    pendingSend: null,
    messageViewKey: null,
    searchTimer: null,
    messageSearchTimer: null,
    attribution: { sessionId: '', segments: [], cursor: null, hasMore: false, loading: false, error: '' },
    attributionGeneration: 0,
    messageViewSessionId: null,
    messageViewKind: null,
    messageViewReviewState: null,
    messageGeneration: 0,
    messageLoading: false,
    hasMoreMessages: false,
    messageBefore: null,
    replyTo: null,
    refreshing: false,
    refreshRequested: false,
    generation: 0,
    controllers: new Set(),
    toastTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    connectPanel: $('connect-panel'), connectForm: $('connect-form'), connectToken: $('hub-token'),
    workspace: $('workspace'), connection: $('connection-state'), refresh: $('refresh-button'), logout: $('logout-button'),
    summary: $('principal-summary'), sessions: $('session-list'), sessionEmpty: $('session-empty'),
    copyAgentSetup: $('copy-agent-setup'), setupFallback: $('agent-setup-fallback'), setupText: $('agent-setup-text'), closeSetup: $('close-agent-setup'),
    summaryRunning: $('summary-running'), summaryWaitingUser: $('summary-waiting-user'), summaryWaitingAgent: $('summary-waiting-agent'), summaryBlocked: $('summary-blocked'), summaryStale: $('summary-stale'),
    sessionSearch: $('session-search'), messageSearch: $('message-search'),
    drawer: $('message-drawer'), drawerTitle: $('drawer-title'), drawerEyebrow: $('drawer-eyebrow'), closeDrawer: $('close-drawer'),
    openAllMessages: $('open-all-messages'), openOwnerInbox: $('open-owner-inbox'), askOwner: $('ask-owner'), inboxAccessNote: $('inbox-access-note'),
    compose: $('compose-message'), cancelCompose: $('cancel-compose'), composeRecipient: $('compose-recipient'), sendButton: $('send-button'), detailsWrap: $('session-details-wrap'),
    projectFilter: $('project-filter'), agentNameFilter: $('agent-name-filter'), agentModelFilter: $('agent-model-filter'),
    machineFilter: $('machine-filter'), branchFilter: $('branch-filter'), environmentFilter: $('environment-filter'), statusFilter: $('status-filter'), staleFilter: $('stale-filter'), sessionCount: $('session-count'),
    detail: $('session-detail'), detailTitle: $('detail-title'), detailStatus: $('detail-status'), detailContent: $('detail-content'),
    releaseDetails: $('release-details'), claims: $('claims-list'), claimForm: $('claim-form'), claimResource: $('claim-resource'), releaseEnteredClaim: $('release-entered-claim'), claimMessage: $('claim-message'), archiveSession: $('archive-session-button'),
    messageFilter: $('message-type-filter'), messageScope: $('message-scope'), messageList: $('message-list'), messageEmpty: $('message-empty'), messageCount: $('message-count'),
    reviewFilter: $('message-review-filter'), reviewFilterWrap: $('review-filter-wrap'),
    loadOlder: $('load-older-button'), messageForm: $('message-form'),
    fromSessionWrap: $('from-session-wrap'), fromSession: $('from-session'), messageKind: $('message-kind'),
    messageBody: $('message-body'), sendMessage: $('send-message'), composeAs: $('compose-as'), replyContext: $('reply-context'),
    ownerTools: $('owner-tools'), inviteForm: $('invite-form'), inviteMessage: $('invite-message'), principalList: $('principal-list'),
    connectionHistory: $('connection-history'), connectionList: $('connection-list'), connectionStatus: $('connection-history-status'), refreshConnections: $('refresh-connections'), olderConnections: $('older-connections'),
    tokenPanel: $('one-time-token'), tokenValue: $('invite-token-value'), dismissToken: $('dismiss-token'), toast: $('toast'),
  };

  let attributionPanel;

  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  };
  const setText = (target, value) => { target.textContent = value == null || value === '' ? '—' : String(value); };
  const clear = (target) => target.replaceChildren();
  const isOwner = () => state.principal?.role === 'owner';
  const isObserver = () => state.principal?.profile === 'observer';
  const conversationView = () => isOwner() || isObserver();
  const selectedSession = () => state.sessions.find((session) => session.id === state.selectedSessionId) ?? (state.selectedSessionSnapshot?.id === state.selectedSessionId ? state.selectedSessionSnapshot : null);
  const visibleProject = () => el.projectFilter.value;
  const projectList = () => [...new Set([
    ...(state.principal?.projects ?? []),
    ...state.principals.filter((principal) => principal.active === true).flatMap((principal) => principal.projects ?? []),
    ...state.sessions.map((session) => session.project),
  ].filter((project) => Boolean(project) && project !== '*'))].sort((a, b) => a.localeCompare(b));
  const ownsSession = (session) => Boolean(session && session.principalId === state.principal?.id);
  class StaleRequestError extends Error {}
  const formatTime = (value) => {
    if (!value) return 'Unknown time';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const humanizeKey = (value) => String(value).replace(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ').replace(/^./u, (s) => s.toUpperCase());

  attributionPanel = (() => {
    const panel = node('section', 'subpanel attribution-panel');
    panel.setAttribute('aria-labelledby', 'attribution-title');
    const heading = node('div', 'attribution-heading');
    const title = node('h3', '', 'Attribution history');
    title.id = 'attribution-title';
    heading.append(title);
    const refresh = node('button', 'button button-quiet button-small', 'Refresh history');
    refresh.type = 'button';
    refresh.addEventListener('click', () => loadAttribution(selectedSession()?.id, { reset: true }));
    heading.append(refresh);
    panel.append(heading);
    panel.append(node('p', 'muted small attribution-disclaimer', 'Agent-reported attribution labels only. They are not authentication, billing, or provider proof. Each row shows only its recorded interval; no work time, token use, or cost is inferred.'));
    const list = node('div', 'attribution-list');
    const status = node('p', 'inline-message attribution-status', 'Select a session to view its attribution history.');
    status.setAttribute('role', 'status');
    const more = node('button', 'button button-secondary button-small attribution-more', 'Load more');
    more.type = 'button';
    more.hidden = true;
    more.addEventListener('click', () => loadAttribution(selectedSession()?.id, { more: true }));
    panel.append(list, status, more);
    el.detail.append(panel);
    return { panel, list, status, more, refresh };
  })();

  async function request(path, options = {}) {
    if (!state.token) throw new Error('Connect before using the board.');
    const generation = state.generation;
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      const response = await fetch(`/api${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${state.token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
        cache: 'no-store',
      signal: controller.signal,
        redirect: 'error',
      });
      if (generation !== state.generation) throw new StaleRequestError();
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (generation !== state.generation) throw new StaleRequestError();
      if (!response.ok) {
        const message = payload?.error?.message || `Request failed (${response.status}).`;
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (generation !== state.generation || controller.signal.aborted) throw new StaleRequestError();
      throw error;
    } finally { state.controllers.delete(controller); }
  }

  function toast(message, kind = 'success') {
    clearTimeout(state.toastTimer);
    (el.drawer.open ? el.drawer : el.workspace).append(el.toast);
    el.toast.className = `toast toast-${kind}`;
    setText(el.toast, message);
    el.toast.hidden = false;
    state.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  function showConnection(connected) {
    el.connectPanel.hidden = connected;
    el.workspace.hidden = !connected;
    el.refresh.hidden = !connected;
    el.logout.hidden = !connected;
    el.connection.textContent = connected ? 'Connected' : 'Offline';
    el.connection.classList.toggle('is-connected', connected);
  }

  function option(select, value, label) {
    const item = node('option', '', label);
    item.value = value;
    select.append(item);
  }

  function renderSelectors() {
    const projects = projectList();
    const currentProject = el.projectFilter.value;
    clear(el.projectFilter);
    option(el.projectFilter, '', 'All projects');
    for (const project of projects) option(el.projectFilter, project, project);
    if (projects.includes(currentProject)) el.projectFilter.value = currentProject;

    renderAttributionFilter(el.agentNameFilter, state.sessionFilterOptions.agentNames, 'All agent names');
    renderAttributionFilter(el.agentModelFilter, state.sessionFilterOptions.agentModels, 'All agent models');
    renderAttributionFilter(el.machineFilter, state.sessionFilterOptions.machines, 'All machines');
    renderAttributionFilter(el.environmentFilter, state.sessionFilterOptions.environments, 'All environments');
    renderBranchFilter();
  }

  function renderAttributionFilter(select, values, allLabel) {
    const current = select.value;
    clear(select);
    option(select, '', allLabel);
    option(select, 'unknown:', 'Unknown');
    const knownValues = [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.length > 0))]
      .sort((left, right) => left.localeCompare(right));
    for (const value of knownValues) option(select, `value:${value}`, value);
    if (current.startsWith('value:') && !knownValues.includes(current.slice('value:'.length))) {
      option(select, current, current.slice('value:'.length));
    }
    if ([...select.options].some((item) => item.value === current)) select.value = current;
  }

  function renderBranchFilter() {
    const current = el.branchFilter.value;
    clear(el.branchFilter);
    option(el.branchFilter, '', 'All branches');
    option(el.branchFilter, 'unknown:', 'Unknown / detached');
    const contexts = state.sessionFilterOptions.branches.filter(item => item?.repository && item?.branch)
      .sort((a,b) => `${a.repository} · ${a.branch}`.localeCompare(`${b.repository} · ${b.branch}`));
    for (const context of contexts) option(el.branchFilter, JSON.stringify(context), `${context.repository} · ${context.branch}`);
    if (current && current !== 'unknown:' && !contexts.some(item => JSON.stringify(item) === current)) {
      const context = JSON.parse(current);
      option(el.branchFilter, current, `${context.repository} · ${context.branch}`);
    }
    el.branchFilter.value = current;
  }

  function statusBadge(status, stale = false) {
    const safeStatusClass = Object.hasOwn(STATUS_LABELS, status) ? String(status).toLowerCase() : 'unknown';
    const badge = node('span', `status-badge status-${safeStatusClass}`, STATUS_LABELS[status] || status || 'Unknown');
    if (stale) badge.classList.add('status-stale');
    return badge;
  }

  function sessionMatches(session) {
    return (!visibleProject() || session.project === visibleProject()) &&
      (el.statusFilter.value === 'ALL' || session.status === el.statusFilter.value ||
        (el.statusFilter.value === 'WAITING' && (session.status === 'WAITING_ON_USER' || session.status === 'WAITING_ON_AGENT'))) &&
      (!el.staleFilter.checked || (session.stale === true && session.status !== 'DONE'));
  }

  function sessionQuery() {
    const query = new URLSearchParams();
    if (visibleProject()) query.set('project', visibleProject());
    if (el.sessionSearch.value.trim()) query.set('q', el.sessionSearch.value.trim());
    for (const [select, name, unknownName] of [
      [el.agentNameFilter, 'agentName', 'agentNameUnknown'],
      [el.agentModelFilter, 'agentModel', 'agentModelUnknown'],
      [el.machineFilter, 'machine', 'machineUnknown'],
      [el.environmentFilter, 'environment', 'environmentUnknown'],
    ]) {
      const selected = select.value;
      if (selected === 'unknown:') query.set(unknownName, '1');
      else if (selected.startsWith('value:')) query.set(name, selected.slice('value:'.length));
    }
    if (el.branchFilter.value === 'unknown:') query.set('branchUnknown', '1');
    else if (el.branchFilter.value) {
      const context = JSON.parse(el.branchFilter.value);
      query.set('repository', context.repository); query.set('branch', context.branch);
    }
    if (el.statusFilter.value !== 'ALL') query.set('status', el.statusFilter.value);
    if (el.staleFilter.checked) query.set('staleOnly', '1');
    const serialized = query.toString();
    return serialized ? `?${serialized}` : '';
  }

  function renderSummary() {
    const summary = state.sessionSummary;
    for (const [id, status] of [['running','RUNNING'], ['waiting-user','WAITING_ON_USER'], ['waiting-agent','WAITING_ON_AGENT'], ['blocked','BLOCKED']]) {
      $('count-' + id).textContent = String(summary?.[status] ?? state.sessions.filter(item => item.status === status).length);
    }
    $('count-stale').textContent = String(summary?.stale ?? state.sessions.filter(item => item.stale && item.status !== 'DONE').length);
  }

  function sessionWaitSummary(session) {
    if (session.status === 'DONE') return null;
    const life = session.lifecycle;
    const checkpoint = life?.checkpoint;
    const wait = checkpoint?.wait;
    const blocked = session.status === 'BLOCKED';
    const kind = wait?.kind || (session.status === 'WAITING_ON_USER' || life?.attention === 'WAITING_USER' ? 'user' : session.status === 'WAITING_ON_AGENT' ? 'agent' : null);
    if (!blocked && !kind) return null;
    const labels = { user: 'Needs from user', agent: 'Waiting for', external: 'External prerequisite', scheduled: 'Scheduled event' };
    const summary = node('span', `session-wait-summary${blocked ? ' session-wait-blocked' : ''}`);
    summary.append(node('strong', 'session-wait-heading', labels[kind] || 'Blocking prerequisite'));
    const reason = wait?.reason || (blocked ? checkpoint?.pauseReason : null);
    const reported = new Set(reason ? [reason.trim()] : []);
    summary.append(node('span', reason ? 'session-wait-reason' : 'session-wait-missing', reason || (blocked ? 'Blocker not reported. This session needs to explain what prevents progress.' : kind === 'user' ? 'Requested user decision or action not reported.' : 'Specific waiting reason not reported.')));
    if (kind === 'agent') {
      if (wait?.sessionId) {
        const dependency = life?.dependency?.sessionId === wait.sessionId ? life.dependency : state.sessions.find(item => item.id === wait.sessionId && item.project === session.project);
        summary.append(node('span', 'session-wait-agent', `Agent session: ${dependency?.label || 'Session name unavailable'}`));
        summary.append(node('span', 'session-wait-id', `Session ID: ${wait.sessionId}`));
        const agentName = dependency?.agentName || dependency?.latestAttribution?.client;
        if (agentName || dependency?.machine) summary.append(node('span', 'session-wait-context', [agentName, dependency?.machine].filter(Boolean).join(' · ')));
        if (dependency?.status) summary.append(node('span', 'session-wait-context', `Dependency reports: ${STATUS_LABELS[dependency.status] || dependency.status}${dependency.status === 'DONE' ? ' — verify its completion evidence' : ''}`));
      } else summary.append(node('span', 'session-wait-missing', 'Agent not identified. No other session has been linked.'));
    }
    if (wait?.expectedEvent && !reported.has(wait.expectedEvent.trim())) {
      summary.append(node('span', 'session-wait-event', `Needed to continue: ${wait.expectedEvent}`));
      reported.add(wait.expectedEvent.trim());
    }
    if (checkpoint?.nextCheckAt) summary.append(node('span', 'session-wait-context', `Next check: ${formatTime(checkpoint.nextCheckAt)}${life?.overdue ? ' · Overdue' : ''}`));
    else summary.append(node('span', 'session-wait-missing', 'Next check not reported.'));
    if (!checkpoint?.nextAction) summary.append(node('span', 'session-wait-missing', 'Next action not reported.'));
    else if (!reported.has(checkpoint.nextAction.trim())) summary.append(node('span', 'session-wait-action', `Next action: ${checkpoint.nextAction}`));
    return summary;
  }

  function renderSessions() {
    for (const [chip, status] of [[el.summaryRunning, 'RUNNING'], [el.summaryWaitingUser, 'WAITING_ON_USER'], [el.summaryWaitingAgent, 'WAITING_ON_AGENT'], [el.summaryBlocked, 'BLOCKED']]) {
      chip.setAttribute('aria-pressed', String(el.statusFilter.value === status));
    }
    el.summaryStale.setAttribute('aria-pressed', String(el.staleFilter.checked));
    clear(el.sessions);
    const sessions = state.sessions.filter(sessionMatches).sort((a, b) => {
      const statusOrder = { WAITING_ON_USER: 0, WAITING_ON_AGENT: 1, BLOCKED: 2, RUNNING: 3, DONE: 4 };
      return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
    });
    const isServerLimited = state.sessionTotal > state.sessionLimit;
    el.sessionCount.textContent = isServerLimited ? `${sessions.length} shown · ${state.sessionTotal} matches` : String(sessions.length);
    el.sessionCount.title = isServerLimited
      ? `${state.sessionTotal} sessions match the selected project and attribution filters; only ${state.sessionLimit} were returned after all selected filters.`
      : `${sessions.length} sessions shown after status and stale filters.`;
    el.sessionEmpty.hidden = sessions.length !== 0;
    for (const session of sessions) {
      const wrapper = node('article', `session-card${session.status === 'WAITING_ON_USER' || session.lifecycle?.attention==='WAITING_USER' ? ' needs-user' : ''}${session.id === state.selectedSessionId ? ' is-selected' : ''}`);
      wrapper.dataset.sessionId = session.id;
      const card = node('button', 'session-select');
      card.type = 'button';
      card.setAttribute('aria-pressed', String(session.id === state.selectedSessionId));
      const top = node('div', 'session-card-top');
      top.append(node('span', 'session-project', session.project), statusBadge(session.status));
      const title = node('strong', 'session-title', session.label || 'Session title not set');
      const waitSummary = sessionWaitSummary(session);
      const task = node('span', 'session-task', `Task: ${session.task || 'No task description'}`);
      const checkpoint = session.lifecycle?.checkpoint;
      const displayedTaskValues = waitSummary ? [checkpoint?.wait?.reason || (session.status === 'BLOCKED' ? checkpoint?.pauseReason : null), checkpoint?.wait?.expectedEvent, checkpoint?.nextAction] : [checkpoint?.nextAction || session.lifecycle?.reason];
      const taskRepeated = Boolean(session.task && displayedTaskValues.some(value => value?.trim() === session.task.trim()));
      const labels = node('span', 'session-labels');
      labels.append(
        node('span', 'session-origin', `Machine: ${session.machine || 'Unknown'}`),
        node('span', 'session-origin', `Account: ${session.account || session.principalName || 'Unknown'}`),
      );
      const meta = node('span', 'session-meta', `Environment: ${session.environment || 'Unknown'} · seen ${formatTime(session.lastSeenAt)}`);
      if (session.workContext) labels.append(node('span', 'session-origin', `${session.workContext.repository} · ${session.workContext.branch || 'Detached'}${session.workContext.commit ? ' · ' + session.workContext.commit.slice(0, 8) : ''}`));
      card.append(top, title);
      if (waitSummary) card.append(waitSummary);
      if (!taskRepeated) card.append(task);
      card.append(labels, meta);
      if (session.stale && session.status !== 'DONE') {
        const stale = node('span', 'stale-chip', 'Not recently seen');
        stale.title = 'No Hub update for more than three minutes; work may still be running or waiting.';
        card.append(stale);
      }
      if (!waitSummary && session.lifecycle?.checkpoint?.nextAction) card.append(node('span','session-next-action',session.lifecycle.checkpoint.nextAction));
      card.addEventListener('click', () => selectSession(session.id));
      const actions = node('div', 'session-actions');
      const messagesButton = node('button', 'button button-secondary button-small', 'Messages');
      messagesButton.type = 'button';
      messagesButton.setAttribute('aria-label', `Messages: ${session.label || session.id}`);
      messagesButton.addEventListener('click', () => selectSession(session.id));
      actions.append(messagesButton);
      if (!isObserver()) {
        const send = node('button', 'button button-primary button-small', 'Send message');
        send.type = 'button';
        send.setAttribute('aria-label', `Send message to: ${session.label || session.id}`);
        send.addEventListener('click', () => selectSession(session.id, { compose: true }));
        actions.append(send);
      }
      const copy = node('button', 'button button-quiet button-small session-copy', 'Copy session name & ID');
      copy.type = 'button';
      copy.setAttribute('aria-label', `Copy session name & ID: ${session.label || 'Session title not set'}`);
      const fallback = node('div', 'session-copy-fallback');
      fallback.hidden = true;
      const reference = node('input');
      reference.type = 'text';
      reference.readOnly = true;
      reference.setAttribute('aria-label', 'Session name and full Hub session ID');
      fallback.append(node('p', 'muted small', 'Clipboard unavailable. Select and copy this session reference:'), reference);
      copy.addEventListener('click', async () => {
        const generation = state.generation;
        const text = `${session.label || 'Session title not set'} (${session.id})`;
        copy.disabled = true;
        try {
          await navigator.clipboard.writeText(text);
          if (generation !== state.generation) return;
          fallback.hidden = true;
          reference.value = '';
          toast('Session name & ID copied.');
        } catch {
          if (generation !== state.generation || !wrapper.isConnected) return;
          reference.value = text;
          fallback.hidden = false;
          reference.focus();
          reference.select();
        } finally { copy.disabled = false; }
      });
      actions.append(copy);
      wrapper.append(card, actions, fallback);
      el.sessions.append(wrapper);
    }
  }

  function addDetailRow(target, label, value) {
    const row = node('div', 'detail-row');
    row.append(node('dt', '', label), node('dd', '', value == null || value === '' ? '—' : String(value)));
    target.append(row);
  }

  function renderEvidence(details) {
    const populated=Object.values(details).some(value=>Array.isArray(value)?value.length>0:typeof value==='string'&&value.length>0);
    el.releaseDetails.closest('section').hidden=!populated;
    el.releaseDetails.closest('.detail-columns').classList.toggle('claims-only',!populated);
    clear(el.releaseDetails);
    const keys = ['releaseRequestId', 'selectedCommit', 'nativeBuildStatus', 'migrationState', 'recoveryBoundary'];
    const list = node('dl', 'detail-list');
    for (const key of keys) addDetailRow(list, humanizeKey(key), details?.[key]);
    el.releaseDetails.append(list);
    const evidence = Array.isArray(details?.evidence) ? details.evidence : [];
    const heading = node('h4', 'evidence-heading', `Evidence (${evidence.length})`);
    el.releaseDetails.append(heading);
    if (!evidence.length) {
      el.releaseDetails.append(node('p', 'muted small', 'No evidence entries attached.'));
      return;
    }
    for (const entry of evidence) {
      const item = node('article', 'evidence-item');
      item.append(node('strong', '', entry.kind || 'Evidence'), node('p', '', entry.value || '—'));
      item.append(node('span', 'muted small', `${entry.scope || 'Scope unspecified'} · ${formatTime(entry.observedAt)}`));
      el.releaseDetails.append(item);
    }
  }

  function renderSessionDetail() {
    const session = selectedSession();
    el.detail.dataset.sessionId=session?.id??'';
    el.detail.hidden = !session;
    el.archiveSession.hidden = !(session && ownsSession(session) && session.status === 'DONE' && !session.archivedAt);
    attributionPanel.panel.hidden = !session;
    if (!session) {
      el.claimForm.hidden = true;
      clear(el.claims);
      state.attributionGeneration += 1;
      state.attribution = { sessionId: '', segments: [], cursor: null, hasMore: false, loading: false, error: '' };
      renderAttribution();
      return;
    }
    setText(el.detailTitle, session.label || session.task || session.id);
    el.detailStatus.replaceChildren(statusBadge(session.status));
    if (session.stale && session.status !== 'DONE') el.detailStatus.append(node('span', 'stale-chip', 'Not recently seen'));
    clear(el.detailContent);
    const list = node('dl', 'detail-list detail-grid');
    for (const [label, value] of [
      ['Task', session.task], ['Account', session.account], ['Machine', session.machine], ['Session ID', session.id],
      ['External ID', session.externalId], ['Project', session.project], ['Environment', session.environment],
      ['Repository', session.workContext?.repository], ['Branch', session.workContext?.branch], ['Commit', session.workContext?.commit],
      ['Reported machine', session.reportedMachine], ['Last Hub update', formatTime(session.lastSeenAt)],
    ]) if (value != null && value !== '') addDetailRow(list, label, value);
    el.detailContent.append(list);
    if (session.externalId?.startsWith('codex:')) {
      const nativeId=session.externalId.slice(6);
      if (/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) {
        const link=node('a','button button-quiet button-small','Open original chat');
        link.href='codex://threads/'+encodeURIComponent(nativeId);el.detailContent.append(link);
      }
    }
    renderLifecycle(session);
    renderEvidence(session.details || {});
    renderAttribution();
    renderClaims();
  }

  function renderLifecycle(session) {
    const checkpoint=session.lifecycle?.checkpoint;
    if (!checkpoint) return;
    const panel=node('section','subpanel');
    panel.append(node('h3','','Reported next action'));
    const fields=node('dl','detail-list');
    for(const [label,value] of [['Next action',checkpoint.nextAction],['Waiting for',checkpoint.wait?.reason],['Next check',checkpoint.nextCheckAt?formatTime(checkpoint.nextCheckAt):null],['Pause reason',checkpoint.pauseReason]])addDetailRow(fields,label,value);
    panel.append(fields);
    el.detailContent.append(panel);
  }

  function renderAttribution() {
    const current = state.attribution;
    clear(attributionPanel.list);
    attributionPanel.panel.hidden = !selectedSession()?.latestAttribution;
    attributionPanel.refresh.disabled = current.loading;
    attributionPanel.more.hidden = !current.hasMore;
    attributionPanel.more.disabled = current.loading;
    attributionPanel.more.textContent = current.loading ? 'Loading…' : 'Load more';
    if (current.error) setText(attributionPanel.status, current.error);
    else if (current.loading && current.segments.length === 0) setText(attributionPanel.status, 'Loading recorded attribution…');
    else if (!current.sessionId) setText(attributionPanel.status, 'Select a session to view its attribution history.');
    else if (current.segments.length === 0) setText(attributionPanel.status, 'No attribution intervals have been recorded for this session.');
    else setText(attributionPanel.status, current.hasMore ? `${current.segments.length} recorded interval${current.segments.length === 1 ? '' : 's'} loaded.` : `${current.segments.length} recorded interval${current.segments.length === 1 ? '' : 's'} · end of history.`);

    for (const segment of current.segments) {
      const item = node('article', `attribution-item${segment.endedAt ? '' : ' is-current'}`);
      const heading = node('div', 'attribution-item-heading');
      heading.append(node('strong', '', segment.provider || 'Unknown provider'));
      heading.append(node('span', segment.endedAt ? 'attribution-state' : 'attribution-state is-current', segment.endedAt ? 'Recorded interval' : 'Current · no end recorded'));
      item.append(heading);
      const fields = node('dl', 'attribution-fields');
      for (const [label, value] of [
        ['Agent', segment.client], ['Interface', segment.interface], ['Reported client', segment.reportedClient], ['Model', segment.model], ['Account label', segment.accountLabel], ['API key label', segment.apiKeyLabel],
      ]) addDetailRow(fields, label, value == null || value === '' ? 'Unknown' : value);
      item.append(fields);
      if (segment.sessionId !== current.sessionId) item.append(node('p', 'muted small', `Earlier registration: ${segment.sessionId}`));
      const interval = node('p', 'attribution-interval');
      interval.append(node('span', '', `Started ${formatTime(segment.startedAt)}`));
      interval.append(node('span', '', segment.endedAt ? `Ended ${formatTime(segment.endedAt)}` : 'End time unknown'));
      item.append(interval);
      item.append(node('span', 'muted small attribution-source', segment.source === 'agent-reported' ? 'Source: agent-reported' : `Source: ${segment.source || 'unknown'}`));
      attributionPanel.list.append(item);
    }
  }

  async function loadAttribution(sessionId, { reset = false, more = false } = {}) {
    if (!sessionId || selectedSession()?.id !== sessionId || !selectedSession()?.latestAttribution) return;
    const current = state.attribution;
    if (!reset && !more && current.sessionId === sessionId) return;
    if (more && (!current.hasMore || current.loading || current.sessionId !== sessionId || current.cursor == null)) return;
    const generation = state.generation;
    const requestId = ++state.attributionGeneration;
    const cursor = more ? current.cursor : null;
    state.attribution = reset || current.sessionId !== sessionId
      ? { sessionId, segments: [], cursor: null, hasMore: false, loading: true, error: '' }
      : { ...current, loading: true, error: '' };
    renderAttribution();
    try {
      const query = cursor == null ? '' : `?after=${encodeURIComponent(String(cursor))}`;
      const payload = await request(`/sessions/${encodeURIComponent(sessionId)}/attribution${query}`);
      if (generation !== state.generation || requestId !== state.attributionGeneration || selectedSession()?.id !== sessionId) return;
      // The authorized response may include immutable intervals from merged registrations.
      const incoming = Array.isArray(payload.segments) ? payload.segments.filter((segment) => segment && Number.isSafeInteger(segment.id) && typeof segment.sessionId === 'string') : [];
      const segments = reset || current.sessionId !== sessionId ? incoming : [...state.attribution.segments, ...incoming.filter((segment) => !state.attribution.segments.some((item) => item.id === segment.id))];
      state.attribution = {
        sessionId,
        segments,
        cursor: payload.nextCursor ?? null,
        hasMore: payload.nextCursor != null && incoming.length === (Number(payload.limit) > 0 ? Number(payload.limit) : 200),
        loading: false,
        error: '',
      };
    } catch (error) {
      if (generation !== state.generation || requestId !== state.attributionGeneration || selectedSession()?.id !== sessionId) return;
      if (error instanceof StaleRequestError) return;
      state.attribution = { ...state.attribution, loading: false, error: error.message || 'Could not load attribution history.' };
    }
    renderAttribution();
  }

  function renderClaims() {
    clear(el.claims);
    const session = selectedSession();
    if (!session) return;
    const canManage = ownsSession(session) && !isObserver();
    el.claimForm.hidden = !canManage;
    const projectClaims = state.ownership.filter((claim) => claim.project === session.project);
    if (!projectClaims.length) el.claims.append(node('p', 'muted small', 'No resources are claimed in this project.'));
    for (const claim of projectClaims) {
      const item = node('article', 'claim-item');
      const copy = node('div', 'claim-copy');
      copy.append(node('strong', '', claim.resourceKey || 'Claim key withheld; enter your known key to release'), node('span', 'muted small', `${claim.ownerLabel || claim.ownerSessionId} · claimed ${formatTime(claim.claimedAt)}`));
      item.append(copy);
      if (canManage && claim.ownerSessionId === session.id && claim.resourceKey) {
        const release = node('button', 'button button-quiet button-small', 'Release');
        release.type = 'button';
        release.addEventListener('click', () => releaseClaim(session, claim.resourceKey));
        item.append(release);
      }
      el.claims.append(item);
    }
  }

  function canAcknowledge(message) {
    if (isObserver() || message.acknowledgedAt) return false;
    if (isOwner()) return message.toSessionId == null && message.kind === 'QUESTION' && message.fromSessionId != null;
    return Boolean(message.reviewState === 'APPROVED' && message.toSessionId && message.toPrincipalId === state.principal?.id);
  }

  function canAnswerAsOwner(message) {
    return isOwner() && message.kind === 'QUESTION' && message.toSessionId == null && Boolean(message.fromSessionId);
  }

  function renderMessages() {
    clear(el.messageList);
    const messages = [...state.messages].sort((a, b) => (conversationView() ? b.id - a.id : b.deliveryCursor - a.deliveryCursor));
    const session = selectedSession();
    el.drawerTitle.textContent = session ? session.label || session.id : state.messageMode === 'owner' ? 'Owner inbox' : isObserver() ? 'Project conversations' : 'Workspace messages';
    el.drawerEyebrow.textContent = session ? 'Session conversation' : state.messageMode === 'owner' ? 'Questions for the human owner' : 'Across sessions';
    el.detailsWrap.hidden = !session;
    el.compose.hidden = !session || isObserver() || !el.messageForm.hidden;
    el.messageSearch.placeholder = session ? 'Search this session’s messages' : state.messageMode === 'owner' ? 'Search owner questions' : 'Search workspace messages';
    el.messageScope.textContent = session
      ? `${session.project} · ${session.principalName || session.account} · ${isObserver() ? 'Read-only conversation' : isOwner() ? 'Messages sent and received by this session' : 'Messages involving your account and this session'}`
      : state.messageMode === 'owner' ? 'Questions addressed to the human owner. Only the owner can answer or acknowledge; project observers can read.' : isObserver() ? 'Enrolled projects · all conversations, including owner questions · read-only' : isOwner() ? 'All sessions' : 'All sessions · messages sent or received by this account';
    el.messageCount.textContent = `${messages.length}${state.hasMoreMessages ? '+' : ''}`;
    el.messageCount.title = `${messages.length} messages loaded${state.hasMoreMessages ? '; more history is available' : ''}.`;
    el.messageEmpty.textContent = state.messageLoading ? 'Loading messages…' : 'No messages match this view yet.';
    el.loadOlder.disabled = state.messageLoading;
    el.messageEmpty.hidden = messages.length !== 0;
    for (const message of messages) {
      const card = node('article', `message-card${message.acknowledgedAt ? ' is-acknowledged' : ''}`);
      const top = node('div', 'message-top');
      top.append(node('span', `message-kind kind-${String(message.kind).toLowerCase()}`, MESSAGE_LABELS[message.kind] || message.kind));
      if (session) top.append(node('span', 'muted small', message.toSessionId === session.id ? 'Received' : message.fromSessionId === session.id ? 'Sent' : 'Earlier registration'));
      top.append(node('time', 'muted small', formatTime(message.createdAt)));
      const sender = message.fromPrincipalName || (message.fromSessionId ? 'Agent session' : 'Owner');
      const recipient = message.toPrincipalName || (message.toSessionId ? 'Targeted session' : 'Owner inbox');
      card.append(top, node('p', 'message-route', `${sender} → ${recipient} · ${message.project}`));
      const sessionName = id => state.sessions.find(item => item.id === id)?.label || (id === session?.id ? session.label : id);
      const route = node('p', 'message-route', `${message.fromSessionId ? sessionName(message.fromSessionId) : 'Human owner'} → ${message.toSessionId ? sessionName(message.toSessionId) : 'Owner inbox'}`);
      route.title = `From: ${message.fromSessionId || 'Human owner'} · To: ${message.toSessionId || 'Owner inbox'}`;
      card.append(route);
      card.append(node('p', 'message-body-text', message.body));
      card.append(node('p', 'message-warning', 'Untrusted coordination evidence · acknowledgment is not approval'));
      card.append(node('p', 'message-review-state', message.toSessionId ? message.reviewState === 'APPROVED' ? 'Delivered through authorized enrollment' : `Historical delivery: ${message.reviewState || 'Unknown'}` : 'Question for the human owner only'));
      if (message.replyTo != null) card.append(node('span', 'muted small', `Reply to message ${message.replyTo}`));
      const actions = node('div', 'message-actions');
      if (canAcknowledge(message)) {
        const acknowledge = node('button', 'button button-secondary button-small', 'Acknowledge receipt');
        acknowledge.type = 'button';
        acknowledge.addEventListener('click', () => acknowledgeMessage(message));
        actions.append(acknowledge);
      }
      if (canAnswerAsOwner(message)) {
        const answer = node('button', 'button button-quiet button-small', 'Answer question');
        answer.type = 'button';
        answer.addEventListener('click', () => prepareReply(message));
        actions.append(answer);
      }
      if (message.acknowledgedAt) actions.append(node('span', 'acknowledged-label', `Received ${formatTime(message.acknowledgedAt)}`));
      if (actions.childElementCount) card.append(actions);
      el.messageList.append(card);
    }
    el.loadOlder.hidden = !state.hasMoreMessages;
  }

  function resetMessageView() {
    state.messageGeneration += 1;
    state.messages = [];
    state.messageBefore = null;
    state.messageViewKey = null;
    state.messageViewSessionId = null;
    state.messageViewKind = null;
    state.messageViewReviewState = null;
    state.hasMoreMessages = false;
    state.messageLoading = false;
  }

  async function refreshMessages({ reset = false, older = false } = {}) {
    if (!state.principal || !el.drawer.open) return;
    const sessionId = state.selectedSessionId;
    const kind = el.messageFilter.value;
    const project = selectedSession()?.project || visibleProject();
    const search = el.messageSearch.value.trim();
    const viewKey = JSON.stringify([sessionId, state.messageMode, project, search]);
    const reviewState = conversationView() ? el.reviewFilter.value : '';
    const resetView = reset || state.messageViewKey !== viewKey || state.messageViewSessionId !== sessionId || state.messageViewKind !== kind || state.messageViewReviewState !== reviewState;
    if (!resetView && state.messageLoading) return;
    if (older && !resetView && !state.hasMoreMessages) return;
    const generation = state.generation;
    const requestId = ++state.messageGeneration;
    const isCurrent = () => generation === state.generation && requestId === state.messageGeneration &&
      el.drawer.open && sessionId === state.selectedSessionId && viewKey === JSON.stringify([state.selectedSessionId, state.messageMode, selectedSession()?.project || visibleProject(), el.messageSearch.value.trim()]) && kind === el.messageFilter.value && reviewState === (conversationView() ? el.reviewFilter.value : '');
    // One recent page per explicit refresh. History is fetched only on demand.
    const query = older && !resetView
      ? new URLSearchParams({ before: String(state.messageBefore) })
      : new URLSearchParams({ latest: '1' });
    if (sessionId) query.set('sessionId', sessionId);
    if (project) query.set('project', project);
    if (search) query.set('q', search);
    if (state.messageMode === 'owner') query.set('scope', 'owner');
    if (kind) query.set('kind', kind);
    if (reviewState) query.set('reviewState', reviewState);
    if (resetView) state.messages = [];
    state.messageLoading = true;
    renderMessages();
    try {
      const payload = await request(`/${isObserver() ? 'conversations' : 'messages'}?${query.toString()}`);
      if (!isCurrent()) return;
      const incoming = payload.messages || [];
      if (resetView || !older) {
        state.messages = incoming;
        state.messageBefore = payload.nextBefore ?? null;
        state.hasMoreMessages = state.messageBefore !== null;
        state.messageViewKey = viewKey;
        state.messageViewSessionId = sessionId;
        state.messageViewKind = kind;
        state.messageViewReviewState = reviewState;
      } else if (older) {
        const known = new Set(state.messages.map((message) => message.id));
        state.messages.unshift(...incoming.filter((message) => !known.has(message.id)));
        state.messageBefore = payload.nextBefore ?? null;
        state.hasMoreMessages = state.messageBefore !== null;
      }
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (isCurrent()) {
        state.messageLoading = false;
        renderMessages();
      }
    }
  }

  async function refreshOwnership() {
    const session = selectedSession();
    if (!session) { state.ownership = []; renderClaims(); return; }
    const generation = state.generation;
    const sessionId = session.id;
    const payload = await request(`/ownership?project=${encodeURIComponent(session.project)}`);
    if (generation !== state.generation || selectedSession()?.id !== sessionId) return;
    state.ownership = payload.ownership || [];
    renderClaims();
  }

  async function refreshPrincipals() {
    if (!isOwner()) { state.principals = []; return; }
    const generation = state.generation;
    const payload = await request('/principals');
    if (generation !== state.generation) return;
    state.principals = payload.principals || [];
    renderPrincipals();
  }

  function renderPrincipals() {
    clear(el.principalList);
    const invites = state.principals.filter((principal) => principal.role === 'agent' && principal.active === true);
    if (!invites.length) el.principalList.append(node('p', 'muted small', 'No active agent invites.'));
    for (const principal of invites) {
      const item = node('article', 'principal-item');
      const copy = node('div', 'principal-copy');
      copy.append(node('strong', '', principal.name), node('span', 'muted small', `${principal.account} · ${principal.profile === 'observer' ? 'Project observer' : 'Agent'} · ${(principal.projects || []).join(', ')}`));
      const revoke = node('button', 'button button-danger button-small', 'Revoke');
      revoke.type = 'button';
      revoke.addEventListener('click', () => revokePrincipal(principal));
      item.append(copy, revoke);
      el.principalList.append(item);
    }
  }

  function renderAll() {
    const projects = state.principal.projects ?? [];
    const projectSummary = isOwner() || projects.includes('*') ? 'All projects' : projects.length ? `Projects: ${projects.join(', ')}` : 'No projects';
    el.summary.textContent = isOwner()
      ? `Workspace owner · ${projectSummary}`
      : `Name: ${state.principal.name} · Account: ${state.principal.account} · Role: ${isObserver() ? 'Project observer' : 'Agent'} · ${projectSummary}`;
    el.ownerTools.hidden = !isOwner();
    el.reviewFilterWrap.hidden = !conversationView();
    el.openOwnerInbox.hidden = !conversationView();
    el.askOwner.hidden = isOwner() || isObserver();
    el.openAllMessages.textContent = isObserver() ? 'Project conversations' : 'Workspace messages';
    el.inboxAccessNote.textContent = isObserver() ? 'Your project observer invitation includes owner questions. You can read conversations, but cannot send, answer or acknowledge messages.' : isOwner() ? 'Owner inbox contains questions for you. Project observers may read them; replies and receipts belong to you.' : 'Your workspace view includes messages sent or received by this account. Ask the owner sends a question from one of your sessions.';
    el.connectionHistory.hidden = !isOwner();
    for (const select of [el.agentNameFilter, el.agentModelFilter, el.machineFilter, el.branchFilter, el.environmentFilter]) select.disabled = false;
    renderSelectors();
    renderSummary();
    renderSessions();
    renderSessionDetail();
    renderMessages();
  }

  async function refresh({ quiet = false } = {}) {
    if (!state.token || document.hidden) return;
    if (state.refreshing) {
      state.refreshRequested = true;
      return;
    }
    state.refreshing = true;
    state.refreshRequested = false;
    const generation = state.generation;
    try {
      const query = sessionQuery();
      const sessionPayload = await request(`/sessions${query}`);
      if (generation !== state.generation) return;
      if (query !== sessionQuery()) {
        state.refreshRequested = true;
        return;
      }
      state.sessions = sessionPayload.sessions || [];
      const filterOptions = sessionPayload.filterOptions;
      if (filterOptions && typeof filterOptions === 'object') {
        state.sessionFilterOptions = {
          agentNames: Array.isArray(filterOptions.agentNames) ? filterOptions.agentNames : [],
          agentModels: Array.isArray(filterOptions.agentModels) ? filterOptions.agentModels : [],
          machines: Array.isArray(filterOptions.machines) ? filterOptions.machines : [],
          environments: Array.isArray(filterOptions.environments) ? filterOptions.environments : [],
          branches: Array.isArray(filterOptions.branches) ? filterOptions.branches : [],
        };
      }
      state.sessionSummary = sessionPayload.summary ?? null;
      state.sessionTotal = Number.isFinite(sessionPayload.total) ? sessionPayload.total : state.sessions.length;
      state.sessionLimit = Number.isFinite(sessionPayload.limit) && sessionPayload.limit > 0 ? sessionPayload.limit : 200;
      if (state.selectedSessionId) {
        const updated = state.sessions.find(session => session.id === state.selectedSessionId);
        if (updated) state.selectedSessionSnapshot = updated;
      }
      await refreshPrincipals();
      if (generation !== state.generation) return;
      if (query !== sessionQuery()) {
        state.refreshRequested = true;
        return;
      }
      renderAll();
      await Promise.all([
        refreshOwnership(),
        refreshMessages(),
        ...(quiet ? [] : [loadAttribution(selectedSession()?.id, { reset: true })]),
      ]);
      if (!quiet) toast('Board refreshed.');
    } catch (error) {
      if (!(error instanceof StaleRequestError) && !quiet) toast(error.message || 'Could not refresh the board.', 'error');
    } finally {
      if (generation === state.generation) {
        state.refreshing = false;
        if (state.refreshRequested && state.token && !document.hidden) {
          state.refreshRequested = false;
          await refresh({ quiet: true });
        }
      }
    }
  }

  function discardComposer() {
    state.composeGeneration += 1;
    state.composeTarget = null;
    state.pendingSend = null;
    state.senderSessions = [];
    el.messageForm.hidden = true;
    el.messageForm.reset();
    el.sendMessage.textContent = '';
    el.messageKind.disabled = false;
    clearReply();
  }

  function showDrawer(mode, session = null) {
    state.drawerReturn = document.activeElement;
    state.drawerReturnSessionId = session?.id || '';
    discardComposer();
    state.messageMode = mode;
    state.selectedSessionId = session?.id || '';
    state.selectedSessionSnapshot = session;
    el.messageSearch.value = '';
    el.messageFilter.value = '';
    el.reviewFilter.value = '';
    el.detailsWrap.open = false;
    resetMessageView();
    renderSessions();
    renderSessionDetail();
    renderMessages();
    if (!el.drawer.open) el.drawer.showModal();
    el.closeDrawer.focus();
  }

  async function selectSession(sessionId, { compose = false } = {}) {
    const session = state.sessions.find(item => item.id === sessionId);
    if (!session) return;
    showDrawer('session', session);
    const generation = state.generation;
    try {
      await Promise.all([refreshOwnership(), loadAttribution(sessionId, { reset: true }), refreshMessages({ reset: true }), ...(compose ? [openComposer(session)] : [])]);
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation && state.selectedSessionId === sessionId) toast(error.message, 'error'); }
  }

  async function openComposer(session, { ownerQuestion = false, reply = null } = {}) {
    if (isObserver()) return;
    discardComposer();
    const generation = state.generation, composeId = ++state.composeGeneration;
    state.composeTarget = { sessionId: ownerQuestion ? null : session.id, project: session?.project || '', ownerQuestion };
    state.replyTo = reply;
    el.messageForm.hidden = false;
    el.compose.hidden = true;
    el.composeRecipient.textContent = ownerQuestion ? 'To: Human owner inbox · Question from your selected session' : `To: ${session.label || session.id} · ${session.project}`;
    el.composeAs.textContent = isOwner() ? 'As owner' : `As ${state.principal.name}`;
    el.fromSessionWrap.hidden = isOwner();
    el.fromSession.required = !isOwner();
    el.messageKind.value = ownerQuestion ? 'QUESTION' : reply ? 'ANSWER' : 'NOTE';
    el.messageKind.disabled = ownerQuestion || Boolean(reply);
    el.replyContext.hidden = !reply;
    el.replyContext.textContent = reply ? `Answering question #${reply.id} from ${reply.fromPrincipalName || 'agent'}.` : '';
    el.sendButton.disabled = state.sending || !isOwner();
    clear(el.fromSession);
    option(el.fromSession, '', 'Loading your sessions…');
    if (!isOwner()) {
      try {
        // Composer discovery is independent of board search and status filters.
        const query = new URLSearchParams({ limit: '200', owned: '1' });
        if (!ownerQuestion) query.set('project', session.project);
        const available = new Map();
        let offset = 0;
        while (true) {
          if (offset) query.set('offset', String(offset));
          const payload = await request(`/sessions?${query}`);
          if (generation !== state.generation || composeId !== state.composeGeneration || !el.drawer.open) return;
          for (const item of payload.sessions || []) if (ownsSession(item) && !item.archivedAt && (ownerQuestion || item.id !== session.id)) available.set(item.id, item);
          if (payload.nextOffset == null) break;
          if (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset || payload.nextOffset > 2000) throw new Error('Could not finish loading your sending sessions.');
          offset = payload.nextOffset;
        }
        state.senderSessions = [...available.values()];
        clear(el.fromSession);
        option(el.fromSession, '', 'Choose your sending session');
        for (const sender of state.senderSessions) option(el.fromSession, sender.id, `${sender.label || sender.id} · ${sender.project}`);
        if (state.senderSessions.length === 1) el.fromSession.value = state.senderSessions[0].id;
        el.sendButton.disabled = state.sending || !state.senderSessions.length;
        if (!state.senderSessions.length) el.sendMessage.textContent = 'No eligible sending session for this account. Register a session in the recipient’s project first.';
        updateSenderProject();
      } catch (error) {
        if (generation === state.generation && composeId === state.composeGeneration && !(error instanceof StaleRequestError)) el.sendMessage.textContent = error.message;
        return;
      }
    }
    if (generation !== state.generation || composeId !== state.composeGeneration || !el.drawer.open) return;
    el.messageBody.focus();
    el.messageForm.scrollIntoView({ block: 'nearest' });
  }

  function updateSenderProject() {
    if (!state.composeTarget?.ownerQuestion) return;
    const sender = state.senderSessions.find(item => item.id === el.fromSession.value);
    state.composeTarget.project = sender?.project || '';
  }

  function prepareReply(message) {
    const session = state.sessions.find(item => item.id === message.fromSessionId) || { id: message.fromSessionId, label: message.fromPrincipalName + '’s session', project: message.project };
    openComposer(session, { reply: message });
  }

  function clearReply() {
    state.replyTo = null;
    el.replyContext.hidden = true;
    el.replyContext.textContent = '';
    el.messageBody.placeholder = 'Share coordination context. Keep secrets and approval packets out of messages.';
  }

  async function acknowledgeMessage(message) {
    const generation = state.generation;
    try {
      const body = !isOwner() && message.toSessionId ? { sessionId: message.toSessionId } : {};
      const payload = await request(`/messages/${encodeURIComponent(message.id)}/ack`, { method: 'POST', body: JSON.stringify(body) });
      if (generation !== state.generation) return;
      state.messages = state.messages.map((item) => item.id === message.id ? payload.message : item);
      renderMessages();
      toast('Receipt acknowledged. This is not an approval.');
      await refreshMessages();
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) toast(error.message, 'error'); }
  }

  async function releaseClaim(session, resourceKey) {
    if (!ownsSession(session)) return;
    if (!window.confirm(`Release your claim on “${resourceKey}” for ${session.project}?`)) return;
    const generation = state.generation;
    try {
      await request('/ownership/release', { method: 'POST', body: JSON.stringify({ sessionId: session.id, resourceKey }) });
      if (generation !== state.generation) return;
      setText(el.claimMessage, 'Claim released.');
      await refreshOwnership();
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) setText(el.claimMessage, error.message); }
  }

  async function revokePrincipal(principal) {
    if (!window.confirm(`Revoke ${principal.name}’s hub invite? This removes coordination access only.`)) return;
    const generation = state.generation;
    try {
      await request(`/principals/${encodeURIComponent(principal.id)}`, { method: 'DELETE' });
      if (generation !== state.generation) return;
      toast(`Invite for ${principal.name} revoked.`);
      await refreshPrincipals();
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) toast(error.message, 'error'); }
  }

  async function refreshConnectionHistory(older = false) {
    if(!isOwner() || state.connectionLoading) return;
    const generation=state.generation,requestId=++state.connectionGeneration;
    const isCurrent=()=>generation===state.generation && requestId===state.connectionGeneration;
    state.connectionLoading=true;
    el.refreshConnections.disabled=true;el.olderConnections.disabled=true;
    el.connectionStatus.textContent='Loading connection history…';
    try {
      const query=new URLSearchParams({limit:'20'});
      if(older && state.connectionBefore!==null) query.set('before',String(state.connectionBefore));
      const payload=await request(`/connections?${query}`);
      if(!isCurrent()) return;
      const incoming=payload.connections??[];
      if(older){const known=new Set(state.connections.map(c=>c.id));state.connections.push(...incoming.filter(c=>!known.has(c.id)));}
      else state.connections=incoming;
      state.connectionBefore=payload.nextBefore??null;
      clear(el.connectionList);
      for(const connection of state.connections){
        const item=node('article','principal-item'),copy=node('div','principal-copy');
        copy.append(node('strong','',connection.principalName),node('span','muted small',`${formatTime(connection.connectedAt)} · ${connection.client} (reported)${connection.active ? '' : ' · revoked'}`),node('span','muted small',`Identity: ${connection.principalId}`));
        item.append(copy);el.connectionList.append(item);
      }
      el.connectionStatus.textContent=state.connections.length ? `${state.connections.length} connections shown.` : 'No recorded connections yet.';
      el.olderConnections.hidden=state.connectionBefore===null;
    } catch(error) {if(isCurrent() && !(error instanceof StaleRequestError)) el.connectionStatus.textContent=error.message;}
    finally {if(isCurrent()){state.connectionLoading=false;el.refreshConnections.disabled=false;el.olderConnections.disabled=false;}}
  }

  el.refreshConnections.addEventListener('click',()=>refreshConnectionHistory());
  el.olderConnections.addEventListener('click',()=>refreshConnectionHistory(true));

  async function startSession() {
    const generation = state.generation;
    const me = await request('/me');
    if(generation !== state.generation) return;
    await request('/connections', {method:'POST',body:JSON.stringify({connectionId:crypto.randomUUID(),client:'web'})});
    if (generation !== state.generation) return;
    state.principal = me.principal;
    showConnection(true);
    await refresh({ quiet: true });
  }

  function disconnect() {
    state.generation += 1;
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    state.refreshing = false;
    state.refreshRequested = false;
    state.token = null;
    state.principal = null;
    state.sessions = [];
    state.sessionFilterOptions = { agentNames: [], agentModels: [], machines: [], environments: [], branches: [] };
    state.sessionTotal = 0;
    state.sessionLimit = 200;
    state.messages = [];
    state.ownership = [];
    state.principals = [];
    state.connections = [];
    state.connectionBefore = null;
    state.connectionLoading = false;
    state.connectionGeneration += 1;
    el.refreshConnections.disabled=false;
    el.olderConnections.disabled=false;
    clear(el.connectionList);
    el.connectionStatus.textContent = 'Refresh to view connections.';
    el.olderConnections.hidden = true;
    el.connectionHistory.hidden = true;
    if (el.drawer.open) el.drawer.close();
    discardComposer();
    clearTimeout(state.searchTimer);
    clearTimeout(state.messageSearchTimer);
    el.sessionSearch.value = '';
    el.messageSearch.value = '';
    state.selectedSessionSnapshot = null;
    state.selectedSessionId = '';
    state.attributionGeneration += 1;
    state.attribution = { sessionId: '', segments: [], cursor: null, hasMore: false, loading: false, error: '' };
    resetMessageView();
    el.messageFilter.value = '';
    el.reviewFilter.value = '';
    el.reviewFilterWrap.hidden = true;
    state.replyTo = null;
    el.connectToken.value = '';
    el.projectFilter.value = '';
    el.agentNameFilter.value = '';
    el.agentModelFilter.value = '';
    el.environmentFilter.value = '';
    el.machineFilter.value = '';
    el.branchFilter.value = '';
    state.sessionSummary = null;
    el.statusFilter.value = 'ALL';
    el.staleFilter.checked = false;
    el.tokenValue.textContent = '';
    el.tokenPanel.hidden = true;
    clear(el.sessions); clear(el.messageList); clear(el.claims); clear(el.principalList);
    clear(el.detailContent); clear(el.releaseDetails); clear(el.detailStatus);
    el.detailTitle.textContent = '';
    clear(attributionPanel.list);
    attributionPanel.status.textContent = 'Select a session to view its attribution history.';
    attributionPanel.more.hidden = true;
    attributionPanel.panel.hidden = true;
    el.detail.hidden = true;
    el.ownerTools.hidden = true;
    el.claimForm.hidden = true;
    el.sendMessage.textContent = '';
    el.inviteMessage.textContent = '';
    el.claimMessage.textContent = '';
    el.setupFallback.hidden = true;
    el.setupText.value = '';
    showConnection(false);
  }

  el.connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = el.connectToken.value.trim();
    if (!token) return;
    disconnect();
    state.token = token;
    const generation = state.generation;
    el.connectToken.value = '';
    try {
      await startSession();
      if (generation === state.generation && state.token) toast('Connected. Your token is held in memory for this tab.');
    } catch (error) {
      if (generation === state.generation) {
        disconnect();
        if (!(error instanceof StaleRequestError)) toast(error.message || 'Connection failed.', 'error');
      }
    }
  });

  el.logout.addEventListener('click', disconnect);
  el.copyAgentSetup.addEventListener('click', async () => {
    el.copyAgentSetup.disabled = true;
    const generation = state.generation;
    try {
      const response = await fetch('/agent-setup.txt', { cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('Could not load agent setup instructions. Open the setup guide instead.');
      const instructions = (await response.text()).replaceAll('{{HUB_URL}}', location.origin);
      if (generation !== state.generation) return;
      try {
        await navigator.clipboard.writeText(instructions);
        if (generation !== state.generation) return;
        el.setupFallback.hidden = true;
        el.setupText.value = '';
        toast('Agent setup copied. Share it with the agent you want to connect.');
      } catch {
        if (generation !== state.generation) return;
        el.setupText.value = instructions;
        el.setupFallback.hidden = false;
        el.setupText.focus();
        el.setupText.select();
      }
    } catch (error) {
      if (generation === state.generation) toast(error.message || 'Could not load agent setup instructions. Open the setup guide instead.', 'error');
    } finally { el.copyAgentSetup.disabled = false; }
  });
  el.closeSetup.addEventListener('click', () => {
    el.setupFallback.hidden = true;
    el.setupText.value = '';
    el.copyAgentSetup.focus();
  });
  el.refresh.addEventListener('click', () => refresh());
  el.projectFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.agentNameFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.agentModelFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.environmentFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.machineFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.branchFilter.addEventListener('change', () => refresh({ quiet: true }));
  el.statusFilter.addEventListener('change', () => { renderSessions(); refresh({ quiet: true }); });
  el.staleFilter.addEventListener('change', () => { renderSessions(); refresh({ quiet: true }); });
  for (const [chip, status] of [[el.summaryRunning, 'RUNNING'], [el.summaryWaitingUser, 'WAITING_ON_USER'], [el.summaryWaitingAgent, 'WAITING_ON_AGENT'], [el.summaryBlocked, 'BLOCKED']]) {
    chip.addEventListener('click', () => {
      el.statusFilter.value = el.statusFilter.value === status ? 'ALL' : status;
      renderSessions();
      refresh({ quiet: true });
    });
  }
  el.summaryStale.addEventListener('click', () => {
    el.staleFilter.checked = !el.staleFilter.checked;
    renderSessions();
    refresh({ quiet: true });
  });
  el.messageFilter.addEventListener('change', async () => {
    resetMessageView();
    renderMessages();
    try { await refreshMessages({ reset: true }); } catch (error) { if (!(error instanceof StaleRequestError)) toast(error.message, 'error'); }
  });
  el.reviewFilter.addEventListener('change', async () => {
    resetMessageView();
    renderMessages();
    try { await refreshMessages({ reset: true }); } catch (error) { if (!(error instanceof StaleRequestError)) toast(error.message, 'error'); }
  });
  el.sessionSearch.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => refresh({ quiet: true }), 250);
  });
  el.messageSearch.addEventListener('input', () => {
    clearTimeout(state.messageSearchTimer);
    state.messageSearchTimer = setTimeout(async () => {
      try { await refreshMessages({ reset: true }); } catch (error) { if (!(error instanceof StaleRequestError)) toast(error.message, 'error'); }
    }, 250);
  });
  el.fromSession.addEventListener('change', updateSenderProject);
  el.compose.addEventListener('click', () => openComposer(selectedSession()));
  el.cancelCompose.addEventListener('click', () => { discardComposer(); renderMessages(); (el.compose.hidden ? el.closeDrawer : el.compose).focus(); });
  el.closeDrawer.addEventListener('click', () => el.drawer.close());
  el.drawer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); el.drawer.close(); }
  });
  el.drawer.addEventListener('close', () => {
    discardComposer();
    el.workspace.append(el.toast);
    resetMessageView();
    state.selectedSessionId = '';
    state.selectedSessionSnapshot = null;
    renderSessions();
    const returnCard = [...el.sessions.children].find(item => item.dataset.sessionId === state.drawerReturnSessionId);
    (returnCard?.querySelector('.session-select') || state.drawerReturn)?.focus();
    state.drawerReturn = null;
    state.drawerReturnSessionId = '';
  });
  async function openWorkspaceMessages(mode) {
    showDrawer(mode);
    try { await refreshMessages({ reset: true }); } catch (error) { if (!(error instanceof StaleRequestError)) toast(error.message, 'error'); }
  }
  el.openAllMessages.addEventListener('click', () => openWorkspaceMessages('workspace'));
  el.openOwnerInbox.addEventListener('click', () => openWorkspaceMessages('owner'));
  el.askOwner.addEventListener('click', () => { showDrawer('workspace'); openComposer(null, { ownerQuestion: true }); refreshMessages({ reset: true }).catch(error => toast(error.message, 'error')); });

  el.claimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = selectedSession();
    const resourceKey = el.claimResource.value.trim();
    if (!ownsSession(session) || !resourceKey) return;
    const generation = state.generation;
    try {
      await request('/ownership/claim', { method: 'POST', body: JSON.stringify({ sessionId: session.id, resourceKey }) });
      if (generation !== state.generation) return;
      el.claimResource.value = '';
      setText(el.claimMessage, 'Claim recorded for this session.');
      await refreshOwnership();
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) setText(el.claimMessage, error.message); }
  });

  el.releaseEnteredClaim.addEventListener('click', async () => {
    const session = selectedSession();
    const resourceKey = el.claimResource.value.trim();
    if (ownsSession(session) && resourceKey) await releaseClaim(session, resourceKey);
  });

  el.messageForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = state.composeTarget;
    if (!target || state.sending) return;
    const project = target.project;
    const fromSessionId = isOwner() ? undefined : el.fromSession.value;
    const toSessionId = target.sessionId || undefined;
    const kind = el.messageKind.value;
    const body = el.messageBody.value.trim();
    if (!project || !body || (!isOwner() && !state.senderSessions.some(item => item.id === fromSessionId && item.project === project))) {
      setText(el.sendMessage, 'Choose your sending session and enter a message.');
      return;
    }
    if (!toSessionId && (!target.ownerQuestion || isOwner() || kind !== 'QUESTION')) return;
    const payload = {
      ...(fromSessionId ? { fromSessionId } : {}),
      ...(toSessionId ? { toSessionId } : {}),
      project, kind, body,
      ...(state.replyTo ? { replyTo: state.replyTo.id } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (state.pendingSend?.fingerprint !== fingerprint) state.pendingSend = { fingerprint, key: crypto.randomUUID() };
    payload.idempotencyKey = state.pendingSend.key;
    const generation = state.generation, composeId = state.composeGeneration;
    state.sending = true;
    el.sendButton.disabled = true;
    try {
      await request('/messages', { method: 'POST', body: JSON.stringify(payload) });
      if (generation !== state.generation) return;
      toast(toSessionId ? 'Message sent.' : 'Question sent to the owner inbox.');
      if (composeId !== state.composeGeneration) return;
      state.pendingSend = null;
      el.messageBody.value = '';
      setText(el.sendMessage, toSessionId ? 'Message delivered to the selected recipient.' : 'Question submitted to the human owner inbox.');
      clearReply();
      el.messageKind.disabled = target.ownerQuestion;
      try { await refreshMessages({ reset: true }); }
      catch (error) { if (!(error instanceof StaleRequestError)) toast(`Message sent. Could not refresh messages: ${error.message}`, 'error'); }
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation && composeId === state.composeGeneration) setText(el.sendMessage, error.message); }
    finally { state.sending = false; el.sendButton.disabled = !isOwner() && !state.senderSessions.length; }
  });

  el.loadOlder.addEventListener('click', async () => {
    try { await refreshMessages({ older: true }); } catch (error) { if (!(error instanceof StaleRequestError)) toast(error.message, 'error'); }
  });

  el.inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const projects = [...new Set($('invite-projects').value.split(',').map((item) => item.trim()).filter(Boolean))];
    if (!projects.length || projects.some((project) => project === '*' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project))) { setText(el.inviteMessage, 'Enter one or more exact project slugs (letters, numbers, and single hyphens).'); return; }
    const generation = state.generation;
    try {
      const payload = await request('/principals', {
        method: 'POST',
        body: JSON.stringify({ name: $('invite-name').value.trim(), account: $('invite-account').value.trim(), projects, profile:$('invite-profile').value }),
      });
      if (generation !== state.generation) return;
      el.inviteForm.reset();
      el.tokenValue.textContent = payload.token;
      el.tokenPanel.hidden = false;
      setText(el.inviteMessage, 'Invite created. Copy the one-time token before dismissing it.');
      await refreshPrincipals();
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) setText(el.inviteMessage, error.message); }
  });

  el.archiveSession.addEventListener('click', async () => {
    const session = selectedSession();
    if (!ownsSession(session) || session.status !== 'DONE' || session.archivedAt) return;
    if (!window.confirm('Archive this completed session? It will be hidden from the live board.')) return;
    const generation = state.generation;
    try {
      await request(`/sessions/${encodeURIComponent(session.id)}/archive`, { method: 'POST', body: '{}' });
      if (generation !== state.generation) return;
      toast('Completed session archived.');
      el.drawer.close();
      await refresh({ quiet: true });
    } catch (error) { if (!(error instanceof StaleRequestError) && generation === state.generation) toast(error.message, 'error'); }
  });

  el.dismissToken.addEventListener('click', () => {
    el.tokenValue.textContent = '';
    el.tokenPanel.hidden = true;
  });

})();
