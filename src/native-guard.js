/** Small, version-pinned compatibility patch for the existing board, not a replacement board. */
import { createHash } from 'node:crypto'
export const NATIVE_BOARD_VERSION = '0.4.15'
export const NATIVE_BOARD_HASH = '477a4740655d5aa8200f7d004d079351269498273243916c8f75d60e2c724fda'
export const PREVIOUS_PATCHED_HASH = '0f26cb11258e3ae50b430ceb1b0ffe1a4a5e97fe9271c7b72ea54d99728d6653'
export const NATIVE_PATCHED_HASH = '516d6e1e3a1c7cbfc19acd1882bb32642769e28651ceac1944ea2c15eafc7c05'
export const GUARD_CAPABILITY = 'superagent/v2'

/** Runs before the native ledger opens ANY run (manual, rerun, rework, cron, parent dispatch). */
export function assertExternalRunAllowed(tasks, rootId) {
  const stack = [rootId], seen = new Set()
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const task = tasks.find(item => item.id === id)
    if (!task) continue
    const external = task.integrations?.superagent
    if (external?.managed === true && external.executionOwner === 'superagent') {
      throw new Error('Superagent 外部工单由现有 WSL Superagent 执行；请从 Superagent 对话继续，禁止在此重复运行。')
    }
    for (const child of tasks) if (child.parentId === id) stack.push(child.id)
  }
}

/** Scheduled rejection must not throw out of the native board's global timer loop. */
export function allowExternalScheduledRun(ledger, taskId) {
  try { assertExternalRunAllowed(ledger.document.tasks, taskId); return true }
  catch (error) {
    ledger.document.scheduler.error = String(error.message)
    // Disable the unsafe rule instead of leaving an already-due target to spin or starving other schedules.
    ledger.document.tasks = ledger.document.tasks.map(task => task.id === taskId && task.schedule
      ? { ...task, schedule: { ...task.schedule, enabled: false, nextRunAt: undefined } } : task)
    ledger.commit()
    return false
  }
}

const digest = source => createHash('sha256').update(source).digest('hex')
const method = '\tstartRun(root, now, initiator, rerun = false, progress, rework) {'
const scheduleMethod = '\topenScheduled(taskId, triggeredAt) {'
const face = '\t\tregisterExtension: (extension) => host.registerExtension(extension),'

export function originalNativeBoard(source) {
  const hash = digest(source)
  if (hash === NATIVE_BOARD_HASH) return source
  let prefix, version
  if (hash === PREVIOUS_PATCHED_HASH) {
    prefix = '// SUPERAGENT_EXTERNAL_EXECUTION_GUARD_V1\n' + assertExternalRunAllowed.toString() + '\n'
    version = 'superagent/v1'
  } else if (hash === NATIVE_PATCHED_HASH) {
    prefix = '// SUPERAGENT_EXTERNAL_EXECUTION_GUARD_V2\n' + assertExternalRunAllowed.toString() + '\n' + allowExternalScheduledRun.toString() + '\n'
    version = GUARD_CAPABILITY
  } else throw new Error('Unsupported or modified task-board binary; refusing to patch or trust a marker')
  if (!source.startsWith(prefix)) throw new Error('Unexpected native guard prefix')
  const original = source.slice(prefix.length)
    .replace('\n\t\tassertExternalRunAllowed(this.document.tasks, root.id);', '')
    .replace('\n\t\tif (!allowExternalScheduledRun(this, taskId)) return [];', '')
    .replace('\t\texternalExecutionGuard: "' + version + '",\n', '')
  if (digest(original) !== NATIVE_BOARD_HASH) throw new Error('Could not recover the exact baseline; refusing to patch')
  return original
}

export function patchNativeBoard(source) {
  if (digest(source) === NATIVE_PATCHED_HASH) return source
  const original = originalNativeBoard(source)
  if ([method, scheduleMethod, face].some(anchor => original.split(anchor).length !== 2)) throw new Error('Task-board guard anchors are not unique')
  return '// SUPERAGENT_EXTERNAL_EXECUTION_GUARD_V2\n' + assertExternalRunAllowed.toString() + '\n' + allowExternalScheduledRun.toString() + '\n' + original
    .replace(method, method + '\n\t\tassertExternalRunAllowed(this.document.tasks, root.id);')
    .replace(scheduleMethod, scheduleMethod + '\n\t\tif (!allowExternalScheduledRun(this, taskId)) return [];')
    .replace(face, '\t\texternalExecutionGuard: "' + GUARD_CAPABILITY + '",\n' + face)
}
