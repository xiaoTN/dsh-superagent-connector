# Verification record — 2026-11-07

Target: DSH desktop 0.2.2-rc.1 on Windows, the already installed native task board 0.4.15, and a WSL Superagent prototype deployment. Connector release: 0.2.2.

## Automated local tests

23 Node tests passed, covering host authentication, physical loopback, bounded upstream/body time and bytes, server-side credential masking, large Chinese inbox histories, real Trigger-contract transactional/idempotent intake, Source allowlists, ticket projection, stable native-card identity, persistent external ownership, parent-tree guard, scheduler rejection isolation, archived mirrors, and rendering of persisted chat messages/native details.

Regression note: removing the standalone kanban accidentally removed a shared date formatter. A minimal VM/React fixture failed on a persisted assistant message and a native detail section, then passed after restoring that helper. The real browser test was re-run afterwards.

## Real existing GUI (not a replacement server)

The optional Playwright test was run against the existing authenticated desktop URL:

- Dedicated Superagent chat loaded the actual inbox. No separate kanban was rendered.
- A forged-cookie request was refused with HTTP 401.
- “打开任务看板” selected the **original** native task-board panel.
- Its existing ledger/UI contained five Superagent cards, linked by real upstream ticket id, with provider badges and a detail section.
- An authenticated native rerun request was refused **before** opening an execution. The card still had zero native execution records, and the board had zero running native sessions.
- Native detail showed the real ticket provenance.
- Explicit GUI send reached the real Source. Replaying its requestId returned `duplicate: true`.
- The existing Superagent and worker returned a real reply to that chat. A read-only worker also reported the configured repository README title and line count without a code commit or PR.
- Final 0.2.2 verification explicitly returned “原任务看板已接通”. No uncaught page errors occurred.

Screenshots in this directory depict the real 0.2.x integration, not a generated mockup. The board image is filtered to the test ticket; private tasks, settings and authenticated URLs are not published.

## Native board compatibility patch

- Pristine 0.4.15 host SHA256: `477a4740655d5aa8200f7d004d079351269498273243916c8f75d60e2c724fda`.
- Final guard-v2 host SHA256: `516d6e1e3a1c7cbfc19acd1882bb32642769e28651ceac1944ea2c15eafc7c05`.
- The installer verifies exact baseline/patched identity and preserves the original backup.
- Static source review confirmed manual run/rerun/rework and once/recurring native schedules converge on the guarded `startRun` before execution creation. Descendant ownership is checked before a parent's dispatcher/preset selection.
- An independent review found that merely throwing for a due native schedule would interrupt the original global scheduler loop. Guard v2 converts scheduled refusal into an error plus disabling **only that unsafe rule**, without consuming its run budget. A local fixture verifies that the next ordinary rule remains admissible.
- No actual recurring/one-shot tasks were created for this verification. Scheduler coverage is static path review and local fixtures, not a claim of a live cron experiment.

## Boundaries

These checks are not a hostile-OS penetration test, a multi-tenant security certification, a guarantee of arbitrary credential detection, or exhaustive compatibility with future DSH/Superagent/native-board versions. The original worker/root/management-port permissions remain unchanged. Upgrading the native board requires reviewing the compatibility patch again.
