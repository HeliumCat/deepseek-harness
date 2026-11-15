'use strict'

/**
 * The pet page. It polls the worker's token-gated snapshot/detail/history API,
 * draws one icon per running subagent, and opens the delegation detail panel.
 * All worker-provided text is inserted with textContent; no HTML is parsed from
 * the API.
 */

const TOKEN = new URLSearchParams(location.search).get('token')
const BASE = location.pathname.replace(/\/+$/u, '')
const API = `${BASE}/api/`
const LANG = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'

const STRINGS = {
  en: {
    history: 'History',
    bubbleIdle: 'Waiting for Codex',
    bubbleAnalyzing: 'Analyzing a delegation…',
    bubbleWorking: (n) => `${n} subagent${n === 1 ? '' : 's'} working`,
    bubbleOffline: 'Worker offline — retrying…',
    bubbleUnauthorized: 'Open the token-carrying pet URL printed by dsh',
    overview: 'Overview',
    run: 'Run',
    result: 'Result',
    delegate: 'Codex delegation',
    dispatch: 'Dispatched',
    acceptance: 'Acceptance',
    subagents: 'Subagents',
    mainRun: 'Worker run',
    finalResult: 'Returned result',
    task: 'Task',
    criteria: 'Acceptance criteria',
    expected: 'Expected return',
    noAcceptance: 'The worker has not recorded a verdict yet.',
    accepted: 'Accepted',
    rejected: 'Rejected',
    notRecorded: 'Not recorded',
    historyTitle: 'Delegation history',
    historyMeta: (count, limit) => `${count} retained · cap ${limit}`,
    filter: 'Filter by conversation or task',
    noHistory: 'No delegations have been recorded yet.',
    emptyGroup: 'No records match this filter.',
    configTitle: 'Connect Codex',
    configHint: 'Add this server to ~/.codex/config.toml. The URL already carries this worker\'s access token.',
    copy: 'Copy Codex config',
    copied: 'Codex config copied',
    waitFirst: 'Waiting for the first message…',
    waitingResult: 'The worker is still running. The result appears here when it settles.',
    mainSession: 'Worker session',
    subagent: 'Subagent',
    reasoning: 'Reasoning',
    arguments: 'Arguments',
    showMore: 'Show more',
    showLess: 'Show less',
    copyFailed: 'Could not copy to the clipboard',
    status: { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
    subStatus: { running: 'Running', completed: 'Completed', aborted: 'Aborted', error: 'Failed', 'max-tokens': 'Token limit', refusal: 'Refused', unknown: 'Unknown' },
  },
  zh: {
    history: '历史',
    bubbleIdle: '等待 Codex 调用',
    bubbleAnalyzing: '正在分析 delegate…',
    bubbleWorking: (n) => `${n} 个 subagent 正在工作`,
    bubbleOffline: 'worker 已离线，正在重试…',
    bubbleUnauthorized: '请打开 dsh 打印的带 token 的桌宠链接',
    overview: '概览',
    run: '运行过程',
    result: '返回结果',
    delegate: 'Codex 派发内容',
    dispatch: '派发时间',
    acceptance: '验收情况',
    subagents: 'Subagents',
    mainRun: '主 Agent 运行过程',
    finalResult: '返回结果',
    task: '任务',
    criteria: '验收标准',
    expected: '期待返回',
    noAcceptance: 'worker 还没有记录验收结论。',
    accepted: '已通过',
    rejected: '未通过',
    notRecorded: '未记录',
    historyTitle: '派发历史',
    historyMeta: (count, limit) => `保留 ${count} 条 · 上限 ${limit}`,
    filter: '按 Codex session 或任务过滤',
    noHistory: '还没有任何派发记录。',
    emptyGroup: '没有匹配的记录。',
    configTitle: '连接 Codex',
    configHint: '把下面的配置加到 ~/.codex/config.toml。URL 已包含这个 worker 的访问 token。',
    copy: '复制 Codex 配置',
    copied: '已复制 Codex 配置',
    waitFirst: '等待第一条消息…',
    waitingResult: 'worker 仍在运行，结束后结果显示在这里。',
    mainSession: '主 Agent session',
    subagent: 'Subagent',
    reasoning: '推理',
    arguments: '参数',
    showMore: '展开',
    showLess: '收起',
    copyFailed: '无法写入剪贴板',
    status: { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' },
    subStatus: { running: '运行中', completed: '已完成', aborted: '已中止', error: '失败', 'max-tokens': '超出 token 上限', refusal: '模型拒绝', unknown: '未知' },
  },
}

const t = STRINGS[LANG]
const $ = (id) => document.getElementById(id)
const dom = {
  app: $('app'),
  stage: $('stage'),
  orbits: $('orbits'),
  bubble: $('bubble'),
  historyButton: $('history-button'),
  historyCount: $('history-count'),
  configButton: $('config-button'),
  panel: $('panel'),
  panelIcon: $('panel-icon'),
  panelName: $('panel-name'),
  panelMeta: $('panel-meta'),
  panelBody: $('panel-body'),
  panelClose: $('panel-close'),
  historyView: $('history-view'),
  historyMeta: $('history-meta'),
  historyBody: $('history-body'),
  historyClose: $('history-close'),
  historyFilter: $('history-filter'),
  configView: $('config-view'),
  configClose: $('config-close'),
  configSnippet: $('config-snippet'),
  copyConfig: $('copy-config'),
  toast: $('toast'),
}

const state = {
  snapshot: null,
  detail: null,
  detailId: null,
  focusSubagent: null,
  tab: 'overview',
  history: null,
  filter: '',
  icons: new Map(),
  leaving: new Set(),
  error: null,
  toastTimer: undefined,
  detailTimer: undefined,
  pollTimer: undefined,
}

document.documentElement.lang = LANG
document.title = LANG === 'zh' ? 'DSH 桌宠' : 'DSH Pet'
for (const element of document.querySelectorAll('[data-i18n]')) {
  const key = element.getAttribute('data-i18n')
  if (key !== null && typeof t[key] === 'string') element.textContent = t[key]
}

function statusLabel(status) {
  return (t.status && t.status[status]) || status
}
function subStatusLabel(status) {
  return (t.subStatus && t.subStatus[status]) || status
}
function badgeClass(status) {
  if (status === 'running' || status === 'queued') return 'live'
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'bad'
  return 'warn'
}

function relativeTime(ms) {
  const delta = Date.now() - ms
  if (!Number.isFinite(delta)) return ''
  if (delta < 5_000) return LANG === 'zh' ? '刚刚' : 'just now'
  if (delta < 60_000) return LANG === 'zh' ? `${Math.floor(delta / 1000)} 秒前` : `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return LANG === 'zh' ? `${Math.floor(delta / 60_000)} 分钟前` : `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return LANG === 'zh' ? `${Math.floor(delta / 3_600_000)} 小时前` : `${Math.floor(delta / 3_600_000)}h ago`
  return new Intl.DateTimeFormat(LANG === 'zh' ? 'zh-CN' : undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms)
}

function absoluteTime(ms) {
  return new Intl.DateTimeFormat(LANG === 'zh' ? 'zh-CN' : undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(ms)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function toast(message) {
  dom.toast.textContent = message
  dom.toast.hidden = false
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => { dom.toast.hidden = true }, 2_600)
}

async function getJson(path) {
  const url = new URL(`${API}${path}`, location.origin)
  if (TOKEN) url.searchParams.set('token', TOKEN)
  const response = await fetch(url, { cache: 'no-store' })
  if (response.status === 401) throw new Error('unauthorized')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function setBubble(text) {
  if (text === '') {
    dom.bubble.hidden = true
    return
  }
  dom.bubble.textContent = text
  dom.bubble.hidden = false
}

function setAppState(value) {
  dom.app.dataset.state = value
}

function panelOpen() {
  return !dom.panel.hidden || !dom.historyView.hidden || !dom.configView.hidden
}

function resizePanel(open) {
  if (window.petWindow && typeof window.petWindow.resize === 'function') {
    window.petWindow.resize(open ? 760 : 240, open ? 620 : 260)
  }
  document.body.classList.toggle('panel-open', open)
}

function showOnly(view) {
  dom.panel.hidden = view !== 'panel'
  dom.historyView.hidden = view !== 'history'
  dom.configView.hidden = view !== 'config'
  dom.app.classList.toggle('has-panel', view !== 'none')
  dom.stage.style.opacity = view === 'none' ? '' : '0.22'
  dom.stage.style.pointerEvents = view === 'none' ? '' : 'none'
  resizePanel(view !== 'none')
}

// Icons sit beside the character: the bubble occupies the space above it and
// the toolbar sits right below it, so only the side arcs stay free.
function orbitAngle(index, count) {
  const spread = 24
  if (count === 1) return 0
  const right = Math.ceil(count / 2)
  if (index < right) {
    return right === 1 ? 0 : -spread + (2 * spread) / (right - 1) * index
  }
  const left = count - right
  return left === 1 ? 180 : 180 - spread + (2 * spread) / (left - 1) * (index - right)
}

function renderIcons() {
  const snapshot = state.snapshot
  const active = snapshot === null ? [] : snapshot.active.flatMap(delegate => delegate.subagents.map(subagent => ({ ...subagent, delegate })))
  const seen = new Set(active.map(subagent => subagent.id))
  for (const [id, node] of state.icons) {
    if (seen.has(id) || state.leaving.has(id)) continue
    state.leaving.add(id)
    node.classList.add('leaving')
    setTimeout(() => {
      node.remove()
      state.icons.delete(id)
      state.leaving.delete(id)
    }, 240)
  }
  active.forEach((subagent, index) => {
    let node = state.icons.get(subagent.id)
    if (node === undefined) {
      node = document.createElement('button')
      node.type = 'button'
      node.className = 'orbit-icon running'
      node.addEventListener('click', () => { void openDelegate(subagent.delegateId, subagent.id) })
      dom.orbits.append(node)
      state.icons.set(subagent.id, node)
    }
    // Two icons sit left and right so they never cover the antenna or bubble.
    const angle = orbitAngle(index, active.length)
    const radius = active.length > 6 ? 74 : 64
    node.style.setProperty('--angle', `${angle}deg`)
    node.style.setProperty('--radius', `${radius}px`)
    node.style.setProperty('--ring', subagent.color)
    node.textContent = subagent.icon
    node.title = `${subagent.label || subagent.name} · ${subagent.codexSession}`
  })
  return active.length
}

function renderBubble(activeCount) {
  dom.app.dataset.busy = activeCount > 0 ? 'true' : 'false'
  if (state.error !== null) {
    setBubble(state.error === 'unauthorized' ? t.bubbleUnauthorized : t.bubbleOffline)
    return
  }
  const snapshot = state.snapshot
  if (snapshot === null) {
    setBubble('')
    return
  }
  if (activeCount > 0) {
    setBubble(t.bubbleWorking(activeCount))
    return
  }
  if (snapshot.active.length > 0) {
    setBubble(t.bubbleAnalyzing)
    return
  }
  setBubble(t.bubbleIdle)
}

async function loadSnapshot() {
  try {
    const snapshot = await getJson('snapshot')
    state.snapshot = snapshot
    state.error = null
    setAppState('ready')
    dom.historyCount.textContent = String(snapshot.historyCount)
    const activeCount = renderIcons()
    renderBubble(activeCount)
    if (!dom.configView.hidden) renderConfig()
  } catch (error) {
    state.error = errorMessage(error)
    setAppState('offline')
    renderBubble(0)
  }
}

function acceptanceBadge(record) {
  if (record.acceptance === undefined) return el('span', 'badge warn', t.notRecorded)
  return el('span', `badge ${record.acceptance.accepted ? 'ok' : 'bad'}`, record.acceptance.accepted ? t.accepted : t.rejected)
}

function field(label, text) {
  const wrap = el('div', 'field')
  wrap.append(el('div', 'field-label', label), el('div', 'field-text', text))
  return wrap
}

function section(title) {
  const wrap = el('div', 'section')
  wrap.append(el('h2', 'section-title', title))
  return wrap
}

function renderSubagentRow(subagent, onClick) {
  const row = el('div', 'subagent-row')
  const avatar = el('div', 'subagent-avatar', subagent.icon)
  avatar.style.setProperty('--ring', subagent.color)
  const info = el('div', 'subagent-info')
  info.append(
    el('div', 'subagent-name', subagent.label || subagent.name),
    el('div', 'subagent-meta', `${subStatusLabel(subagent.status)}${subagent.endedAt === undefined ? '' : ` · ${Math.max(0, Math.round((subagent.endedAt - subagent.startedAt) / 1000))}s`}`),
  )
  row.append(avatar, info)
  const badge = el('span', `badge ${badgeClass(subagent.status === 'running' ? 'running' : subagent.status === 'completed' ? 'completed' : 'failed')}`, subStatusLabel(subagent.status))
  row.append(badge)
  if (onClick) {
    row.style.cursor = 'pointer'
    row.addEventListener('click', onClick)
  }
  return row
}

function renderEntry(entry, roleHint) {
  if (entry.kind === 'status') return el('div', 'entry status', entry.label)
  const wrap = el('div', `entry ${entry.kind}`)
  const head = el('div', 'entry-head')
  const role = entry.kind === 'user' ? (roleHint === 'main' ? 'Codex' : 'User') : entry.kind === 'assistant' ? (roleHint === 'main' ? 'Worker' : 'Subagent') : 'Tool'
  head.append(el('span', 'entry-role', role))
  if (entry.kind === 'tool') head.append(el('span', '', entry.name || entry.callId))
  head.append(el('span', '', relativeTime(entry.at)))
  wrap.append(head)
  if (entry.kind === 'tool') {
    const text = el('div', `entry-text${entry.isError ? ' error' : ''}`, entry.text || '(empty result)')
    wrap.append(text)
    if (entry.text.length > 1_200) {
      text.classList.add('clamp')
      const toggle = el('button', 'entry-toggle', t.showMore)
      toggle.addEventListener('click', () => {
        const open = text.classList.toggle('clamp') === false
        toggle.textContent = open ? t.showLess : t.showMore
      })
      wrap.append(toggle)
    }
    return wrap
  }
  if (entry.text) {
    const text = el('div', 'entry-text', entry.text)
    if (entry.text.length > 1_800) {
      text.classList.add('clamp')
      const toggle = el('button', 'entry-toggle', t.showMore)
      toggle.addEventListener('click', () => {
        const open = text.classList.toggle('clamp') === false
        toggle.textContent = open ? t.showLess : t.showMore
      })
      wrap.append(text, toggle)
    } else wrap.append(text)
  }
  if (entry.kind === 'assistant' && entry.reasoning) {
    const details = document.createElement('details')
    details.append(el('summary', '', t.reasoning))
    details.append(el('pre', '', entry.reasoning))
    wrap.append(details)
  }
  if (entry.kind === 'assistant' && Array.isArray(entry.tools)) {
    for (const tool of entry.tools) {
      const details = document.createElement('details')
      details.append(el('summary', '', `${tool.name} · ${t.arguments}`))
      details.append(el('pre', '', tool.arguments))
      wrap.append(details)
    }
  }
  return wrap
}

function renderTranscript(entries, roleHint) {
  const list = el('div', 'transcript')
  if (entries.length === 0) list.append(el('div', 'empty', t.waitFirst))
  for (const entry of entries) list.append(renderEntry(entry, roleHint))
  return list
}

function subagentStatusClass(subagent) {
  if (subagent.status === 'running') return 'running'
  if (subagent.status === 'completed') return 'completed'
  return 'failed'
}

function renderOverview(record) {
  const fragment = document.createDocumentFragment()
  const delegate = section(t.delegate)
  delegate.append(field(t.task, record.task))
  delegate.append(field(t.criteria, record.acceptanceCriteria))
  delegate.append(field(t.expected, record.expectedReturn))
  fragment.append(delegate)

  const dispatch = section(t.dispatch)
  dispatch.append(field(t.dispatch, `${absoluteTime(record.dispatchedAt)} · ${relativeTime(record.dispatchedAt)}`))
  dispatch.append(field(t.mainSession, record.mainSessionId))
  fragment.append(dispatch)

  const acceptance = section(t.acceptance)
  const badgeRow = el('div', 'field')
  badgeRow.append(acceptanceBadge(record))
  if (record.acceptance !== undefined) badgeRow.append(el('div', 'field-text', record.acceptance.notes))
  else badgeRow.append(el('div', 'field-text', t.noAcceptance))
  acceptance.append(badgeRow)
  fragment.append(acceptance)

  const subagents = section(t.subagents)
  if (record.subagents.length === 0) subagents.append(el('div', 'empty', t.waitFirst))
  for (const subagent of record.subagents) {
    subagents.append(renderSubagentRow(subagent, () => { state.focusSubagent = subagent.sessionId; setTab('run') }))
  }
  fragment.append(subagents)
  return fragment
}

function renderRun(record) {
  const fragment = document.createDocumentFragment()
  const main = section(t.mainRun)
  main.append(renderTranscript(record.transcript, 'main'))
  fragment.append(main)
  for (const subagent of record.subagents) {
    const details = document.createElement('details')
    details.className = 'subagent-block'
    details.open = state.focusSubagent === subagent.sessionId || subagent.status === 'running'
    const summary = el('summary')
    const avatar = el('span', 'subagent-avatar', subagent.icon)
    avatar.style.setProperty('--ring', subagent.color)
    avatar.style.width = '24px'
    avatar.style.height = '24px'
    avatar.style.fontSize = '13px'
    summary.append(avatar, el('span', '', subagent.label || subagent.name))
    summary.append(el('span', 'badge ' + badgeClass(subagentStatusClass(subagent)), subStatusLabel(subagent.status)))
    summary.append(el('span', 'chev', '›'))
    details.append(summary)
    details.append(renderTranscript(subagent.transcript, 'subagent'))
    fragment.append(details)
  }
  return fragment
}

function renderResult(record) {
  const fragment = document.createDocumentFragment()
  const acceptance = section(t.acceptance)
  const row = el('div', 'field')
  row.append(acceptanceBadge(record))
  if (record.acceptance !== undefined) row.append(el('div', 'field-text', record.acceptance.notes))
  else row.append(el('div', 'field-text', t.noAcceptance))
  acceptance.append(row)
  fragment.append(acceptance)
  const result = section(t.finalResult)
  if (record.result === undefined) result.append(el('div', 'empty', t.waitingResult))
  else {
    const pre = el('pre', 'result-text', record.result.text || '(empty)')
    result.append(pre)
    result.append(el('div', 'field-label', `${record.status} · ${record.result.stopReason}`))
    if (record.error !== undefined) result.append(el('div', 'field-text', record.error))
  }
  fragment.append(result)
  return fragment
}

function renderPanel() {
  const record = state.detail
  if (record === null) {
    return
  }
  const focused = record.subagents.find(subagent => subagent.sessionId === state.focusSubagent)
  dom.panelIcon.textContent = focused === undefined ? '🐳' : focused.icon
  dom.panelIcon.style.setProperty('--ring', focused === undefined ? '#6ea8ff' : focused.color)
  dom.panelName.textContent = focused === undefined ? record.codexSession : (focused.label || focused.name)
  dom.panelMeta.textContent = `${record.codexSession} · ${statusLabel(record.status)} · ${relativeTime(record.dispatchedAt)}`
  const scrollTop = dom.panelBody.scrollTop
  dom.panelBody.replaceChildren()
  if (state.tab === 'overview') dom.panelBody.append(renderOverview(record))
  else if (state.tab === 'run') dom.panelBody.append(renderRun(record))
  else dom.panelBody.append(renderResult(record))
  dom.panelBody.scrollTop = scrollTop
  for (const button of dom.panel.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.getAttribute('data-tab') === state.tab)
  }
}

function setTab(tab) {
  state.tab = tab
  renderPanel()
}

async function loadDetail() {
  if (state.detailId === null) return
  try {
    const detail = await getJson(`delegates/${encodeURIComponent(state.detailId)}`)
    state.detail = detail
    renderPanel()
  } catch (error) {
    if (errorMessage(error) === 'unauthorized') setBubble(t.bubbleUnauthorized)
  }
}

function startDetailPoll() {
  clearInterval(state.detailTimer)
  state.detailTimer = setInterval(() => { void loadDetail() }, 1_200)
}

async function openDelegate(delegateId, subagentId) {
  state.detailId = delegateId
  state.focusSubagent = subagentId || null
  state.detail = null
  state.tab = 'overview'
  showOnly('panel')
  dom.panelBody.replaceChildren(el('div', 'empty', 'Loading…'))
  await loadDetail()
  startDetailPoll()
}

function closePanel() {
  state.detailId = null
  state.detail = null
  state.focusSubagent = null
  clearInterval(state.detailTimer)
  showOnly('none')
}

function acceptanceBadgeFor(entry) {
  if (entry.accepted === undefined) return el('span', 'badge warn', t.notRecorded)
  return el('span', `badge ${entry.accepted ? 'ok' : 'bad'}`, entry.accepted ? t.accepted : t.rejected)
}

function renderHistory() {
  dom.historyBody.replaceChildren()
  if (state.history === null) {
    dom.historyBody.append(el('div', 'empty', 'Loading…'))
    return
  }
  const filter = state.filter.trim().toLowerCase()
  let shown = 0
  for (const group of state.history.groups) {
    const entries = group.entries.filter(entry => filter === ''
      || group.codexSession.toLowerCase().includes(filter)
      || entry.taskPreview.toLowerCase().includes(filter))
    if (entries.length === 0) continue
    shown += entries.length
    const block = el('div', 'group')
    const head = el('div', 'group-head')
    head.append(el('span', '', group.codexSession), el('span', 'group-count', `${group.count}`))
    block.append(head)
    for (const entry of entries) {
      const row = el('button', 'history-row')
      row.type = 'button'
      const top = el('div', 'history-row-top')
      top.append(el('span', 'history-task', entry.taskPreview || '(empty task)'))
      top.append(el('span', 'history-time', relativeTime(entry.dispatchedAt)))
      const sub = el('div', 'history-sub')
      sub.append(el('span', `badge ${badgeClass(entry.status)}`, statusLabel(entry.status)))
      sub.append(acceptanceBadgeFor(entry))
      sub.append(el('span', '', `${entry.subagentCount} subagent${entry.subagentCount === 1 ? '' : 's'}`))
      row.append(top, sub)
      row.addEventListener('click', () => { void openDelegate(entry.id) })
      block.append(row)
    }
    dom.historyBody.append(block)
  }
  if (shown === 0) dom.historyBody.append(el('div', 'empty', state.history.count === 0 ? t.noHistory : t.emptyGroup))
}

async function openHistory() {
  showOnly('history')
  dom.historyBody.replaceChildren(el('div', 'empty', 'Loading…'))
  try {
    state.history = await getJson('history')
    dom.historyMeta.textContent = t.historyMeta(state.history.count, state.history.limit)
    dom.historyCount.textContent = String(state.history.count)
    renderHistory()
  } catch (error) {
    dom.historyBody.replaceChildren(el('div', 'empty', errorMessage(error)))
  }
}

function codexSnippet() {
  const mcpUrl = state.snapshot === null ? '' : state.snapshot.mcpUrl
  return [
    '[mcp_servers.dsh_pet]',
    `url = ${JSON.stringify(mcpUrl)}`,
    'startup_timeout_sec = 120',
    'tool_timeout_sec = 3600',
    'enabled_tools = ["subagent_delegate"]',
  ].join('\n')
}

function renderConfig() {
  dom.configSnippet.textContent = codexSnippet()
}

function openConfig() {
  showOnly('config')
  renderConfig()
}

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(codexSnippet())
    toast(t.copied)
  } catch {
    toast(t.copyFailed)
  }
}

dom.historyButton.addEventListener('click', () => { void openHistory() })
dom.configButton.addEventListener('click', openConfig)
dom.panelClose.addEventListener('click', closePanel)
dom.historyClose.addEventListener('click', () => { state.history = null; showOnly('none') })
dom.configClose.addEventListener('click', () => { showOnly('none') })
dom.copyConfig.addEventListener('click', () => { void copyConfig() })
dom.historyFilter.addEventListener('input', () => {
  state.filter = dom.historyFilter.value
  renderHistory()
})
for (const button of dom.panel.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    const tab = button.getAttribute('data-tab')
    if (tab === 'overview' || tab === 'run' || tab === 'result') setTab(tab)
  })
}
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panelOpen()) closePanel()
})
window.addEventListener('beforeunload', () => {
  clearInterval(state.pollTimer)
  clearInterval(state.detailTimer)
})

function boot() {
  if (!TOKEN) {
    state.error = 'unauthorized'
    setAppState('offline')
    setBubble(t.bubbleUnauthorized)
    return
  }
  resizePanel(false)
  void loadSnapshot()
  state.pollTimer = setInterval(() => { void loadSnapshot() }, 1_000)
}

boot()
