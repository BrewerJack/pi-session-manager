# pi-session-manager

Run several agents at once in one [pi](https://github.com/earendil-works/pi) process.
Manage them from one overlay, like the session view of the Claude Code CLI.

- Start an agent with a task, and it works in the background.
- See which agents work, wait for you, finish, or fail.
- Read what each agent did without leaving your current session.
- Rename, message, interrupt, or stop any agent.
- Switch to any agent with one key. Each agent is a full pi session.

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

Do not install it together with another extension that runs several sessions in one process.
Two such extensions fight over the terminal.

## Quick start

1. Press `alt+s` to open the manager.
2. Press `n`, type a task, and press `⏎`. The agent starts in the background.
3. Keep working. A notice appears when the agent finishes or has a question.
4. Press `alt+s` again to see its status, or press `⏎` to switch to it.

## The manager

Each row shows one live session:

```text
 ❯ 2 ⠙ fix-login-tests                                    bash npm test        42s
        ~/code/app · claude-opus-5-5 · high · 81k tok · $0.37 · ctx 12%
```

| Icon | Meaning |
|---|---|
| spinner | The agent works. The row shows its current tool. |
| `?` | The agent waits for your answer. |
| `✓` | The agent finished. |
| `■` | You interrupted the agent. |
| `✗` | The run failed. |
| `○` | The session is ready. |
| `•` | The agent finished while you were in another session. |

A preview under the list shows the last prompt and the newest reply of the selected session.

### Keys

| Key | Action |
|---|---|
| `↑` `↓` | Select a session. |
| `⏎` or `1`–`9` | Switch to a session. |
| `→` | Open the detail screen. |
| `n` | Start a new agent. Leave the task empty to open a blank session. |
| `m` | Send a message. If the agent is busy, pi queues the message. |
| `e` | Rename the session. pi saves the name in the session file. |
| `x` | Interrupt the current run. |
| `k` | Stop a session. The manager asks first. |
| `o` | Start a session in another folder. |
| `r` | Open a saved session as a live session. |
| `/` | Filter by name, folder, prompt, or model. |
| `esc` | Go back or close. |

### Detail screen

The detail screen shows status, folder, model, token use, cost, context use, message counts,
the session file, and the full transcript.
It updates while the agent works.
Use `↑` `↓` `pgup` `pgdn` to scroll, and `tab` to go to the next session.

## Commands

```text
/sessions                 Open the manager.
/sessions new [task]      Start an agent. With a task, it runs in the background.
/sessions list            Show the status of every live session.
/sessions switch <name>   Switch to a session.
/sessions rename <name>   Rename the current session.
/sessions stop <name>     Stop a session.
/sessions resume          Open a saved session.
```

Press `tab` after `/sessions` to complete subcommands and session names.

## Status bar

When more than one session is live, a line under the editor shows every session and its state.

## Safe parallel writes

Two live sessions cannot write the same file or folder at the same time.
The manager blocks the second write and tells the agent which session holds the path.

## How it works

Each session is a complete pi session with its own extensions, commands, model, and screen.
New agents start with the model, thinking level, and tools of the session that created them.
A session in the background keeps running, but its output stays hidden.
When you switch to it, pi redraws its screen.

## Limits

- All sessions live in one pi process. `/quit` in any session ends all of them.
  pi keeps the session files, so you can resume them later with `r`.
- You cannot stop the main session from the manager. Use `/quit`.
- pi binds `ctrl+r` to renaming, so this extension uses `alt+s`.

## Troubleshooting

Set `PI_SESSION_MANAGER_DEBUG=1` before you start pi.
The extension then writes suppressed errors to `~/.pi/agent/pi-session-manager-debug.log`.

## Development

```bash
npm install
npm run typecheck
```

pi loads the TypeScript files directly. There is no build step.

## Acknowledgments

This extension builds on [pi-parallel-sessions](https://github.com/liushihao456/pi-sessions)
by [liushihao456](https://github.com/liushihao456), under the MIT license.
That project showed how to run several pi sessions in one process and pass the terminal between them.

These parts come from pi-parallel-sessions:

- **Session runtime** (`host.ts`): the code that creates each child session with the model,
  thinking level, tools, and project trust of its parent.
- **Terminal handoff** (`host.ts`): the code that parks the main session and gives the screen to a child.
- **Path locks** (`host.ts`): the code that stops two sessions from writing the same path at once.
- **Pickers** (`pickers.ts`): the folder explorer and the saved-session picker.

This project adds the manager overlay, the detail screen, the status bar, and background agents.
It also adds the hidden terminal for background sessions, usage and context stats, notices,
and the `/sessions` subcommands.

## License

MIT. See [LICENSE](LICENSE). The license keeps the copyright notice of pi-parallel-sessions.
