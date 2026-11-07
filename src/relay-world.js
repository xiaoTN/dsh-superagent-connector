import { SourceRelayError } from './relay-errors.js';

/** RC.1 Agent scoped-world foundation, matching the SDK's ordinary factory world.
 * These are EXISTING host services, not drivers/models constructed by the relay.
 */
export const RELAY_WORLD_FOUNDATION = Object.freeze(['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']);

/**
 * Use the running factory's PUBLIC dependency declaration when present. This keeps
 * the custom Agent world aligned with the same SDK, without invoking that factory.
 * Minimal SDK embedders may omit tools/prompt/LLM entirely; only already-present
 * foundation services participate. Ancestor dependency/isolation scopes are retained.
 */
export function relayWorldDependencies(ctx) {
  const declared = ctx.get?.('agentLoop')?.constructor?.inject;
  const foundation = Array.isArray(declared) ? declared : RELAY_WORLD_FOUNDATION;
  const available = [...new Set([...RELAY_WORLD_FOUNDATION, ...foundation, 'attachments'])]
    .filter(name => typeof name === 'string' && ctx.get?.(name) !== undefined);
  if (!available.includes('agents') || !available.includes('sessions')) {
    throw new SourceRelayError('relay-world-unavailable', 'Source Agent world needs the existing host AgentRegistry and SessionStore');
  }
  return available;
}

/**
 * A real Cordis dependency fiber, not a root-context/inject bypass or fake service.
 * Every Source scope/session/registry effect lives INSIDE this fiber. Provider
 * replacement therefore drains the entire old Agent world before reconstruction;
 * the Source caller owns the exact disposer through its surrounding effect chain.
 */
export function createRelayWorld(ctx, apply) {
  return ctx.plugin({ name: 'superagent-relay-world', inject: relayWorldDependencies(ctx), apply });
}
