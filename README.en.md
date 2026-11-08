# Superagent Connector

English · [简体中文](<README.md>)

**Operate the real WSL SuperAgent through DSH's native conversation UI, and see its tickets in the task board you already installed. Not a renamed ordinary assistant or a second kanban.**

> This documentation targets the planned **0.4.3** public release; the actual Release tag/archive remains authoritative. 0.4.0/0.4.1 were local staging only, without a public tag. Unofficial early software for one machine, one DSH owner and one SuperAgent repository. Existing worker command/root/GitHub/push/merge permissions are not reduced. Read the [security model](<SECURITY.md>) first.

## What is implemented

- The **SuperAgent entry** uses a genuine Controller `SessionReference`, native Session Provider and `conversation.content` Factory. It reuses native Lexical input, queue, message and attachment presentation instead of cloning a textarea.
- The local registered driver is a **Source-backed structural Agent**, not an ordinary AgentLoop, model provider or fabricated Session. WSL SuperAgent remains the authority for authorization, routing, tickets and workers.
- Actual human input stays `user/message`; Source deliveries are explicit `customSource` events, not invented model tokens, tools or execution records. Actual Source port kinds are `acknowledgement` / `reply` / `notice`. Legacy entries without a kind remain `delivery`; content is not used to guess a kind.
- The **existing task board**, `@linxin666/dsh-client-ui-task-board`, retains its cards, columns, search and detail UI. Stable instance + actual `ticket.id` mappings update those cards. Polling, refreshing and reading records never create a local execution.
- Feishu/GitHub entry points remain intact. No fake Feishu messages, second ledger, or mixed-source Main/coordinator transcript is exposed as this chat.

```text
Windows DSH: native SessionReference → Provider → Conversation Factory
               ↓ true human input / separate durable outbox
               ↓ authenticated fixed-loopback transport; actual attachment bytes
WSL Source: authorization → prepare → Source.atomic (Trigger + journal) → commit
               ↓ actual SuperAgent routing / ticket / worker → Source delivery
Windows DSH: restore Source events and attachments → native presentation
Existing task board: status projection only; central execution guard remains independent
```

### Input, history and uncertain outcomes

**Enter queues the message; Shift+Enter inserts a newline.** The native Send button also works. `accepted` means received, not completed or necessarily a new ticket: SuperAgent may reply directly, continue an existing ticket, or create one.

The local driver synchronously saves a separate durable outbox before native admission succeeds. It records `unknown` before any upload/submit side effect. Lost acknowledgements, disconnects and restart lead to Source reconciliation, **never automatic retransmission of uncertain work**. Preserve the request identity and ordered attachments; a requestId cannot be reused for different content. The outbox currently accepts at most **256 requests / 10 MiB**. It refuses excess admission rather than silently discarding messages. Do not delete the outbox to “fix” an unknown outcome.

The Source conversation journal is the authority for confirmed history and is no longer truncated at 2000 entries. Reads are ordered, byte-bounded pages of at most **200 entries**. The old 2000-entry mirror remains only for rollback, not as the native-history limit. Reopening restores from Source, not invented confirmed replies from the local outbox. An unavailable/unloaded facade refuses input instead of falling back to an ordinary assistant. The current default UI still opens the project's `main` conversation; this is not a multi-instance or multi-tenant conversation manager.

### Replies and topics

`acknowledgement`, `reply` and ticket-level results all render a Feishu-topic-style quote: accent bar, original text and time. A direct answer resolves its target from the reply event's deterministic id against the confirmed Source history; a ticket-level result (such as the final completion notice) has no such id, so it quotes the human message already bound to the same ticket (the ticket's opening message when available) in the same visual style. A late answer after several messages is never attributed by position; an old or unresolvable id deliberately renders no quote instead of guessing. Resolution reads confirmed history only: no extra request, no Source rewrite.

### Real images and files

The path is native FileUploads → durable native-host refs → read actual bytes → **new WSL Source receipts** → prepare → atomic Source intake → commit → genuine read-only worker files.

- Browser/Windows receipts admit content only in their original local Session; they are not portable Source credentials. Native storage may normalize a PNG into WebP. Transfer the actual stored bytes with their actual MIME, never a relabeled payload.
- Source ownership binds owner, conversation, request and message. Limits: **20 MiB/file**, **10 files / 100 MiB/request**, and default store quotas of 500 MiB / 1000 files. Real PNG/JPEG/WebP/GIF headers are checked; unsupported formats, MIME spoofing and excess size are genuine errors. Generic files are not silently made into readable images.
- Exact-message prepared bindings allow the server to build worker file context before Source atomic intake; `commit` still follows the transaction. Prepared files stay pinned across a crash after Source acceptance but before file commit. Draft TTL cleanup never deletes committed message files.
- Source `threadContext.image` verifies the originating Source message's ownership and the **actual active model's** image modality, then really calls attachment storage `saveImage`. Unsupported models refuse rather than claiming to have inspected an image. Workers may also use `read_image` on the genuine server path.
- History recovery reads committed Source files, verifies receipt/length/SHA-256 and really imports bytes into native attachment storage to obtain native refs. It does not manufacture a preview ref without bytes.

### Stop, Resume and execution history

Stop is **nonterminal interruption**: the ticket, Assignment, worker Session, directory and branch remain. It is not ticket closure or a fresh retry. Every control carries current `expectedAssignmentId` and `expectedControlSeq`; a stale generation conflicts instead of stopping a continued run. Select a ticket explicitly when more than one execution is eligible; a local Stop is not global cancellation.

`paused` proves only that a durable hold committed. Only `interruption: settled` proves actual cancellation finished. Resume is refused while cancellation is requested or failed. Aborting an HTTP wait is not evidence that a worker stopped. Unloading, refreshing or closing the view stops local observation, not WSL work.

Execution records are Source-authorized **cold, bounded projections** of actual ticket/worker journals. Reads do not activate a cold Agent or mix in Main history. Each call reads one page, at most 100 visible records / 128 KiB, retaining original seq/time and cursor. A filtered empty page is not empty history. Projections never become fabricated native model/tool events.

### Explicitly unsupported native controls

Local model/reasoning selection, permissions, steer, approval, Plan, Goal, local commands, injected context, title-LLM refresh and fork have no supported Source mapping and remain unavailable. Native global model/permission settings do not configure WSL workers. Input is queue-only.

RC.1 has no official native per-session capability interface. The connector uses a **Source-scoped DOM/ARIA compatibility shim** to hide/refuse unsupported entry points and validate actions, alongside Host refusals. This is not a native SDK capability or a permission sandbox. Revalidate it after DSH upgrades; hidden buttons alone are not a security boundary. Ordinary DSH conversations are outside this Source UI adaptation.

## Screenshots and verification status

The [v0.2 simplified-chat screenshot](<docs/images/chat.png>) is historical material, **not** a 0.4.3 native Conversation screenshot or acceptance result.

![Historical screenshot: the existing task board, not a replacement board](<docs/images/native-board.png>)

The actual RC.1 SDK suite passes **24/24**. Separate checks in the existing Windows GUI passed: native input → genuine Source reply; text/image bytes read by WSL with unique content, color and dimensions returned; selected-ticket interruption during preparation, actual settled confirmation and continuation retaining the Assignment, worker Session and directory, followed by normal executor completion; and 46 read-only real records with original sequence/time. No browser page errors were observed. See the [real-machine verification record](<docs/native-verification.md>) for exact scope and reproduction; SDK and GUI evidence are counted separately.

## Requirements and two distinct patches

- DSH **0.2.2-rc.1**, Node **22.19+ / 24+**.
- The **already installed task board 0.4.15**, `@linxin666/dsh-client-ui-task-board`.
- A configured [Superagent prototype](<https://github.com/deepseek-ai/dsh-superagent-prototype>) with its repository, models and execution environment. Initial setup: Windows desktop + WSL, using a fixed IPv4-loopback origin such as `http://127.0.0.1:3082`.

**1. Existing central task-board execution guard: unchanged.** Board 0.4.15 lacks an official external-owner run-veto contract. The [guard](<src/native-guard.js>) and [installer](<scripts/install-native-guard.mjs>) accept only an exact published SHA-256 and reject external SuperAgent cards in central `startRun` before execution creation: manual run, rerun, rework, schedule, and parent dispatch with an external descendant. Changing a preset or disabling the connector does not remove an installed guard. Run controls may remain visible and return a refusal; an unknown preset is only a secondary fail-safe, not a security boundary. Backups use `$DSH_HOME/superagent-connector-backup`. This patches the board plugin, not DSH core or its desktop shell.

**2. WSL Source upstream execution capability patch.** The [deployment guide](<integration-patches/README.execution.md>) targets upstream **`8c32a9d`**. Review/apply it, typecheck/test/build, then **actually reload the idle service with no active execution**. A connector upgrade, packing an archive, or building alone does not update a running Source. Without the loaded `context.execution.version === 1`, Stop/Resume/execution records remain unavailable; terminal ticket closure must not masquerade as interruption.

## Install and upgrade

Not published to npm yet. Use this repository or a verified Release archive, not an unrelated same-name package.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
```

1. Follow the [Source patch instructions](<integration-patches/README.execution.md>), build and reload while idle; verify the running capability, not just changed files.
2. While the original board has no active execution, run `node scripts/install-native-guard.mjs`, then reload its Host plugin. The installer uses `DSH_PROFILE_DIR`, or `~/.dsh/profiles/desktop` by default.
3. Install the **same connector version** on Windows and WSL. In the WSL profile enable the Source and disable the desktop connector:

   ```yaml
   - id: superagent-connector
     disabled: true
   - id: superagent-desktop-source
     disabled: false
   ```

4. Provision the same private 32-byte random bridge token (64 hex characters) in the desktop user's `.dsh/superagent-board-token` and the SuperAgent user's `.config/dsh-superagent-board/token`. Restrict each copy to its OS account. Never put it in the browser, CLI arguments, repository or chat.
5. Allow only `desktop-owner` on the `desktop-inbox` Source allowlist; do not broaden Feishu/GitHub permissions. Reload the relevant modules, refresh the existing GUI, and verify the actual native Source connection/capabilities.

Example desktop options:

```yaml
- id: superagent-connector
  config:
    url: http://127.0.0.1:3082
    tokenFile: C:\Users\YOUR_NAME\.dsh\superagent-board-token
```

No arbitrary URL forwarding or automatic WSL start/stop is provided. An upgrade must not silently interrupt active tickets.

## Naming, cards and development

**Name settings** persists an independent Source-owned instance name (default SuperAgent; 1–80 Unicode code points), not the Feishu bot name. Saves use a revision check and create no message, Trigger, ticket or worker. Offline clients retain the last name; historical message bodies are unchanged.

Board columns are coarse projections: working → running, queued → todo, waiting for answer/review → backlog, blocked/failed → failed, confirmed completion/merge → done. Stopped/closed/dropped/unknown outcomes are not reported as success. Archiving hides a mirror; deleting it does not stop the source ticket and later synchronization may import it again. Ordinary new board cards retain their original execution behavior; they are not silently rerouted to SuperAgent.

Key modules: [native UI](<src/client.js>), [structural relay](<src/relay-agent.js>), [same-Host SDK loading](<src/relay-sdk.js>), [Agent world](<src/relay-world.js>), [durable outbox](<src/outbox-store.js>), [Source](<src/source.js>), [attachment store](<src/source-attachments.js>) and [board provider](<src/taskboard.js>). See the [implemented design](<docs/native-conversation-design.md>), [relay proofs](<experiments/native-relay/README.md>) and [attachment-admission proof](<experiments/native-attachments/README.md>) for verification boundaries.

Prototype SourceKind and some management interfaces are unstable. Revalidate SDK behavior, the DOM shim, execution patch and central guard on upgrade. This remains one machine / one owner / one repository, not multi-tenant isolation. Never publish credentials, authenticated URLs, private conversations, attachments or raw execution logs in issues.

MIT; see [LICENSE](<LICENSE>).
