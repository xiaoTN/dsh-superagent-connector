/** Superagent -> the ALREADY INSTALLED task board, through its documented provider face. */
import { boardSnapshot } from './upstream.js'

export const EXTENSION_ID = 'superagent'
import { GUARD_CAPABILITY } from './native-guard.js'

// Secondary upgrade fail-safe only; the required central ledger guard is the actual native run admission.
export const EXTERNAL_PRESET = 'superagent-external-managed-do-not-run'

export function nativeStatus(ticket) {
  if (ticket.stage === 'ended') return ['merged', 'completed'].includes(ticket.outcome) ? 'done' : 'backlog'
  if (ticket.stage === 'working') return ticket.action === 'queued' ? 'todo' : 'running'
  if (ticket.stage === 'person' && ['blocked', 'failed'].includes(ticket.action)) return 'failed'
  return 'backlog'
}

export function statusText(ticket) {
  if (ticket.stage === 'ended') return { merged: '已合并', completed: '已完成', stopped: '已停止', dropped: '已放弃', closed: '已关闭' }[ticket.outcome] ?? '已结束（结果未知）'
  if (ticket.stage === 'working') return ticket.action === 'queued' ? '排队中' : '执行中'
  if (ticket.stage === 'idle') return '等待新消息 / 触发'
  if (ticket.stage === 'person') return { review: '等待审阅', answer: '等待答复', delivery: '等待交付', blocked: '受阻', failed: '失败待处理' }[ticket.action] ?? '等待处理'
  return '未知状态'
}

export function projection(ticket, sourceInstanceId) {
  return { schemaVersion: 1, ticketId: ticket.id, managed: true, executionOwner: 'superagent', sourceInstanceId, stage: ticket.stage, action: ticket.action, outcome: ticket.outcome,
    statusText: statusText(ticket), summary: ticket.summary.slice(0, 8000), links: ticket.threads.slice(0, 10),
    upstreamUpdatedAt: ticket.updatedAt }
}

export function mirrorTickets(host, items, sourceInstanceId = 'http://127.0.0.1:3082') {
  const linked = new Map(host.tasks.linked().filter(row => row.payload?.managed === true && row.payload.sourceInstanceId === sourceInstanceId)
    .map(row => [row.payload.ticketId, row]))
  let created = 0, changed = 0
  for (const ticket of items) {
    const payload = projection(ticket, sourceInstanceId)
    const title = '[Superagent] ' + ticket.title.slice(0, 180)
    const description = '由现有 Superagent 执行。此卡是外部状态镜像，不要在本看板重新运行或修改执行预设。\n\n'
      + '状态：' + payload.statusText + '\n\n' + (ticket.summary || '暂无执行摘要')
    const row = linked.get(ticket.id)
    if (!row) {
      host.tasks.create({ title, description,
        prompt: '此卡是 Superagent 外部工单镜像，不应由当前 DSH 任务执行器运行。请从 Superagent 对话入口跟进。',
        status: nativeStatus(ticket), mode: EXTERNAL_PRESET }, { payload })
      created++
      continue
    }
    if (JSON.stringify(row.payload) !== JSON.stringify(payload)) {
      // Board content is frozen once somebody attempted a native execution: never circumvent that gate.
      if (row.task.executions.length === 0 && row.task.archivedAt === undefined) host.tasks.patchContent(row.task.id, { title, description })
      host.integration.write(row.task.id, payload)
      changed++
    }
    if (row.task.status !== nativeStatus(ticket) && row.task.archivedAt === undefined
      && !row.task.executions.some(run => run.endedAt === undefined)) {
      host.tasks.setStatus(row.task.id, nativeStatus(ticket), 'Superagent external status sync')
    }
  }
  return { created, changed, imported: items.length }
}

export function makeTaskboardExtension(base, boardFace, snapshot = () => boardSnapshot(base)) {
  if (boardFace.externalExecutionGuard !== GUARD_CAPABILITY) throw new Error('Install and reload the version-pinned external execution guard before enabling Superagent sync')
  let timer, active = false, busy = false, host
  const sync = async () => {
    if (!active || busy) return
    busy = true
    try {
      const board = await snapshot()
      if (!active) return
      const result = mirrorTickets(host, board.items, base.origin)
      host.publish({ state: 'ready', lastSyncedAt: new Date().toISOString(), ...result,
        truncated: board.truncated === true, readOnlyMirror: true })
    } catch {
      if (active) host.publish({ state: 'unavailable', error: 'Superagent 同步不可用；保留上次数据，不视为空任务', readOnlyMirror: true })
    } finally { busy = false }
  }
  return { id: EXTENSION_ID, apiVersion: 1,
    start(face) { host = face; active = true; void sync(); timer = setInterval(() => void sync(), 15000); timer.unref?.() },
    stop() { active = false; clearInterval(timer) },
    async handleAction(request) {
      if (request.action !== 'refresh') throw new Error('Unsupported Superagent provider action')
      await sync()
      return { refreshed: true }
    },
  }
}
