# Contributing

## Design boundaries

- Keep one task board: use the installed native board's public provider/card/detail faces. Do not add a second kanban or private task ledger.
- Superagent remains execution authority. Polling, card projection, refresh and opening details must never launch a worker or local DSH session.
- Retain actual DSH connection authentication. No cookie-name/Origin-only fallback, public upstream endpoints, redirects, generic management proxy, or browser bridge credentials.
- Keep Source intake transactionally idempotent. An accepted Trigger id is not a ticket id. Do not claim one message always creates exactly one ticket.
- Changes to external ownership/run admission need native-path tests, including parent dispatch and scheduled refusal that does not disrupt unrelated schedules.

## Local checks

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
```

The optional GUI test requires a private launch URL file and an existing local deployment. It never submits work unless `SUPERAGENT_TEST_SEND=1` is explicitly enabled. Use a read-only fixture, never real secrets/private tasks, and inspect every screenshot before publishing it.

## Releases

1. Change the package version; keep both desktop and WSL Source on the same release.
2. Run unit tests and verify the exact native-board compatibility hash. No fuzzy patching or silent version exemptions.
3. Use an existing authenticated GUI to test chat, native cards/detail, stale behavior and refusal before native execution creation.
4. Publish a version tag, release notes and the packed archive. Preserve previous releases for rollback.
5. Upgrade native-board compatibility only after auditing its real run/scheduler paths. The patch is a transparent interim compatibility layer, not an upstream contract.

Never commit `.private`, tokens, cookies, authenticated URLs, environment/config exports, inbox dumps or private task screenshots. Use GitHub Issues for redacted bugs and feature requests; use private reporting for sensitive vulnerabilities.
