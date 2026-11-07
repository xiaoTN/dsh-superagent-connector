# Security model / 安全模型

- This is a DSH plugin: installing it executes trusted code with the DSH process's OS permissions. It is not an isolation mechanism.
- The desktop endpoints require the actual DSH `connection.requestRejection` authentication check. A cookie name, a custom header, or an Origin alone is **not** sufficient. No permissive fallback exists.
- The backend dials only a configured `http://127.0.0.1:<port>` origin with Node HTTP. No proxy environment, redirects, arbitrary URLs, arbitrary management routes, or methods are forwarded.
- Board reads project a small set of ticket fields. They do not expose the upstream environment, account facts, working directories, raw errors, or management credentials.
- Chat writes require an explicit Send / Ctrl+Enter in the UI, bounded JSON, a stable requestId, DSH authentication, a separate local Source bearer secret, and a Source allowlist entry. The browser cannot choose an actor, channel, or repository.
- The Source records a real human direct-message Trigger in the Superagent intake. Its allowlist and existing Policy are still enforced. This does **not** submit synthetic Feishu messages, send directly to an executor, or weaken the existing Feishu/GitHub allowlists.
- Inbox state and Superagent Trigger ingestion use the same Superagent store transaction. Duplicate requestIds cannot launch duplicate work; a reused id with different text is refused. UI errors never automatically resend a POST.
- Replies are persisted through the Source channel adapter; no hidden polling bot posts to Feishu. Only the most recent 200 messages are served; up to 2000 inbox entries are retained. The underlying Superagent store also retains its own Trigger history.
- UI renders plain text (no raw HTML, remote images, or executable Markdown). External links are opened without opener access. Common credential patterns are redacted, but this is not a secret-detection guarantee. **Never send credentials in chat.**
- The new Source token must be private to the operator. It is stored outside the repository and never sent to the browser, printed, or published. OS/file permissions, not encryption at rest, protect the token. Rotate it by stopping the two modules, replacing both copies, then restarting.
- The original Superagent `/orchestrator/api/*` uses its own local Host/Origin/header fence, not this bearer token. This plugin does not repair that upstream local management exposure. The upstream runtime and workers still need OS-account isolation and least-privilege credentials.
- Chat is single-operator / single-project in v0.1. All signed-in owner access to this DSH instance uses the same local identity and conversation. It is **not multi-user isolation**. Do not expose a shared DSH owner login to untrusted users.
- The connector writes status projections to the already installed task board through its public provider interface. It does not create a second kanban or execution engine. The required, explicit, version-hash-pinned native-board compatibility patch blocks native run admission for persistently managed Superagent cards and their parent dispatch, before opening any local execution. It is a local patch to board 0.4.15, not an upstream API or DSH-core modification. Upgrades must revalidate it; an unknown preset alone is NOT a security boundary. Native Run controls remain visible and return a refusal. Disabling the connector does not remove an already installed central guard. A trusted OS/DSH owner can, of course, edit files or remove the integration entirely.
- The plugin does not start/stop WSL, alter merge policy, approve a PR, or merge anything itself. A submitted natural-language request may cause the existing Superagent workers to execute commands, change files, push, or merge according to their existing permissions and policy. `accepted` means received, not completed.

## Reporting

Please open a GitHub issue with a redacted reproduction for non-sensitive bugs. For vulnerabilities, use GitHub private vulnerability reporting when available; never include keys, authenticated URLs, local inbox exports, or private conversation screenshots in a public issue.

中文摘要：客户端入口不是沙箱。它复用 DSH 的真实登录校验，通过单独保存在本机的密钥访问 WSL 来源，并经过 Superagent 原有的接单授权。所有已登录的本机 DSH 所有者共用一个身份和会话，不适合多人租户。原始 Superagent 管理端口和 worker 的 root/凭据权限风险仍然存在。不要在对话或公开 issue 中发送任何密钥。
