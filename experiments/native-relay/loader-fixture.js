// Isolated public-loader fixture, never installed into an existing DSH service.
import { createSourceRelay } from '../../src/relay-agent.js';
export const name = 'source-relay-loader-proof';
export const inject = ['sessions', 'agents'];
export async function apply(ctx, options) {
  const { publish, ...relayOptions } = options;
  const relay = await createSourceRelay(ctx, relayOptions);
  publish(relay);
}
