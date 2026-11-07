/** Stable relay-domain failures; never include transport credentials or private paths. */
export class SourceRelayError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceRelayError'; this.code = code; }
}
