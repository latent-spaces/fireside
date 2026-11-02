# ACP chat

Browser → existing HTTP/SSE server → ChatTabs → AcpChat → local ACP adapter over stdio.

`src/acp.mjs` owns adapter processes, initialization, session creation/loading,
streamed messages, advertised commands, cancellation, and pending permissions.
It uses the official ACP TypeScript SDK. No custom per-provider message protocol
or model/tool loop is implemented.

## Agents

`src/agents.mjs` decides which agents exist. Each is a JSON file, found in the same
layers as windows and skins: `agents/` (Claude and Codex, built in),
`~/.fireside/agents` (the user's own) and the project's `.fireside/agents`. As with
windows and skins, each name is used once: a later file with a taken name is
skipped, so a cloned repository cannot change what "Claude" runs.

```json
{ "name": "Gemini CLI", "npm": "@google/gemini-cli", "args": ["--acp"] }
{ "name": "OpenCode", "command": "opencode", "args": ["acp"] }
```

`npm` runs a package's bin, resolved from the folder beside the file (`<id>/`, or
Fireside's own `node_modules` for a built-in); the exact version is pinned in that
folder's `package.json`. `command` runs a program on PATH, or under `<id>/` when it
starts with `./`. Optional fields: `args`, `env`, `about`, `link`, `icon` (an SVG
beside the file), `signIn` (the command that signs in, shown when the agent needs
it; without one the chat points to `link`), and `from` (where it came from, used
by updates).

The ACP registry is read only when the user opens **More agents…**, and once more
to install the picked entry. Picking one writes a file like the above: npm entries
are installed into `~/.fireside/agents/<id>/`, binary entries are downloaded, checked
against the registry's sha256 when it gives one, and unpacked there (or, when the
program is already on PATH, the user's own copy is used), and uvx entries pin their
version in the command. After that nothing reads the registry except the daily
update check, so a registry outage or format change cannot stop a working agent.
**Run a command…** starts the typed program (split into words, no shell), keeps it
only if it completes the ACP `initialize` handshake, and names it after the
`agentInfo` it reports.

Every agent gets the same connection. The desk instructions ride in a hidden
primer ahead of the first message; only Claude takes them as a system prompt
extension instead. Sign-in buttons are drawn from the agent's own `authMethods`
(agent-handled methods without `_meta`).

A session does not prove a login: Codex refuses one signed out, but Claude opens
one and only refuses the first message. So a chat asks for sign-in on ACP's
`authRequired` error from any call, or when `_auth/status_update` reports `none`,
and an agent that declares that extension is not called ready until its first
report arrives or six seconds pass. Terminal auth methods are not used; the chat
and the first-run screen say which command to run.

Every failure goes through `AcpChat.halt`, so they all look the same. A chat with a
conversation stays on it, asleep, with the error beside the thread: sending or
Reconnect restarts the agent. A chat with nothing to keep goes back to the agent picker.
A lost sign-in is one of these failures, plus the command that fixes it. A message
refused for sign-in was never delivered, so it stays queued and goes out once the
chat is back.

Codex's question-form quirks and the
Usage window's plan limits stay specific to those two agents.

`src/updates.mjs` watches every agent in the built-in and user layers that Fireside
installed: npm agents against npm's `latest`, uvx agents against PyPI, downloaded
binaries against the version the registry now lists.

`src/chat-routes.ts` exposes `/api/agent/connect`, `/clear`, `/stop`, `/permission`,
`/authenticate`, and `/disconnect` under the existing host/origin/request-header
guard. Long operations return 202 and report progress/errors over SSE. Session
IDs accompany messages and approvals to reject stale browser tabs.

`windows/chat/agent-controls.js` adds agent selection, connection setup, a fresh-session
button, stop, previous sessions, advertised commands, and permission choices.
Existing chat rendering receives coalesced ACP updates; user drafts stay intact.

`src/chats.mjs` holds one AcpChat per chat tab, so several agents can be open
at once on the same project. One tab is active: the chat the window shows, and the
context-token count the chat shows. The others keep streaming in the background;
every tab's agent may change the desk, since the panels are shared. Only a
background tab's summary is broadcast (`tabs`), while the active chat's thread rides the existing `acp`
event. `/api/agent/open`, `/select` and `/close` manage the strip; every other
agent action names its tab, and session operations are tracked per tab.

Saved conversations belong to the desk, not to a tab, so `acp.json` is written by
ChatTabs alone: one `sessions` list, plus each tab's id and the conversation it
should reopen. A file written before tabs, carrying a single `preferred`, becomes
one tab. Tabs and the active one are restored on start, as a single chat was.

Each tab also journals its pending messages to `acp.json`.
Acceptance is saved before it is acknowledged, and delivery intent is saved
before calling the agent. Pending work is separate from the 400-row display
history and is never trimmed with it. A failed write rejects acceptance or leaves
the message queued, rather than pretending it was delivered.

A message that was sent counts as sent, however its turn ended. ACP has no receipt,
so Fireside cannot tell how far a failed turn got. It shows the error, never replays
the message by itself, and leaves the user to send it again if the thread shows it
didn't finish. Messages queued behind a failed one wait for the user's next send, so
they don't run on top of unfinished work. Only `authRequired` is certain to have done
nothing: that message stays queued and goes out after sign-in.

After a restart, unsent messages remain queued for the same conversation until
the user sends another message. One that was on its way counts as sent, and the chat
says the last reply was cut off.
Request deduplication stays in memory. Pending IDs are recovered from the saved
queue; completed request IDs do not survive a server restart.
The pending queue must be resolved before changing providers, starting a new
session, or disconnecting. Closing a blocked tab offers an explicit force-close
confirmation: it stops the adapter and discards pending messages, even when the
session ID has drifted. The close control also appears on the last blocked tab.
Normal server shutdown retains pending work for recovery.
This protects process restarts; it is not an exactly-once guarantee from the
provider, nor a filesystem power-loss guarantee.

Credentials remain in the agent's normal login store or server environment.
Raw adapter stderr is drained but not sent to the browser. Only fixed packaged
adapter executables can be selected through HTTP. We advertise no client-side
filesystem or terminal capabilities; agents use their native tools and permissions.

Clear cancels the active prompt, rejects unresolved permissions, and calls
`session/new`. It does not delete the old transcript. Resume checks `loadSession`
before invoking `session/load` and accepts its replay. Stop bounds both the cancel
notification and the active turn to ten seconds; on failure it closes the adapter
process and fences late events. A conversation joins the
resume list with its first sent message, since agents only save it then; one the
agent reports as not found is dropped from the list. Server startup attempts to
restore saved conversations. Restoring a session
does not itself submit the saved queue.

Scope and known limitations are documented in README.md. Both installed adapters
were additionally verified to initialize and create sessions locally, and both
returned real replies through the browser. Claude fresh-session reset was checked
in the UI; Codex session loading was checked after a server restart.

Adapter children inherit a PATH that selects this checkout’s Fireside CLI.
`FIRESIDE_CONNECTION=acp` stops an agent from restarting the server under itself.

Tool calls retain partial ACP updates for content, raw input/output and locations.
The chat populates diagnostics only when expanded, with at most 24 sections
and 4,000 characters per section (plus a truncation notice). Before/after diff
content is included;
failed tools are explicitly marked failed in both the chat and activity feed.
Provider content is rendered as text, not active HTML. Binary attachments are
identified but not previewed. History after reconnect is supplied by agent replay.

If a still-open browser page detects that its localhost address now serves another
project, it pauses actions and layout writes and asks the user to copy unsaved
text and reload. It does not migrate the old project's drafts into the new one.


## Agent diagnostics

The server records agent lifecycle events in `.fireside/agent-events.jsonl`,
rotated at 1 MiB with one previous file (`.1`). It includes timestamps, tab,
session and prompt IDs, agent PID and version, model, prompt duration, concurrent
turn counts, disconnects, and error/retry signals received over ACP. It never
logs prompts, tool output, raw stderr, credentials, or provider error bodies.
Error fingerprints allow correlation without retaining arbitrary error text.
`retryLimitReported` records the agent's label; it does not count retry attempts.

Watch it with `tail -f .fireside/agent-events.jsonl`, or put it in a stream window.
These events describe the ACP boundary, not individual HTTP attempts inside an
agent. A completed ACP prompt can still carry an agent error; the finish event
records that separately. Retries hidden by an adapter are not observable here.
