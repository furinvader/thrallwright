# Codex integration contract and probe

The first integration uses a service-owned `codex app-server --listen stdio://` process. The browser connects to Thrallwright's WebSocket protocol; it does not connect directly to Codex. Codex owns authentication, permissions, execution, and conversation storage. The selected executable is Codex CLI **0.156.1**; the probe reports the version it actually runs.

The contract was checked against the installed CLI's generated TypeScript schema and the [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server), retrieved on 2026-09-25. The CLI describes app-server as experimental, and the documentation specifically marks its WebSocket transport experimental and unsupported for production. The integration uses stdio and stays on the non-opt-in API surface; this does not turn the overall app-server product into a stable compatibility guarantee. Re-run the probe and adapter tests before changing the pinned Codex version.

## Reproduce the probe

From the repository root, with the selected Codex executable on `PATH`:

```sh
node scripts/codex-probe.mjs --workspace /path/to/project
node scripts/codex-probe.mjs --workspace /path/to/project --output /tmp/codex-probe.json
```

The default makes no model calls and sends only initialization, account-read, thread-list, thread-read, and loaded-thread-list RPCs. It reads at most ten workspace thread summaries and one full history, with byte and request-time limits. A new app-server process then repeats the observations. Codex may perform its own ordinary storage maintenance during startup; "read-only" describes the probe's RPCs, not a filesystem sandbox for Codex. Codex's normal storage must be accessible.

Explicitly opt into two small model turns using existing harness authentication:

```sh
node scripts/codex-probe.mjs --workspace /path/to/project --smoke
```

This creates an ephemeral thread in a temporary workspace, requests a minimal no-tool response, then immediately interrupts a second turn. It preserves the configured model, sandbox, approval policy, and reviewer. It never approves an action: recognized command/file approval prompts are declined; unsupported server requests receive a method-not-supported response. It does not resume existing threads. The temporary workspace is removed, and the probe closes only the app-server processes it started. EOF shutdown has a bounded SIGTERM/SIGKILL fallback. A smoke check exits unsuccessfully unless completion and interruption are both confirmed.

The report contains only counts, known state/type names, and a version. It excludes session IDs, paths, prompts, message content, raw stderr, account details, and credentials. `--output` writes that sanitized report; it never saves raw traffic. Diagnostic classifications are deliberately coarse.

## Verified behavior

On 2026-09-25 Europe/Berlin (2026-09-24 UTC), the real 0.156.1 CLI passed:

| Check                           | Observed result                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Initialization and account read | Handshake completed; existing harness authentication was present.                                                                         |
| Workspace discovery             | Saved threads were returned with `status.type: "notLoaded"`.                                                                              |
| History without resumption      | `thread/read` returned stored turns; `thread/loaded/list` stayed empty before and afterward.                                              |
| Restart                         | A second independent app-server rediscovered history; it did not claim those threads were loaded.                                         |
| Start and input                 | A new ephemeral thread started `idle`; a no-tool turn emitted message deltas and completed.                                               |
| Interrupt                       | The second turn acknowledged interruption, then emitted `turn/completed` with `status: "interrupted"`; the thread became `idle`.          |
| Shutdown                        | Closing stdin ended each process with exit code zero, without forced termination.                                                         |
| Structured approvals            | No live prompt occurred. Request/response shapes were checked against generated schemas and documentation; fixture coverage is synthetic. |

Sanitized evidence is in [the read-only report](../../tests/fixtures/codex/probe-readonly.json) and [the smoke report](../../tests/fixtures/codex/probe-smoke.json). These reports establish the tested local behavior, not account-independent availability or arbitrary external session attachment.

The first sandboxed attempt could not initialize because Codex storage was read-only. Running the same probe with normal storage access succeeded, without changing Codex configuration or permissions.

## Application control check

The probe above tests Codex's wire behavior directly. The browser-to-service
check exercises Thrallwright's command journal, session projection, and local
UI with a real Codex process:

```sh
just smoke --controls --workspace /path/to/project
```

This is an explicit model-using check outside ordinary CI. It starts one
thread and three turns: an initial answer, input after an explicit Resume,
and a turn that is interrupted. Between the initial answer and Resume, the
check closes the service-owned app-server process and starts a new service
with the same temporary application profile. It checks that the saved
workflow reference and session context return, that restart sends no
execution command, and that only the user's Resume loads the saved Codex
conversation. A successful run also requires a confirmed input answer and a
Codex-reported interrupted outcome. The script writes only a sanitized
report; it does not retain prompts, transcripts, account data, or raw wire
traffic.

This check does not establish survival of the original app-server process:
Thrallwright deliberately closes the process it owns. It does not attach to
an arbitrary existing CLI process. Structured approvals have controlled
fixture and service tests, but no live approval was triggered by this
no-tool model check, so real approval delivery remains outside its evidence.

The check passed with Codex CLI 0.156.1 on 2026-09-25. Its
[sanitized control report](../../tests/fixtures/codex/workbench-controls.json)
records the observed browser assertions and execution method counts without
session IDs or message content.

## Wire contract

Stdio carries one JSON object per line. Messages omit `jsonrpc`. Client requests contain `id`, `method`, and `params`; responses echo `id` with `result` or `error`. Notifications omit `id`. Server-initiated requests have both `method` and `id` and must be distinguished from responses before correlating request IDs.

1. Send `initialize` with `{ clientInfo: { name, title, version }, capabilities: null }`.
2. Await its successful response, then send `initialized` with `{}`.
3. Dispatch further requests and read notifications continuously, including during long turns.

| Operation            | Parameters and important result                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account/read`       | `{ refreshToken: false }`; use auth availability without copying credentials or account details into application records.                                                                                                                                |
| `thread/list`        | `{ cwd, limit, cursor?, useStateDbOnly: true }`; returns `{ data: Thread[], nextCursor }`. The cwd match is exact. Default source filters include interactive sources; explicitly select other supported `sourceKinds` when needed.                      |
| `thread/read`        | `{ threadId, includeTurns: true }`; returns `{ thread }` without resuming. Full-history loading is deprecated for paginated threads; pagination APIs require a separately evaluated experimental opt-in. Surface unavailable/oversized history honestly. |
| `thread/loaded/list` | `{ limit, cursor? }`; returns `{ data: string[], nextCursor }` for this app-server's loaded threads.                                                                                                                                                     |
| `thread/start`       | `{ cwd, ephemeral? }`; returns `{ thread, model, approvalPolicy, approvalsReviewer, sandbox, ... }`. Thrallwright starts durable threads and omits policy overrides, preserving Codex configuration.                                                     |
| `thread/resume`      | `{ threadId }`; loads a persisted conversation. Thrallwright uses it only after an explicit Resume action on a known historical session, never as a navigation side effect or a means to attach to an arbitrary live process.                            |
| `turn/start`         | `{ threadId, input: [{ type: "text", text }] }`; returns an initial `{ turn }`, then streams notifications.                                                                                                                                              |
| `turn/interrupt`     | `{ threadId, turnId }`; returns `{}`. Wait for the subsequent source outcome before claiming interruption completed.                                                                                                                                     |

Codex also defines `turn/steer` for appending input to an active turn, but
Thrallwright does not expose it. **Send input** starts a new turn only when an
owned session is idle.

`Thread.status` is `notLoaded`, `idle`, `systemError`, or `active` with `activeFlags`. The flags can be `waitingOnApproval` or `waitingOnUserInput`. A completed turn does not make a conversation permanently finished, and `idle` does not establish that all work is complete. `parentThreadId`, when present, is an authoritative subagent relationship; titles and timestamps are not substitutes.

`thread/list` and `thread/read` can inspect threads produced elsewhere, but neither subscribes to another process's live execution. The probe found saved threads without any loaded session in its own app-server. Therefore the first integration can discover external history and control sessions it starts or explicitly resumes, but must not offer arbitrary existing CLI process attachment. A future shared-daemon integration needs separate lifecycle, subscription, authorization, and reconnect verification.

On app-server disconnect, clear live control and pending request actionability. A new process and reread history do not recover old server request IDs. Restoring snapshots must not send approvals, resume sessions, or replay uncertain commands.

## Approvals and unresolved requests

The pinned 0.156.1 generated schema exposes:

- `item/commandExecution/requestApproval`: `threadId`, `turnId`, `itemId`, `startedAtMs`, `kind` (`command` or `writeStdin`), nullable `environmentId`, and optional action context such as `command`, `cwd`, `reason`, and a distinct `approvalId`.
- `item/fileChange/requestApproval`: `threadId`, `turnId`, `itemId`, `startedAtMs`, optional `reason`, and optional `grantRoot`.

Respond to the server request's RPC **id**, not merely its item ID: `{ id, result: { decision: "accept" } }` or `{ id, result: { decision: "decline" } }`. Thrallwright exposes these as **Allow once** and **Decline** only for supported requests tied to the current owned session and turn. The schema also supports session-wide and amendment decisions, but this UI does not offer them. A file-change request need not include the proposed change details; the user must inspect the related activity before deciding.

`serverRequest/resolved` contains `{ threadId, requestId }`. It confirms that the request was answered or cleared, not that the underlying action succeeded. `item/completed` provides the subsequent item outcome. An already-resolved request must not accept another response; losing the connection after writing a response leaves uncertainty until authoritative evidence resolves it.

Permission grants (`item/permissions/requestApproval`), user questions, MCP elicitation, and dynamic tool calls have different response schemas. Do not translate them into generic command approvals or automatically accept unknown request types. Preserve unsupported-request visibility. Historical approval items are never actionable on their own.

The [synthetic approval fixture](../../tests/fixtures/codex/approval-flow.json) demonstrates these message identities and stages. It is derived from the generated contract, not a captured live approval. Actual approval routing depends on the user's existing harness policy and reviewer; a successful no-tool smoke test cannot validate that route.
