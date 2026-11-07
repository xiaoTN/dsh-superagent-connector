# Security model / 安全模型

This describes the 0.4.2 integration and its documented verification scope, not a sandbox or an arbitrary-tool cancellation guarantee. See the [implemented design and evidence boundaries](<docs/native-conversation-design.md>). 0.4.0/0.4.1 were local staging only, without a public tag.

## Trust and execution authority

- Installing this plugin executes trusted code with the DSH process's OS permissions. It is **not** a sandbox, encryption-at-rest layer, or multi-tenant authorization system. The supported scope remains one machine, one DSH owner and one SuperAgent repository.
- WSL SuperAgent remains the authority for authorization, routing, models, permissions, tickets, Assignments and workers. Existing root/OS/GitHub credentials and push/merge policy remain unchanged. A natural-language message or attachment can still cause privileged commands, edits, pushes or merges according to that existing policy.
- The local native conversation is a Source-backed structural Agent, not an ordinary assistant/provider alias. Native global model/permission settings do **not** configure WSL workers. The local `model.current()` being undefined is not a statement about the real Source worker's model.
- The relay reuses already-mounted Host foundations through the actual AgentLoop constructor's public dependency declaration; real Teams hooks require existing `systemPrompt`/`tools`. It does not construct a local LLM/provider or call a model to impersonate SuperAgent. See [Agent-world implementation](<src/relay-world.js>).

## Authentication and narrow transport

- Desktop endpoints require the actual DSH `connection.requestRejection` authentication result. A cookie name, custom header or Origin alone is insufficient; there is no permissive fallback.
- The backend dials only a configured `http://127.0.0.1:<port>` origin using Node HTTP. No proxy environment, redirects, arbitrary URLs, arbitrary management/Session proxy or caller-supplied repository/actor is forwarded.
- WSL private Source intake additionally requires the separate bearer secret, non-browser request policy and the Source allowlist. Only `desktop-owner` is enrolled for `desktop-inbox`; the connector does not widen Feishu/GitHub policy or forge channel messages.
- The bridge secret stays in private OS-account files outside the repository. It is not sent to the browser, put in CLI arguments or printed. File/OS permissions, not encryption, protect it. Coordinate replacing both copies and reloading the modules without treating reload as permission to interrupt active work.
- The prototype's original `/orchestrator/api/*` has its own local Host/Origin/header fence, not this bearer token. The connector does not repair upstream local-management exposure. WSL and workers still need appropriate OS-account isolation and least-privilege credentials.

## Admission, recovery and bounded retention

- Native **Enter queues / Shift+Enter inserts a newline**. Send is an explicit user action. The Controller admits real user content; Source then records a genuine human direct-message Trigger through its existing authorization and intake, never direct executor injection.
- A synchronous private outbox save must finish before native admission succeeds. `unknown` is durable **before any upload or submit side effect**. Lost acknowledgement, disconnect or restart never automatically resends uncertain work. Exact Source receipts/history reconcile it instead.
- Request identity binds text and ordered attachments. Source journal + Trigger intake share the Source atomic transaction. Reusing a requestId for different content conflicts. `accepted` means received, not completed, nor necessarily a ticket id or a new ticket.
- The local outbox caps a conversation journal at **256 requests / 10 MiB**. Full/corrupt/unwritable storage refuses new admission; it does not silently evict messages. Do not truncate/delete uncertain drafts as a recovery shortcut. It contains private messages/attachment refs and requires private OS-account storage.
- Confirmed history is Source-authoritative and paged at most **200 entries** with a byte budget. The new journal no longer truncates at 2000; only the legacy rollback mirror retains that limit. Local outbox records cannot fabricate confirmed Source replies.
- The native facade opens **no ordinary SessionPersistence writer**. Cold lookup, retained observations and Source-origin fork attempts must not resume it through the ordinary model factory. Offline/unloaded failures refuse closed. Restoring a native Source UI is not permission to start a worker.

## Attachment boundary

- Official Native FileUploads receipts are scoped to the exact receiving Session object and are ephemeral. They cannot be reused as WSL receipts, cross-Session credentials or durable outbox identities. Admitted durable local refs are saved separately; the pump reads actual bytes through public attachment storage.
- Native image normalization may change bytes and format, e.g. PNG to WebP. Always transfer the actual stored bytes with their actual MIME. Generic FileRefs have no MIME and remain honest binary files; display names/extensions do not confer image readability. Never change MIME merely to bypass validation.
- The WSL Source store mints its **own random receipt** and SHA-256, bound to owner/conversation/request and then the exact committed message. Public DTOs contain safe display metadata and requested bytes, not arbitrary filesystem paths. Caller filenames never become storage paths; paths/URLs are not accepted as receipts.
- Source limits are **20 MiB/file**, **10 files / 100 MiB/request**, default **500 MiB / 1000 files** total, plus strict canonical-base64/JSON budgets. PNG/JPEG/WebP/GIF headers and declared MIME are checked. Unsupported formats, fake images and excess size produce genuine errors, not a “successful” empty attachment.
- Private root/ancestors/files reject symlinks and out-of-root references; content hardlinks are refused. Atomic file/manifest publication, digest checks and writer-lock recovery protect store integrity. These checks are not a defense against an already trusted same-OS-account process deliberately changing its own files or code.
- `prepare` pins the precise message binding before Source atomic intake. Server-only prepared resolution permits building real worker context without prematurely claiming commitment. `commit` follows successful Source intake; restart replays it from durable Source messages. Unknown transaction outcomes retain prepared files. Only a known failed Source transaction can abort them. Draft TTL cleanup does not delete prepared or committed session files.
- Committed-file downloads require exact owner/conversation/request/message/receipt. Prepared/draft files are not public downloads. Source history import verifies receipt/length/SHA-256 and writes genuine bytes into native attachment storage; missing/corrupt bytes cannot become a fabricated native ref.
- The controlled worker may receive a genuine read-only WSL attachment path. This is permitted because it already runs as that OS account; it is **not** a new OS access-control boundary. File names and contents remain untrusted data, potentially containing prompt injection or secrets.
- Source `threadContext.image` verifies original-message ownership, the actual active model's image modality and actual limits before real `saveImage`. An unsupported model refuses; it must not claim an image was inspected. Worker `read_image` also consumes real files, not a Windows receipt mislabeled as a path.

## Controls, history and unsupported UI

- Nonterminal Stop/Resume requires the separately reviewed [Source execution patch](<integration-patches/README.execution.md>) for upstream **`8c32a9d`**, built and **actually reloaded while idle**. Connector-only upgrades or builds do not update a running Source capability. Without real `execution.version === 1`, controls/trace remain unavailable.
- Controls verify Source/thread/ticket provenance and require current `expectedAssignmentId` + `expectedControlSeq`. Stale controls conflict. Stop preserves the ticket/Assignment/worker directory/branch; it is not terminal management stop. Resume is not a retry/new Assignment.
- `paused` means a durable user hold. **Only `interruption: settled` proves actual cancellation drained** worker preparation/jobs/subagents. Requested/failed/unsettled cancellation cannot be resumed. An aborted HTTP request does not stop a worker; unloading a local view only stops observation.
- Trace reads are cold/passive and scoped to actual authorized workers: one underlying page, at most **100 visible records / 128 KiB**, original seq/time and bounded cursors. No cold Agent activation, Main/coordinator mixed history, hidden-page auto-scanning, invented tool/model events or raw reasoning/system prompt/tool argument/result/configuration export.
- Source kinds are preserved as actually emitted (`acknowledgement`/`reply`/`notice`); legacy kindless records remain `delivery`, never a guessed success/result. Route/model metadata is reported only when present in a real persisted event.
- Local model/reasoning/permission controls, steer, approval, Plan, Goal, local commands, injected context, title-LLM refresh and fork are unsupported. RC.1's **Source-scoped DOM/ARIA shim is compatibility code, not an official per-session SDK capability**. It hides/refuses those inputs; Host rejection remains necessary. Revalidate it after SDK/DOM/locale upgrades. Hidden controls alone are never an authorization boundary.

## Rendering, identity and the existing board

- Source text is untrusted content rendered through native conversation presentation, not trusted executable instructions. Independent instance names are rendered as plain text and quoted as identity labels in Source facts. No arbitrary settings route is exposed.
- Name GET/PUT uses bounded strict JSON and a matching revision in addition to actual DSH owner authentication, private bridge credential and Source allowlist. It only changes Source-owned identity; it does not modify Feishu accounts, model/permission policy, intake or execution.
- Field projection and recognized-credential redaction reduce exposure; they are **not secret-detection guarantees**. Do not send credentials in chat or attachments. Do not assume an arbitrary visible worker message has been perfectly sanitized.
- The connector uses the existing task board's public provider interface, not a second kanban or execution engine. Its required, explicit version/hash-pinned **central board 0.4.15 guard remains unchanged**, blocking persistent external SuperAgent cards before local execution creation, including rerun/schedule/parent dispatch. See [guard implementation](<src/native-guard.js>).
- Changing a preset or disabling the connector does not remove that installed central guard. Run controls may remain visible and refuse execution. An unknown preset is not a security boundary. This board-plugin patch is separate from both the UI shim and upstream Source patch; a trusted OS/DSH owner can edit/remove any of them.

## Verification and reporting

The actual RC.1 SDK suite passes **24/24**. Separate real-machine checks verified native sends, actual WSL text/image consumption, settled interruption during preparation and continuation of the same Assignment/worker/worktree to normal completion, and read-only real execution records. See the [verification record](<docs/native-verification.md>) for exact scope; this is not an OS cancellation/sandbox guarantee for arbitrary third-party tools. The [v0.2 chat image](<docs/images/chat.png>) is a legacy simplified UI screenshot, not native-conversation acceptance evidence.

For non-sensitive bugs, open a redacted GitHub issue. For vulnerabilities, use private vulnerability reporting when available. Never include secrets, authenticated URLs, private outbox/history exports, attachments or private conversation screenshots publicly.

**中文摘要：** 本入口使用真实原生会话，但执行权仍在 WSL Source；不是普通助手改名，也不是沙箱。当前仅单机、单 owner、单仓库，Native 全局模型/权限不会改 WSL worker。真实附件必须读本机 bytes 后换取 WSL 新 receipt，不能跨机复用旧凭据；prepared/committed 生命周期、归属、MIME 与大小都会校验。未知回执不自动重发，outbox 满额拒绝而不删消息。Stop 为保留工单的非终结中断，只有取消 settled 后才可继续；HTTP 断开不等于已停。执行补丁须先构建并在 idle 时真正 reload；UI DOM/ARIA shim 不是 SDK 原生 capability 或安全边界。原始 root/凭据和本地管理端口风险不变，不要在聊天、附件或公开 issue 中发送密钥。
