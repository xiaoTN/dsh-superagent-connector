/** Independent instance identity, not the Feishu channel account/app name. */
import { HttpError, redact } from './security.js'
export const DEFAULT_AGENT_NAME = 'SuperAgent'
const KEY = 'desktop-inbox:agent-identity:v1'

function agentName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Agent name must be text')
  const name = value.trim()
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff\ud800-\udfff]/u.test(name) || redact(name) !== name) {
    throw new HttpError(400, 'Choose a visible Agent name of 1–80 characters without credentials')
  }
  return name
}

export function validateAgentIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['name', 'revision'].includes(key))
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new HttpError(400, 'Only name and a non-negative identity revision are accepted')
  }
  return { name: agentName(value.name), revision: value.revision }
}

export function projectAgentIdentity(value) {
  if (!value?.agent || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new HttpError(502, 'Unsupported Agent identity format')
  return { agent: { name: agentName(value.agent.name) }, revision: value.revision }
}

export function readAgentIdentity(context) {
  const stored = context?.state.get(KEY)
  if (stored === undefined) return { agent: { name: DEFAULT_AGENT_NAME }, revision: 0 }
  return projectAgentIdentity(stored)
}

export function writeAgentIdentity(context, value, secret) {
  const input = validateAgentIdentity(value)
  if (secret && input.name.includes(secret)) throw new HttpError(400, 'Credentials cannot be an Agent name')
  return context.atomic(() => {
    const current = readAgentIdentity(context)
    if (current.revision !== input.revision) throw new HttpError(409, 'Agent name changed; reload its current revision before saving')
    if (current.revision > 0 && current.agent.name === input.name) return current
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new HttpError(409, 'Agent identity revision limit reached')
    const next = { agent: { name: input.name }, revision: current.revision + 1 }
    context.state.set(KEY, next)
    return next
  })
}
