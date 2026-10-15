# pi-session-manager

Run [pi](https://github.com/earendil-works/pi) sessions in the background, each in its own process.
Detach from a session, close the terminal, and attach to it again from any other terminal.
Manage all sessions from one overlay, like the agent view of Claude Code.

- Start an agent with a task, and it works in the background.
- See which agents work, wait for you, finish, or fail.
- Read what each agent did without leaving your current session.
- Rename, message, interrupt, pin, or stop any agent.
- Open any agent with one key. Each agent is a full pi session.
- A crash or a `/quit` in one session leaves the other sessions alive.

## Install

```bash
pi install npm:@therealbrewerjack/pi-session-manager
```

Or install from GitHub:

```bash
pi install git:github.com/BrewerJack/pi-session-manager
```

To try it without installing:

```bash
git clone https://github.com/BrewerJack/pi-session-manager
pi -e ./pi-session-manager/index.ts
```

The package also has a small command, `pi-sm`, for the shell.
`pi install` does not put it on your `PATH`. Install the package with npm to get it:

```bash
npm install -g @therealbrewerjack/pi-session-manager
```

`pi-sm` runs the sessions with the `pi` on your `PATH`.
`PI_SM_PI_DIR` can point to another pi package.

Do not install it together with another extension that runs several sessions in one process.
Two such extensions fight over the terminal.

## Quick start

1. Start `pi` as usual. Press `alt+s` to open the manager. On macOS, press `⌥S` (Option+S).
2. Press `n`, type a task, and press `⏎`. The agent starts in the background.
3. Keep working. A notice appears when the agent finishes or has a question.
4. Press the shortcut again to see its status, or press `⏎` to open it in this terminal.
5. Press `ctrl+d` on an empty editor to leave the agent. It keeps running.

You can also type `/sessions` in any session.

## Detach and attach

A background session never needs a terminal.
A terminal attaches to it, shows it, and detaches again.
Detach never stops a session.

| To detach | Where |
| --- | --- |
| `ctrl+d` on an empty editor, `ctrl+c` twice, or `/quit` | In any background session |
| `/sessions detach` | In any background session |
| The shortcut, then `⏎` on another session | The terminal moves to that session |
| Close the terminal | The session keeps running |

When you attach to a session, a notice tells you what happened since you last looked.

Only one terminal shows a session at a time.
When a second terminal attaches, the first one returns to where it came from.

### From the shell

```bash
pi-sm                     # open the manager in this terminal
pi-sm attach fix-tests    # attach to a session by name or id
```

| Command | Action |
| --- | --- |
| `pi-sm` | Open the manager. Without a terminal, list the sessions. |
| `pi-sm list [--json]` | List every session. |
| `pi-sm new [--cwd dir] [--name n] [--session file] [--bg] [task]` | Start a session, and attach to it unless you give `--bg`. |
| `pi-sm attach <session>` | Attach this terminal to a session. |
| `pi-sm stop <session>` | Stop a session. Its session file stays. |
| `pi-sm daemon status` | Show the supervisor. |
| `pi-sm daemon stop [--keep-workers]` | Stop the supervisor, and the sessions unless you give `--keep-workers`. |

`<session>` is an id, a name, an id prefix, or the start of a name or first prompt.

### Move a session to the background

`/sessions bg` moves the session of plain `pi` into a background session, and this terminal attaches to it.
When you detach, plain pi shows a new empty session.

If you start `pi --session <file>` or `pi --resume` on a session that runs in the background,
pi attaches to that session instead of opening a second copy of it.
When you close the manager after the detach, pi ends.

### Use pi only as a client

Set `sessionManager.startDetached` to `true`, and plain `pi` opens the manager at once.
pi then works like `pi-sm`: you see only the background sessions.
Closing the manager ends pi.

## The manager

Each row shows one session:

```text
 ❯ 2 ⠙ fix-login-tests (open elsewhere)                    bash npm test        42s
        ~/code/app · claude-opus-5-5 · high · 81k tok · $0.37 · ctx 12%
```

| Icon | Meaning |
| --- | --- |
| spinner | The agent works. The row shows its current tool. |
| `?` | The agent waits for your answer. |
| `✓` | The agent finished. |
| `■` | You interrupted the agent. |
| `✗` | The run failed, or the session crashed twice. |
| `○` | The session is ready. |
| `◌` | The session starts. |
| `◇` | A saved session without a process. It starts when you use it. |
| `•` | The agent finished while no terminal showed it. |

`(this session)` marks the session that runs the manager.
`(open elsewhere)` marks a session that another terminal shows.
`pinned` marks a session that keeps its process when it idles.

A preview under the list shows the last prompt and the newest reply of the selected session.

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Select a session. |
| `⏎` or `1`–`9` | Open a session in this terminal. |
| `→` | Open the detail screen. |
| `n` | Start a new agent. Leave the task empty to open a blank session. |
| `m` | Send a message. If the agent is busy, pi queues the message. |
| `e` | Rename the session. pi saves the name in the session file. |
| `x` | Interrupt the current run. |
| `k` | Stop a session. The manager asks first. On a saved session, `k` removes it from the list, and its file stays. |
| `p` | Pin a session, or unpin it. |
| `o` | Start a session in another folder. |
| `r` | Open a saved pi session file as a background session. |
| `/` | Filter by name, folder, prompt, or model. |
| `esc` | Go back or close. |

### Detail screen

The detail screen shows status, folder, model, token use, cost, context use, message counts,
the session file, the write locks, and the full transcript.
It updates while the agent works.
Use `↑` `↓` `pgup` `pgdn` to scroll, and `tab` to go to the next session.

## Commands

```text
/sessions                 Open the manager.
/sessions new [task]      Start an agent. With a task, it runs in the background.
/sessions list            Show the status of every session.
/sessions open <name>     Open a session in this terminal.
/sessions rename <name>   Rename this session.
/sessions stop <name>     Stop a session. Its file stays.
/sessions resume          Open a saved pi session file as a background session.
/sessions bg              Move this plain session to the background and attach to it.
/sessions detach          Leave this background session. It keeps running.
```

Press `tab` after `/sessions` to complete subcommands and session names.

## The life of a session

| Event | Result |
| --- | --- |
| You start a session | A process starts for it. New agents take over the model, thinking level, and tools of the session that started them. |
| You detach | The session keeps running. |
| The session idles for an hour with no terminal | Its process stops, and the session becomes saved (`◇`). Pinned sessions stay. |
| You open or message a saved session | Its process starts again from the session file. |
| The process crashes during a run | It starts again once, from the session file. The run stops, and the row says so. A second crash within 10 minutes marks the session as failed. |
| You stop a session | Its process ends, and the session leaves the list. Its session file stays, and `/resume` still finds it. |
| The machine restarts | Sessions come back as saved, or as failed if they were working. |

A session that never got a message has no file. When its process ends, it leaves the list.

## Status bar

When other sessions run, a line under the editor shows each session and its state.

## Token use in the footer

The footer of pi shows the token use of the session on screen.
With two or more sessions, the extension adds a line under it with every session:

```text
Σ 93k $1.42 │ docs 4.4k 0.4% · fruit-bot 7.5k 2.2% · tests 81k 12%
```

- `Σ` is the total over all sessions: tokens (input, output, and cache) and cost.
- Each part shows the tokens and the context use of one session.
  The session on screen has the accent color.
- Saved sessions have a `◇` mark.
- The total comes first, because pi cuts the line at the screen width.
- The line updates at most once a second.

## Safe parallel writes

Two sessions cannot write the same file or folder at the same time.
The supervisor blocks the second write and tells the agent which session holds the path.
Plain pi takes part too, while background sessions run.

## Configuration

Add a `sessionManager` key to `~/.pi/agent/settings.json`:

```json
{
  "sessionManager": {
    "shortcut": "alt+s",
    "macOptionChars": ["ß"],
    "startDetached": false,
    "idleMinutes": 60,
    "env": ["AWS_PROFILE", "GITHUB_*"]
  }
}
```

| Key | Meaning |
| --- | --- |
| `shortcut` | The key that opens the manager. It uses the pi key syntax, for example `alt+m` or `ctrl+alt+s`. The default is `alt+s`. |
| `macOptionChars` | The characters that open the manager on macOS while you hold Option. The default is the US-layout character of the shortcut letter, for example `ß` for `alt+s`. Set it to `false` to turn the Mac fallback off. |
| `startDetached` | `true` makes plain `pi` open the manager at once, as a pure client. The default is `false`. |
| `idleMinutes` | An idle session with no terminal loses its process after this many minutes. `0` keeps processes alive. The default is `60`. |
| `env` | More environment variables for new sessions. See the next section. |

| Variable | Meaning |
| --- | --- |
| `PI_SESSION_MANAGER_SHORTCUT` | Overrides `shortcut`. |
| `PI_SESSION_MANAGER_START_DETACHED` | `1` or `0` overrides `startDetached` for one start. |
| `PI_SESSION_MANAGER_ENV` | More names for the `env` list, separated by commas. |
| `PI_SM_PI_DIR` | The pi package that `pi-sm` uses. |
| `PI_SESSION_MANAGER_DEBUG` | `1` writes suppressed errors to `~/.pi/agent/pi-session-manager-debug.log`. |

Restart pi after you change the shortcut. The supervisor reads `idleMinutes` again every few seconds.

### The environment of a session

A session runs in a process of a background supervisor, not in your shell.
It gets the environment of the supervisor, which comes from the terminal that started the supervisor.
Each new session also gets some variables from the terminal that starts it:

- Shell: `PATH`, `LANG`, `LC_*`, `TZ`, `EDITOR`, `VISUAL`
- Terminal: `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`
- Proxy: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and the lowercase forms
- pi: `PI_OFFLINE`, `PI_TELEMETRY`, and the other `PI_*` settings of the terminal UI

This list holds no keys or tokens.
`sessionManager.env` adds names. An entry that ends in `*` adds every name with that start.

**The supervisor saves these variables in the session record, so a restart sees the same values.**
If you add a variable that holds a secret, the secret lands in that file.
The file has mode `0600`, so only your user can read it.

## macOS

The extension works on macOS in Terminal, iTerm2, Ghostty, kitty, WezTerm, Alacritty, and the VS Code terminal.
The hints and notices show the shortcut as `⌥S`.

Most Mac terminals turn Option+S into the character `ß` instead of sending `alt+s`.
The extension handles this case.
When `ß` arrives, it asks macOS whether you hold Option.
If you do, it opens the manager. If you do not, you just typed `ß`, and it stays in your text.
In a background session, the terminal that shows it does this check and sends `alt+s` to the session.

This check needs pi to run on the Mac itself.
Over SSH, or when the Mac helper of pi is missing, set your terminal to send Option as Alt instead:

| Terminal | Setting |
| --- | --- |
| Terminal | Settings → Profiles → Keyboard → turn on **Use Option as Meta key**. |
| iTerm2 | Settings → Profiles → Keys → set **Left Option key** to **Esc+**. |
| Ghostty | Add `macos-option-as-alt = true` to the config file. |
| kitty | Add `macos_option_as_alt yes` to `kitty.conf`. |
| Alacritty | Add `option_as_alt = "Both"` under `[window]`. |
| WezTerm | Left Option sends Alt by default. |

Other keyboard layouts type other characters for Option+S, for example `‚` on the German layout.
Add yours to `macOptionChars`.

On macOS, file names ignore case by default, and `/tmp` points to `/private/tmp`.
The write locks treat `App.ts` and `app.ts`, and `/tmp/x` and `/private/tmp/x`, as one file.

## How it works

```text
 terminal ──► supervisor ──► session process (one per session)
    │                              ▲
    └──────── attach socket ───────┘
```

- **Supervisor.** One background process per pi agent dir. It keeps the session list, the write locks,
  and starts and stops the session processes. The first command that needs it starts it.
- **Session process.** Each session runs pi with all your extensions in a process of its own.
  It draws to a socket instead of a terminal.
- **Client.** Plain `pi`, `pi-sm`, or another session. It shows the manager, or it gives the terminal to one session.

The session files of pi stay the source of truth for each conversation.
The design document [docs/detached-sessions.md](docs/detached-sessions.md) describes the parts in detail.

### Files

| Path | Contents |
| --- | --- |
| `~/.pi/agent/pi-session-manager/sessions/<id>.json` | One record for each session in the list |
| `~/.pi/agent/pi-session-manager/supervisor.log` | The log of the supervisor |
| `~/.pi/agent/pi-session-manager/workers/<id>.log` | The log of one session process |
| `~/.pi/agent/pi-session-manager/supervisor.sock` | The socket of the supervisor |

Deep agent dirs keep the sockets in `$XDG_RUNTIME_DIR` or the temp folder instead, because macOS limits socket paths to 104 bytes.

## Upgrade from 0.3

Versions 0.1.0 to 0.3.0 ran all sessions in one pi process.
A main session recorded its child sessions in its session file.

When you open such a main session in 0.4.0, its child sessions move to the session list as saved sessions, once.
A notice tells you how many moved.

A supervisor of an older version restarts on the next command. Its sessions keep running.

## Limits

- Linux and macOS only.
- Each session holds its own pi process with all extensions. Ten sessions use about ten times the memory of one.
- The external editor (`ctrl+g`) does not work in a background session yet. The session shows a notice.
- Only one terminal shows a session at a time.
- A crash restart resumes from the session file. A tool call right before the crash can leave changes that the file does not record.
- pi binds `ctrl+r` to renaming, so this extension uses `alt+s` by default.

## Troubleshooting

- `pi-sm daemon status` shows the supervisor, its version, its log, and the number of sessions.
- `supervisor.log` and `workers/<id>.log` in `~/.pi/agent/pi-session-manager/` hold the errors of each process.
- `pi-sm daemon stop` stops the supervisor and all sessions. The next command starts a fresh supervisor.
- Set `PI_SESSION_MANAGER_DEBUG=1` before you start pi.
  The extension then writes suppressed errors to `~/.pi/agent/pi-session-manager-debug.log`.

## Development

```bash
npm install
npm run typecheck
npm test
```

pi loads the TypeScript files directly. There is no build step.
The tests need Node.js 24 or newer, which runs TypeScript directly.
The end-to-end tests run real pi sessions in a throwaway agent dir with no login, so no model ever runs.
They need `pi` on your `PATH`, and the tests of plain pi also need `script` from util-linux.
Without them, these tests skip.

## Acknowledgments

This extension builds on [pi-parallel-sessions](https://github.com/liushihao456/pi-sessions)
by [liushihao456](https://github.com/liushihao456), under the MIT license.
That project showed how to run several pi sessions in one process and pass the terminal between them.

As of 0.4.0, pi-session-manager no longer uses the **terminal handoff** of pi-parallel-sessions.
That code parked the main session and gave the screen to a child.
Each session now runs in its own process, and a terminal attaches to it over a socket.
There is no main session anymore.

These parts still come from pi-parallel-sessions:

- **Session runtime** (`runtime.ts`): the code that creates each session with the model,
  thinking level, tools, and project trust of the session that started it.
- **Path locks** (`locks.ts`): the code that stops two sessions from writing the same path at once.
  The supervisor now runs it for all session processes.
- **Pickers** (`pickers.ts`): the folder explorer and the saved-session picker.

Versions 0.1.0 to 0.3.0 also used the terminal handoff, in `host.ts`.

This project adds the manager overlay, the detail screen, the status bar, and background agents.
It also adds usage and context stats, notices, the `/sessions` subcommands, macOS keyboard support,
and case-aware and symlink-aware path locks.
As of 0.4.0, it also adds the supervisor, the session processes, the socket terminal,
and detach and attach from any terminal.
It drops the hidden terminal that versions 0.1.0 to 0.3.0 used for background sessions.

## License

MIT. See [LICENSE](LICENSE). The license keeps the copyright notice of pi-parallel-sessions.
