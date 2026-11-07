# Source-scoped nonterminal execution controls

This integration patch targets the `dsh-superagent` prototype at commit `8c32a9d`. It does **not** change the existing service launcher, install a bundle, reload a service, or operate on a production ticket. Review and deploy separately.

## Apply and build

From the upstream checkout, after inspecting and preserving existing changes:

```sh
git status --short
git apply --check /path/to/0001-source-execution-interrupt-resume.patch
git apply /path/to/0001-source-execution-interrupt-resume.patch
pnpm typecheck
pnpm test
pnpm build
```

No dependency installation or runtime permission/version exemption is required by these source changes. The prototype remains on its existing alpha dependency types; passive history dynamically supports both alpha `inspect` + `page` and RC `events`/`page`. Do not replace this capability with private `ctx.orchestrator.engine` access.

## Public interface (version 1)

```ts
context.execution.version === 1
context.execution.read({ threadKey, ticketId, limit: 0 }) // state only, no Session I/O
context.execution.read({ threadKey, ticketId, cursor?, limit? })
context.execution.interrupt({ threadKey, ticketId, expectedAssignmentId, expectedControlSeq })
context.execution.resume({ threadKey, ticketId, expectedAssignmentId, expectedControlSeq })
```

Controls require both compare-and-set fields. Initial `controlSeq` is 0. Exactly replaying the last operation is idempotent; a Stop from an earlier generation conflicts after continuation even though the Assignment is reused. Extra `text`, Session or main-Session fields are refused. Send human text through the Source's normal `receive`/Trigger path.

Every operation verifies the context's Source kind, stored origin Thread membership, and the ticket's non-context-only subscription. The calling Source must additionally enforce authentication, owner/conversation permissions and its HTTP allowlist.

Summary fields include `version`, `threadKey`, `ticketId`, optional `assignmentId`, `state` (`pending`, `running`, `paused`, `ended`), `activity` (`running`, `idle`, `cold`, `preparing`, `unknown`), `controlSeq`, optional `pausedAt`, and optional `interruption` (`requested`, `settled`, `failed`). State `running` is the Assignment lifecycle, not proof that a model turn is currently executing. `activity` observes the existing SDK Agent registry or preparation map without activating a cold Session.

A paused lifecycle means the durable user hold committed. **Only `interruption: 'settled'` proves cancellation was acknowledged**: the SDK worker reached idle, preparation exited, running jobs stopped and subagents drained. Interrupt waits at most one second in the foreground; a longer cancellation remains `requested`. Resume refuses with 409 until cancellation settles. Poll state-only reads; never equate an aborted HTTP request with worker cancellation.

Trace pages return display-only projections with original `seq` and `time`, `history` (`available`, `missing`, `unsupported`, `not-read`), `hasMore`, `truncated` and optional `nextCursor: {throughSeq,beforeSeq}`. One underlying page, at most 100 visible records and 128 KiB per call; never auto-scan hidden pages. Reasoning, system prompts, raw tool arguments/results, configuration and credential fields are not exported; recognized credential strings in visible text are redacted. A filtered empty page is not empty history. Route metadata is retained only from an actual persisted event stating provider and model. Do not turn these projected traces into fabricated native model/tool events.

`SourceExecutionError` exposes only fixed `name`, `status`, `code`, `message`; no internal stack/cause/details. Statuses: invalid window 400, Source scope refusal 403, missing execution 404, lifecycle/CAS conflict 409, operational failure 503. Conflict codes include `staleAssignment`, `staleControl`, `ticketEnded`, `executionPaused`, `executionNotPaused`, `mandateRevoked`, `interruptionPending`.

## State and compatibility

The authoritative hold is derived from an append-only ticket execution-control journal. Its persistence and cancellation effect are transactional. Cancellation begins only after commit. Launch, delivery, restart recovery, transient retry, idle callbacks and late reports recheck the persisted hold and control generation. Cancellation receipts are separate executor facts and never clear that hold.

Resume retains the same Assignment, worker Session ID, execution directory and branch; no retry or fresh worktree is invented. Existing management stop remains terminal; existing retry still replaces an Assignment and refuses a user-interrupted execution until explicitly continued.

The installed runtime must actually load the patch before any connector advertises interrupt/resume. Absent `execution.version === 1`, controls must remain unavailable. Building alone does not update a running instance.

## Verification

Verification run: typecheck and build passed; the complete suite ran 1,213 tests, with 1,212 passing and only the separately confirmed pre-existing Feishu consumer failure below. The 16 new execution regressions passed.

Prototype regression tests exercise successful interruption/continuation, stale Assignment and generation rejection, exact replay, rollback, in-flight delivery/preparation, restart with a durable pause, delayed retries and reports, background jobs/subagents, cancellation requested/failed/settled acknowledgment, Source ownership, redaction and bounded cold history.

The existing Feishu consumer test `takes in the event lines it reads, records each chat as direct or not, and reports a malformed line without stopping` fails at its health assertion on the original baseline too (expected error/JSON, actual ready/Listening for bot events). It was verified by temporarily restoring the original Source-context module and Source test, then restoring working changes; this patch does not mask or skip that failure.

For an independent real RC SDK proof, from the connector checkout:

```sh
export DSH_NATIVE_SDK="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
node --experimental-transform-types ./integration-patches/cold-execution-proof.mjs "$UPSTREAM_CHECKOUT"
```

The proof runs the actual adapter against the actual RC HistoryController and JSONL persistence with the real default AgentLoop factory mounted. It creates only a temporary synthetic detached log, reads two real sequence/timestamp entries, proves state-only reads use zero pages, proves zero Agents activated and zero LLM calls, then disposes and deletes only its verified temporary directory. No running DSH service is contacted.
