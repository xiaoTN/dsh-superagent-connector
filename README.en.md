# Superagent Connector

English · [简体中文](README.md)

**Chat with your existing Superagent inside DSH, and see its tickets in the task board you already installed. No second kanban.**

- **Superagent sidebar:** dedicated project chat, backed by the real prototype Source/authorization/routing/worker/reply pipeline.
- **Existing Task Board sidebar:** native cards, columns, search and detail sections from `@linxin666/dsh-client-ui-task-board`; the connector only supplies an external provider.
- Stable `(instance, actual ticket.id)` mappings update the same native cards without opening a local execution. Feishu and GitHub requests remain visible alongside desktop requests.
- No fake Feishu messages, iframe panel or replacement DSH server. No separate task ledger.

Unofficial early software, intended for one local DSH owner and one Superagent project. Requests can execute commands, push or merge code under the existing worker permissions. Read [SECURITY.md](SECURITY.md).

## Requirements

DSH 0.2.2-rc.1; Node 22.19+ / 24+; the **already installed native task board 0.4.15**; a working [Superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). Initial tested setup: Windows desktop + WSL Superagent on IPv4 loopback port 3082.

## Why a compatibility patch?

The native board's provider interface supports synchronization, but version 0.4.15 has no external execution ownership/run-veto contract. An unknown preset or hidden button is not a reliable guard.

This repository includes an explicit **version-and-hash-pinned host compatibility patch**. It rejects externally managed Superagent cards in the native ledger's central `startRun`, before opening an execution, including manual runs, reruns, rework, cron and parent dispatch containing an externally managed descendant. Changing a preset or disabling the connector does not remove the persisted ownership check. Native Run buttons still exist and return a clear refusal; continue the task in Superagent chat instead.

The patch only accepts the exact published 0.4.15 host file and backs it up under `$DSH_HOME/superagent-connector-backup`. It changes the installed task-board plugin, **not DSH core or its desktop shell**. It is not an upstream-approved contract. Revalidate it before upgrading the board. The connector refuses to start synchronization when the running board does not publish the guard capability. The pinned unknown preset remains only a secondary upgrade fail-safe, not a security boundary.

## Install

Not published to npm yet; use this source or a release archive.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
node scripts/install-native-guard.mjs
```

Run the guard installer only while the board has no active execution. It uses `DSH_PROFILE_DIR` or `~/.dsh/profiles/desktop`. Reload the native task-board Host plugin afterwards.

Install the connector archive in the Windows desktop profile, and the same archive in the WSL Superagent profile. In the latter, override:

```yaml
- id: superagent-connector
  disabled: true
- id: superagent-desktop-source
  disabled: false
```

Provision a private 32-byte random bridge token (64 hex characters) in both locations:

- Desktop user's `.dsh/superagent-board-token`
- Superagent user's `.config/dsh-superagent-board/token`

These filenames preserve the internal preview's upgrade path. Restrict file permissions. Never put the token in Git, chat, CLI arguments, logs or screenshots. Enroll only `desktop-owner` on the `desktop-inbox` Source allowlist; do not widen external-source permissions. Reload the Source and refresh DSH.

Desktop options:

```yaml
- id: superagent-connector
  config:
    url: http://127.0.0.1:3082
    tokenFile: /private/path/to/token
```

Only literal loopback HTTP origins are accepted. No arbitrary management proxy or automatic WSL lifecycle actions.

## Independent Agent name

Version 0.3 reads an independent instance identity instead of hardcoding `Superagent` or borrowing the Feishu bot application name. The initial name is **SuperAgent**. Open **名称设置** (name settings) on the chat page, enter a name and explicitly save it.

The authority is a persistent record in the WSL Superagent store, not browser storage. Sidebar, title, assistant bylines and hints follow it automatically (visible clients poll every 15 seconds; a confirmed save updates the current client immediately). Native-board provenance labels and unfrozen card titles follow the next status sync; titles frozen by existing execution history retain their audit record. Stable Source ids and execution ownership do not change.

Saving a name does not submit a chat message, Trigger, ticket or worker run, and does not rename the Feishu bot. Revision checks prevent overwriting a concurrent edit; failed/conflicted saves retain the input for an explicit reload and retry. Names are plain text, 1–80 Unicode code points. Offline clients retain the last known name; only a client without a valid identity uses the default. Historical message bodies are not rewritten.

## Use

**Superagent** opens chat; **Open Task Board** selects the existing board. Send / Ctrl+Enter submits; Enter inserts a newline. `accepted` is a received Trigger identifier, not a completed task or ticket id. Superagent can answer directly, continue an existing ticket, or create one. An uncertain POST is retried only explicitly with the same requestId; persisted intake deduplicates it.

Native card columns are coarse projections: working → running, queued → todo, waiting for an answer/review/trigger → backlog, blocked/failed → failed, confirmed completed/merged → done. Stopped/closed/dropped/unknown endings are not reported as success. Original phase and outcome appear in the provider detail section. These are external status declarations, not fabricated local execution/acceptance records.

Archived mirrors remain archived. Deleting a local mirror does not stop the upstream ticket and it may be imported again. Sync failure retains old data; dynamic pagination is not an atomic snapshot. The inbox serves recent messages within a byte budget (at most 200) and keeps at most 2000 local-channel entries in the prototype store.

This version synchronizes **Superagent → native board**. Ordinary new cards retain the board's own execution behavior; they are not silently rerouted. Use dedicated Superagent chat to request work.

## Development

```bash
pnpm check
pnpm pack
```

`src/client.js` provides only chat and native card/detail seats; `src/taskboard.js` uses the public provider face; `src/native-guard.js` contains the reviewed compatibility patch; `src/source.js` provides the real Source; the other host modules implement authentication, fixed loopback, bounded requests and field projection. No direct writes to the native board's private ledger.

Unit tests run on Windows/Linux, Node 22/24 via GitHub Actions. Optional `test/gui.smoke.mjs` exercises an authenticated real GUI; it must receive a private test launch URL through an ignored local file, never a public fixture. It sends work only when explicitly enabled. Keep both profiles on the same connector release.

Prototype SourceKind and some management routes are unstable; upgrades need testing. No attachments, multiple deployments, independent conversation list or multi-tenant isolation yet. Upstream root privileges and GitHub credential risks remain unchanged.

MIT; see [LICENSE](LICENSE).
