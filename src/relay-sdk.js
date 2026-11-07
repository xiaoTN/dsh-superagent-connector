import { SourceRelayError } from './relay-errors.js';

/**
 * Use the SAME public loader tree that imported the connector. DSH's installed-host
 * Include resolves bare SDK names from its host anchor, not a plugin's node_modules.
 * Never guess an installation path or bundle/install a second Cordis/Session copy.
 */
export async function loadRelaySdk(ctx, supplied) {
  let sdk = supplied;
  if (!sdk) {
    const tree = ctx.fiber?.entry?.parent?.tree;
    if (typeof tree?.import !== 'function') {
      throw new SourceRelayError('host-sdk-unavailable', 'Relay needs the host loader or explicitly injected canonical SDK helpers');
    }
    const [scope, agent, session] = await Promise.all([
      tree.import('@deepseek-ai/dsh-scope'),
      tree.import('@deepseek-ai/dsh-agent'),
      tree.import('@deepseek-ai/dsh-session'),
    ]);
    sdk = { ...scope, ...agent, ...session };
  }
  if (typeof sdk.createScope !== 'function' || typeof sdk.agentEvents !== 'function'
    || typeof sdk.SessionStore !== 'function' || typeof sdk.AgentRegistry !== 'function'
    || !(ctx.sessions instanceof sdk.SessionStore) || !(ctx.agents instanceof sdk.AgentRegistry)) {
    throw new SourceRelayError('host-sdk-identity-mismatch', 'Relay SDK does not own this Context SessionStore/AgentRegistry; refusing a second runtime');
  }
  return sdk;
}
