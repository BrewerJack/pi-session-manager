# Detached sessions

Status: draft, 2026-10-14. Target release: 0.4.0, published to npm once M7 is done. No prerelease and no 1.0.0 with it.

This document specifies how pi-session-manager moves from one process for all sessions
to a supervisor with one process per session.
Sessions then outlive the terminal that started them.
Any terminal can list them, attach to them, and detach from them.

## 1. Goals

1. A session does not depend on the process or terminal that started it.
   Closing a terminal, `/quit`, or a crash of one session leaves the other sessions alive.
2. Every session that is still active appears in the list, from any terminal and any folder.
3. No session is special. The current main session goes away.
   The terminal only shows a list or one attached session.
4. Detach and attach work from the manager, from a slash command, and from the shell.
5. The manager overlay, status bar, footer breakdown, and path locks keep their current behavior.

## 2. Non-goals

- Sessions on other machines. The supervisor serves the local user only.
- Two terminals attached to one session at the same time. A second attach takes over (§7.3).
- Windows. The first release supports Linux and macOS.
- Git worktrees for each session. Path locks stay the only protection against parallel writes.

## 3. Current design and its limits

All sessions live in one pi process (`host.ts`).

| Part | Today | Limit |
| --- | --- | --- |
| `SessionHost` | One per process, stored on `globalThis` | No other process can see the sessions. |
| Main session | The pi session of the process, `PARENT_ID` | It cannot stop. `list()` always shows it first. |
| Children | `InteractiveMode` against a `GatedTerminal` | They die with the process. |
| `/quit` | `InteractiveMode.shutdown()` calls `process.exit(0)` | `/quit` in any session ends all sessions. |
| Child list | `pi-session-manager.children` entry in the main session file | The list belongs to one main session, not to the user. |
| Path locks | `LockManager` in memory | Correct only inside one process. |

## 4. Model: Claude Code agent view

Claude Code solves the same problem with a supervisor and background sessions.
See the [agent view docs](https://code.claude.com/docs/en/agent-view).
This design copies its model:

- One supervisor per config directory. A client command starts it on demand.
- One host process for each session. A crash ends one session only.
- The list view holds no conversation. It is a client.
- Detach never stops a session. Only an explicit stop does.
- An idle, unattached session loses its process after a time. Its file stays.
  The next attach or message starts it again.
- Opening a running session from a second place attaches to it. It never opens a second copy.

## 5. Architecture

```text
 terminal A                  terminal B
 ┌───────────────┐           ┌───────────────┐
 │ client        │           │ client        │
 │ (pi + ext, or │           │               │
 │  pi-sm)       │           │               │
 └──┬─────────┬──┘           └──┬────────────┘
    │control  │ stream          │control
    ▼         │                 ▼
 ┌────────────┼──────────────────────────┐
 │ supervisor │ (registry, locks, spawn) │
 └──┬─────────┼──────────┬───────────────┘
    │control  │          │control
    ▼         ▼          ▼
 ┌──────────────────┐  ┌──────────────────┐
 │ worker: fixtests │  │ worker: docs     │
 │ InteractiveMode  │  │ InteractiveMode  │
 │ + SocketTerminal │  │ + SocketTerminal │
 └──────────────────┘  └──────────────────┘
```

### 5.1 Components

| Component | Process | Job |
| --- | --- | --- |
| Supervisor | One detached Node process per agent dir | Registry, path locks, spawn and stop of workers, idle reaping, events to clients. |
| Worker | One detached Node process per live session | Runs one pi session with its full `InteractiveMode`. Draws to a `SocketTerminal`. |
| Client | The terminal of the user | Shows the manager or forwards one attached session. Holds no session. |
| Extension | Loaded in every worker and in plain pi | Commands, shortcut, overlay, status bar, footer, lock hooks. Talks to the supervisor. |

### 5.2 Two client forms

1. **Plain pi with the extension.** The user runs `pi` as usual.
   The `/sessions` command and the shortcut open the manager.
   Attach parks the TUI of this pi process and forwards the terminal to a worker.
   An unused plain session writes no file, so it leaves nothing behind.
2. **`pi-sm`**, a small bin of this package. `pi-sm` opens the manager with no pi session at all.
   `pi-sm attach <id>` attaches from the shell.

The setting `sessionManager.startDetached: true` makes plain `pi` act like `pi-sm`.
On startup, the extension hands the terminal to the manager at once.
The plain session stays parked and never appears. This setting makes the main session invisible.

## 6. Files on disk

All state lives under `<agentDir>/pi-session-manager/`.
`<agentDir>` is `~/.pi/agent` unless pi uses another agent dir.

| Path | Contents |
| --- | --- |
| `supervisor.sock` | Control socket of the supervisor. Mode `0600`. |
| `supervisor.pid` | PID and version of the running supervisor. |
| `supervisor.log` | Log of the supervisor. Rotated at 1 MB. |
| `sessions/<id>.json` | One record for each session that the supervisor knows (§6.1). |
| `workers/<id>.sock` | Socket of one worker. It exists while the worker lives. |
| `workers/<id>.log` | stderr and suppressed output of one worker. |

The directory has mode `0700`. Socket paths must stay below 104 bytes for macOS.
If the path is too long, the sockets move to `$XDG_RUNTIME_DIR` or `/tmp/pi-sm-<uid>/`.

### 6.1 Session record

```json
{
  "id": "fix-tests-m1x2k9-a7f3",
  "sessionFile": "/home/u/.pi/agent/sessions/.../2026-10-14T....jsonl",
  "sessionId": "0f3c...",
  "name": "fix-tests",
  "cwd": "/home/u/code/app",
  "state": "working",
  "pid": 41237,
  "pinned": false,
  "createdAt": 1760400000000,
  "lastActivityAt": 1760400420000,
  "lastOutcome": "done",
  "error": null,
  "firstPrompt": "fix the login tests",
  "env": { "PATH": "..." }
}
```

The session file stays the source of truth for the conversation.
The record holds only what the list needs and what the supervisor needs to restart a worker.
The supervisor writes records atomically: write to a temp file, then rename.

### 6.2 States

| State | Process | Meaning | Row icon |
| --- | --- | --- | --- |
| `starting` | yes | The worker loads the session. | spinner |
| `working` | yes | A run goes on. | spinner |
| `waiting` | yes | A dialog waits for the user. | `?` |
| `idle` | yes | The run ended. The worker waits for input. | `✓` `■` `✗` `○` |
| `saved` | no | No worker. The next use starts one. | `◇` |
| `failed` | no | The worker died during a run. | `✗` |

`stopped` is not a state. A stop removes the record and keeps the session file.

### 6.3 Environment

A worker starts with the environment of the supervisor.
The supervisor inherits the environment of the client that started it.
On top of that, each `create` carries the allowed variables of its client, and they win.
The record keeps only these allowed variables, so a restart (§7.6) sees the same values.
Other variables never reach the record or any file.

The default allow list:

| Group | Variables |
| --- | --- |
| Shell | `PATH`, `LANG`, `LC_*`, `TZ`, `EDITOR`, `VISUAL` |
| Terminal | `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION` |
| Proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and the lowercase forms |
| pi | `PI_CACHE_RETENTION`, `PI_HARDWARE_CURSOR`, `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_TRUE_COLOR`, `PI_TUI_ESC_TIMEOUT` |

The default list holds no credentials.
A provider key such as `ANTHROPIC_API_KEY` reaches a worker only through the supervisor environment,
or when the user adds it to the list.

These variables never pass, even when the user lists them:

- `PI_CODING_AGENT_DIR`. Each agent dir has its own supervisor (§6).
- `PI_SESSION_FILE`, `PI_SESSION_ID`, and `PI_SESSION_MANAGER_WORKER`. They name one session only.

#### Configuration

The setting `sessionManager.env` in `~/.pi/agent/settings.json` adds variables to the default list:

```json
{
  "sessionManager": {
    "env": ["AWS_PROFILE", "AWS_REGION", "GITHUB_*"]
  }
}
```

- Each entry is an exact name, or a prefix that ends in `*`.
- The client reads the setting, so each client sends the variables of its own settings.
- A variable that the user adds here lands in the record, even when it holds a secret.
  The README warns about this. The record has mode `0600`.
- The environment variable `PI_SESSION_MANAGER_ENV` adds more names, separated by commas.

## 7. Lifecycle

### 7.1 Supervisor start

1. A client connects to `supervisor.sock`.
2. If the connection fails, the client takes a lock on `supervisor.pid`.
   It then spawns the supervisor detached, with `stdio` to `supervisor.log`.
3. The client retries the connection for up to 5 seconds.
4. The new supervisor reads `sessions/*.json`.
   For each record with a `pid`, it connects to `workers/<id>.sock`.
   A worker that answers becomes live again. Other records become `saved` or `failed` (§7.6).

A supervisor with an older version than the client restarts itself.
It keeps its workers alive across the restart.

### 7.2 New session

1. The client sends `create { cwd, task?, name?, model?, thinkingLevel?, tools?, env }`.
   `env` holds the allowed variables of the client (§6.3).
2. The supervisor writes the record with state `starting` and spawns a worker.
3. The worker opens or creates the session file and creates its runtime.
   It reuses `createRuntime` and the inheritance logic from `host.ts`.
4. The worker opens `workers/<id>.sock` and reports `ready { sessionFile, sessionId }`.
5. If the client gave a task, the worker sends it as the initial message.

### 7.3 Attach

1. The client asks the supervisor for `attach { id }`.
2. If the session is `saved` or `failed`, the supervisor starts a worker first.
3. The supervisor returns the path of the worker socket.
4. The client connects to the worker socket and sends `hello { columns, rows, term, colorterm }`.
5. The worker binds the connection to its `SocketTerminal`.
   It calls `ui.stop()` and then `ui.start()`, which negotiates the keyboard protocol with the new terminal.
   Then it calls `requestRender(true)`.
6. If another client holds the session, that client gets `detached { reason: "taken" }` and returns to its manager.

The worker posts a one-line recap as a notice on attach.
The recap names the last outcome and the time since the user last looked.

### 7.4 Detach

Each of these detaches. None stops the session.

| Input | Where |
| --- | --- |
| The shortcut, then `esc` to the list | The manager overlay inside the worker |
| `/quit`, `ctrl+d` on an empty editor, `ctrl+c` twice | Any attached worker |
| `/sessions detach` | Any attached worker |
| Closing the terminal | The client process dies. The worker sees the socket close. |

The worker patches `InteractiveMode.prototype.shutdown` in worker mode (§8.3).
On detach, the worker closes the gate of its `SocketTerminal`, stops its TUI, and keeps its runtime.

### 7.5 Stop

`k` in the manager, `/sessions stop <name>`, and `pi-sm stop <id>` stop a session.
The supervisor sends `stop` to the worker.
The worker aborts its run, disposes the runtime, and exits with code 0.
The supervisor removes the record. The session file stays.

### 7.6 Idle reaping and crashes

| Event | Result |
| --- | --- |
| A worker stays `idle` and unattached for `idleMinutes` (default 60) | The supervisor stops the worker. The record becomes `saved`. Pinned sessions stay. |
| A worker exits with code ≠ 0 while `working` | The supervisor restarts it from the session file once. A second crash within 10 minutes makes it `failed`. |
| A worker exits with code ≠ 0 while `idle` | The record becomes `saved`. |
| The supervisor dies | Each worker keeps running. It retries the supervisor socket every 2 seconds for 60 seconds, then exits. |
| The machine reboots | Records with a dead `pid` become `failed` if they were `working`, otherwise `saved`. |

A restart never repeats a user shell command (`!cmd`).
The worker sends no initial message on a restart.

## 8. Worker

### 8.1 Entry point

The worker starts as `node worker-boot.mjs --pi-dir <dir> --id <id> --socket <path> --info <path> --log <path> --cwd <dir>`.
`--session <file>` and `--task <text>` are optional.

`worker-boot.mjs` is plain JavaScript. Node refuses to strip types from `.ts` files under `node_modules`,
where pi installs packages (Q1).
The bootstrap imports pi natively from `--pi-dir`: `dist/index.js` and its copy of pi-tui.
It then loads `worker.ts` through the jiti that pi ships, and passes pi in.

`worker.ts` and `socket-terminal.ts` use `import type` only for pi.
This way the worker, pi, and the extensions share one pi-tui instance.
That matters, because pi-tui keeps the Kitty protocol state in a module variable.

The client passes `getPackageDir()` of its own pi as `--pi-dir`, so the worker runs the same pi version.

The worker sets `PI_SESSION_MANAGER_WORKER=<id>` before it loads extensions.
The extension reads this variable to choose worker mode.

### 8.2 SocketTerminal

`SocketTerminal` implements the `Terminal` interface of pi-tui.
It replaces `ProcessTerminal` and `GatedTerminal` in workers.

| Member | Behavior |
| --- | --- |
| `start(onInput, onResize)` | If attached: send bracketed paste on, the Kitty query, and the DA sentinel. Feed input through `StdinBuffer`. |
| `stop()` | Send bracketed paste off and pop the keyboard protocol. Drop handlers. |
| `write(data)` | Send a `data` frame if attached. Drop otherwise. |
| `columns`, `rows` | Last `hello` or `resize` values. Default 80 × 24. |
| `kittyProtocolActive` | Result of the last negotiation. |
| `drainInput()` | Resolves at once. |
| `setTitle`, `setProgress`, `setProgramStatus` | Store the value. Send it when attached and on each attach. |

The negotiation code copies the logic of `ProcessTerminal.queryAndEnableKittyProtocol`.
`StdinBuffer` is a public export of pi-tui.
Tests compare the two terminals on recorded input (§12).

### 8.3 Patches in worker mode

| Patch | Reason |
| --- | --- |
| `InteractiveMode.prototype.shutdown` sends `detach` unless the supervisor asked for a stop | `/quit` must not exit the worker (§7.4). |
| `console.log` and stray `process.stdout` writes go to the worker log | The worker has no terminal. |
| `SIGHUP` is ignored | The worker runs detached. |

Each patch checks that the patched member exists, as `patchWorkingIndicator` does today.
A missing member logs a warning and disables detached mode for that worker.

### 8.4 Output outside the terminal

A grep of pi 1.1.0 found these writes that bypass the `Terminal`:

| Source | Effect in a worker | Plan |
| --- | --- | --- |
| `formatResumeCommand` in `shutdown` | Skipped, because stdout is no TTY | None |
| `console.log` of the model scope in `InteractiveMode.init` | Goes to the worker log | None |
| `console.log` in `model-resolver.js` | Goes to the worker log | None |
| `editInExternalEditor` spawns `$EDITOR` with `stdio: "inherit"` | The editor has no terminal | Not supported in M0 to M7. The worker shows a notice. See Q7. |

### 8.5 Events to the supervisor

The worker forwards the events that `index.ts` handles today.
These are `agent_start`, `agent_settled`, `tool_execution_*`, `ui_prompt_*`, `session_info_changed`, and `model_select`.
The supervisor updates the record and pushes a `changed` event to subscribed clients.
`message_update` events go out at most every 250 ms.

## 9. Path locks

`LockManager` moves into the supervisor.
The `tool_call` hook in a worker sends `lock.acquire { paths, cwd, toolCallId }` and waits for the answer.
`tool_result` sends `lock.release { toolCallId }`.
The supervisor releases all locks of a worker when its control connection closes.

pi awaits each `tool_call` handler in turn (`ExtensionRunner.emitToolCall`), so the hook can wait for the supervisor.
If the supervisor does not answer within 5 seconds, the hook allows the write and logs a warning.

## 10. Protocol

Both sockets use JSONL control records, as the pi RPC mode does.
Each record has a `type` and an optional `id` for correlation.
Readers split records only on `\n`. They do not use `readline`.

### 10.1 Client and supervisor

| Request | Answer |
| --- | --- |
| `hello { version }` | `hello { version, pid }` |
| `list { all? }` | `sessions [record…]` |
| `subscribe` | A stream of `changed { record }` and `removed { id }` |
| `create { … }` | `created { record }` |
| `attach { id }` | `attach { socket }` |
| `send { id, text }` | `ok`. A `saved` session starts first. |
| `interrupt { id }`, `stop { id }`, `rename { id, name }`, `pin { id, pinned }` | `ok` |
| `transcript { id, max }`, `stats { id }` | Data for the preview and detail screen |
| `shutdown { keepWorkers }` | `ok` |

The supervisor reads transcript and stats of `saved` rows from the session file.
For live rows it asks the worker.

### 10.2 Client and worker

All records are binary frames: `[type: u8][length: u32 BE][payload]` (`protocol.ts`).
The first frame from the client must be `hello`. The worker closes connections that start otherwise.

| Type | Direction | Payload |
| --- | --- | --- |
| `0 hello` | client → worker | `{ version, columns, rows, term?, colorterm?, termProgram? }` as JSON |
| `1 data` | both | Terminal bytes |
| `2 resize` | client → worker | `{ columns, rows }` as JSON |
| `3 detached` | worker → client | `{ reason, message? }` as JSON. `reason` is `quit`, `taken`, `stopped`, or `error`. |
| `4 switch` | worker → client | `{ id }`. The manager in the worker picked another session. |

On `switch`, the client detaches and attaches to the new session.
This keeps the `⏎` key of the overlay working inside an attached session.

### 10.3 Worker and supervisor

The worker connects to `supervisor.sock` with `worker.hello { id, pid, socket }`.
Then it sends events (§8.5) and lock requests (§9).
The supervisor sends `stop` and `query` requests on the same connection.

## 11. Changes to existing modules

| Module | Change |
| --- | --- |
| `host.ts` | Split. `createRuntime`, inheritance, and stats move to `runtime.ts` for the worker. `GatedTerminal`, `ChildView`, `PARENT_ID`, and the handoff go away. |
| `index.ts` | The hooks forward to the supervisor in worker mode. In client mode they only install commands and the shortcut. |
| `ui.ts` | `ManagerView` and `StatusBar` read a `SessionSource` interface. `RemoteSource` implements it over the supervisor protocol. |
| `footer.ts` | No change. Its entries come from `SessionSource`. |
| `locks.ts` | No change. It runs in the supervisor. |
| `pickers.ts` | No change. `r` and `o` send `create` with a session file or cwd. |
| `keys.ts` | No change. The client handles the macOS `ß` key, because the worker has no keyboard. |
| New `supervisor.ts`, `worker.ts`, `socket-terminal.ts`, `protocol.ts`, `client.ts`, `bin/pi-sm.ts` | See §5 to §10. |

### 11.1 Migration

On the first start, the supervisor imports old child lists.
It scans no files for this. Instead, plain pi with the extension reads the `pi-session-manager.children` entry on `session_start`.
It sends each listed file as a `saved` record.
The extension stops writing that entry.

## 12. Tests

| Area | Test |
| --- | --- |
| `SocketTerminal` | Recorded Kitty, DA, and paste input give the same key events as `ProcessTerminal`. |
| Protocol | Framing round trips. Records that contain `U+2028` stay whole. |
| Supervisor | Create, list, stop, idle reap, and crash restart with a fake worker. |
| Recovery | Kill the supervisor. Workers reconnect to a new supervisor within 60 seconds. |
| Locks | Two workers write one path. The second write is blocked. |
| End to end | Start a session, detach, close the client, attach from a new client, see the same screen. |

The end-to-end test runs pi under a PTY in CI. Linux only at first.

## 13. Milestones

Each milestone ends with a working build and passing tests.

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Spike: one worker with `SocketTerminal`, and a raw attach client | A session runs, detaches, survives the client, and redraws on attach. Q1 has an answer. |
| M1 | Supervisor, registry, `create`, `list`, `stop` | `pi-sm list` shows sessions from two terminals. |
| M2 | Attach and detach over the supervisor, `/quit` patch, `pi-sm attach` | §7.3 and §7.4 work from the shell. |
| M3 | `SessionSource` and the manager overlay in clients and workers | The overlay lists, previews, and switches sessions. |
| M4 | Plain pi as client, `/sessions bg`, `startDetached` | A plain session moves to the background. The main session is invisible. |
| M5 | Path locks in the supervisor | The lock test passes. |
| M6 | Idle reaping, crash restart, supervisor recovery, reboot | §7.6 works. |
| M7 | macOS keys in the client, docs, migration, release 0.4.0 | README describes the new model. |

`/sessions bg` in M4 hands a plain session to the supervisor.
The plain pi process ends its own session, and a worker reopens the session file.
The plain pi process then attaches to that worker.

## 14. Open questions

| # | Question | How to answer |
| --- | --- | --- |
| Q1 | How does the worker start TypeScript? Node 24 runs `.ts` directly. pi may load extensions with its own loader. | Answered in M0 (§8.1). A plain `.mjs` bootstrap loads `worker.ts` through pi's jiti. |
| Q2 | May a `tool_call` handler return a promise that pi awaits? | Answered: yes. See §9. |
| Q3 | Does any pi code write to `process.stdout` outside the `Terminal`? | Answered (§8.4). |
| Q4 | Do extensions with a global state break when each session gets its own process? This mostly helps them. | Test with the extensions of the user in M2. |
| Q5 | Should the record keep the full client `env`, or only an allow list? It may hold secrets. | Answered: an allow list with user additions (§6.3). |
| Q6 | Does a second pi process that opens a session file of a live worker corrupt it? | Test in M1. If yes, the extension routes `--resume` of a live session to attach, as Claude Code does. |
| Q7 | Can the client run the external editor (`ctrl+g`) for a worker and send the text back? | After M7. |
| Q8 | pi-tui detects terminal capabilities, such as images, from the environment at startup. A worker keeps the values of the terminal that started it. Should `hello` override them for each client? | Before M3. `hello` already carries `term`, `colorterm`, and `termProgram`. |
| Q9 | `SocketTerminal` skips the OSC 7501 program status. Is it needed? | After M7. |

## 15. Risks

- `shutdown` and `setWorkingIndicator` are private members of `InteractiveMode`. A pi release can rename them.
  The patches check for them and fail closed (§8.3).
- The keyboard protocol logic of `SocketTerminal` copies pi-tui. Changes in pi-tui need a port.
- Each worker loads all extensions and holds its own model runtime. Ten workers use about ten times the memory of one session.
- A worker restart after a crash can repeat a tool call that had side effects. The restart resumes from the session file and sends no message (§7.6).

## 16. Progress

### M0: done on 2026-10-15

The spike adds `protocol.ts`, `socket-terminal.ts`, `worker.ts`, `worker-boot.mjs`, `client.ts`, and `dev/m0.ts`.
`dev/m0.ts` starts, attaches, lists, and stops workers without a supervisor.

A manual run in a PTY on Linux with pi 1.1.0 showed these results:

- The worker starts in about 3 seconds with all user extensions.
- The full TUI of pi draws through the socket. Typed text reaches the editor.
- The worker survives the loss of its client.
- A new attach redraws the full screen. The editor keeps its text.
- A resize to 70 × 20 makes pi render again at the new size.
- `ctrl+d` on an empty editor detaches with reason `quit`. The worker stays alive.
- On detach, the client receives bracketed paste off and the Kitty pop before the connection closes.

Unit tests cover the frame protocol and the keyboard negotiation of `SocketTerminal`.
A PTY test in CI is still open (§12).
