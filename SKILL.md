---
name: fireside
description: Open and drive the Fireside browser desktop. Use when the user runs /fireside, asks to open Fireside, or is chatting from inside Fireside (FIRESIDE_CONNECTION=acp); keep its panels current while working.
---

# Fireside

Fireside shows what a terminal handles poorly: previews, media, logs, progress, and
structured results. Open a window whenever it makes something easier for the
user, or they ask for one.

## Start

Use `fireside`, falling back to `~/.claude/skills/fireside/bin/fireside.mjs` if it is not
on PATH. How you start depends on how you got here:

- **Inside Fireside's chat.** `FIRESIDE_CONNECTION=acp` is set and Fireside started you
  from its Chat window over the Agent Client Protocol. Your replies reach the user
  directly. Do not run `fireside start`. After changing Fireside's own `src/`, the
  server restarts by itself on the new code once no chat is replying (this
  turn included), and the page reloads itself. Nothing for the user to press.
  `FIRESIDE_PROJECT` points every `fireside` command at this desk whatever the
  current folder, and `fireside stop` refuses to stop it, since that would end
  this chat. For a throwaway desk, set `FIRESIDE_PROJECT=<its folder>` on each
  command.
- **Asked to open Fireside from anywhere else.** Run `fireside start` in the project
  directory. It starts the server and opens the desktop. Tell the user to choose
  an agent when the desk opens, and stop there: the desk is
  driven from its own Chat window, not from a terminal session.

The Chat window can hold several chats at once, so another agent may be working
on this project and this desk beside you. Treat the panels as shared — reuse your
own panel IDs, and leave another chat's windows alone unless the user asks.

A first-run desk opens dark: the user picks an agent, connecting lights the
fire, and the tour runs once per machine. Chat has the desk to itself, and the
tour ends by leaving "What can I do here in Fireside?" in the box for the user
to send.

## When the user asks what they can do here

This is often their first message, and your answer is their first impression of
Fireside, so make it about their project rather than about Fireside's features.

1. Take a quick look: the README, the manifest, `git status`, the top-level
   folders. A minute at most; do not read the whole project.
2. Answer in chat in two or three sentences: what you see here, and where you
   would start. Keep the list for the window, so nothing is said twice.
3. Put three to five ideas in an `actions` window, each with a short `hint`. Each
   names something real (a script, a failing test, an unfinished feature), and at
   least one changes the desk itself, such as a skin or a new window. A click
   drafts the idea in the chat box. If you are Claude or Codex, end with the Usage
   row below, which opens that window instead. It lands beside Chat:

```sh
fireside panel try-next --kind actions --title "Ideas for this project" \
  --items '[{"label":"Run the app beside our chat","hint":"Start vite and keep a live preview here","prompt":"Run this project and put the preview next to our chat."},
    {"label":"See your plan usage","hint":"How much of your limits you have used","window":"tokens"}]'
```

The window sizes itself to its rows, so leave its size alone. Do not start anything else yet:
suggest, and let them choose. Leave your own checks and the window's layout out of
the answer. In an empty folder, say so, ask what they want to make, and offer ideas
for the desk while they think.

## Keep panels useful

| Work | Panel |
|---|---|
| Long-running process | `stream` with its log file as `--source` |
| Images or short clips, side by side | `gallery` |
| A video to watch, or a playlist | `video` with `--src`: a file, a YouTube video, or a YouTube playlist link |
| Running web app | `iframe` |
| Multi-step work | `progress` |
| Result files | `files` |
| A code change | `diff`: on its own it shows uncommitted changes live; give it `git diff` output as data for a commit or branch |
| Structured findings | `markdown` |
| Choices | `actions` |
| Text to copy (a command, a message) | `html` with a Copy button |
| Ideas or options to review | `ideas`, with its content via `fireside data` |
| The user's own task list | `notepad`; it saves itself, so don't overwrite its data |

Make windows easy to read and leave the user as few steps as possible: text to
copy goes in a window with a Copy button, the next step is a `data-prompt`
button, and each thing is shown in its own form (the app, the diff, the
forecast) rather than described. See `reference/good-windows.md` before
designing an `html`, `markdown`, or `ideas` window.

Reuse panel IDs. Remove a finished panel with `fireside rm <id>` when it is no
longer useful. Aim for four to six open windows. Closing a window sends it to
the dock; do not recreate it to override the user's choice. The user can also
delete any window from the dock (activity shows "you deleted …"); do not
recreate a deleted window unless they ask for it.

`--span` and `--height` set initial sizing and the next tidy layout. Existing
window positions and sizes belong to the browser. `--collapsed` starts a new
panel in the dock. The user can resize or tidy the desktop directly.

The `chat`, `activity`, `git`, and `tokens` panels update automatically. Chat token
figures describe the observed transcript tail; the Usage window shows account-wide limits.

The **＋** at the end of the dock opens the user's own catalogue, so a fresh desk
needs no setup panel from you. Its top half puts a window up at once — the kinds
useful the moment they open (`tokens`, `git`, `activity`, `skins`, `notepad`,
`browser`, `solitaire`); a kind already on the desk comes forward rather than
arriving twice, and one the user already reaches from a shortcut icon is left out.
Its bottom half drafts a message instead, because those windows are a frame and
only the user knows what goes in: the generic kinds, a free-text box, and
whatever you suggested for this project.

```sh
fireside catalogue --suggest "A release checklist|the changelog is stale|Put an ideas window on the desk with the release steps for "
```

Suggest windows this project and this user would actually want, in the same
`Label|hint|prompt` shape; a prompt that trails off is the
point, since the user finishes it. `--clear` removes them. A window you install
joins the catalogue with `catalogue: true` in its `window.json` (it goes up at
once; add `multiple: true` if the user may want several), or with an `ask`
prompt (it drafts a message).

## Prompts

Buttons prepare editable text in the composer. The user sends it to the chat on
screen. Use `immediate: true` only for explicitly appropriate, repetitive actions
in built-in action panels. Sandboxed HTML buttons always prepare a draft.

## Content and appearance

```sh
fireside panel preview --kind html --title Preview --html @/tmp/preview.html
fireside icon repo --label Repository --glyph gh --url https://example.com/repo
fireside icon progress --label Progress --window progress
fireside skin midnight
```

HTML panels run in sandboxed frames with inherited CSS variables. Scripts can
render interactive content. `<button data-prompt="…">` prepares a prompt in the
composer. Relative media links resolve against the project. Use the normal
browser for previews requiring cookies or origin storage.

Shortcut icons sit in the menu bar. The **＋** after them drafts a request
like "Add a shortcut to the top bar that opens …"; make it with `fireside icon`.
Icons support app/command launchers, URLs, prompts, and panel links. Use `--app`
for a macOS app and its native icon, `--exec` for quoted command arguments,
or `--cmd` for a JSON argument array. The browser submits only the icon ID; the
server reads its command from disk and launches it without a shell. A window
that runs commands of its own (a switch, a refresh) lists them under `commands`
in its `window.json` and calls `ctx.run(panelId, name)`, so no icon is needed;
see `reference/panels.md`.

For VS Code, target the current project explicitly: store `cmd: ["code",
"/absolute/project/directory"]` using `--cmd`, while keeping `--app` for its icon.
Resolve the directory from the project you are working on. If the user selected
a `.code-workspace` file, pass that file instead. Check that `code` is on PATH;
do not use a generic `open -a` launcher that opens whichever workspace was last used.
Skins own appearance, including light/dark mode; use `fireside skin --list` to find
one. A skin is a JSON file or a folder with its images, installed for every
project with `fireside skin install <path>`. `fireside theme --accent C` or `--vars`
sets CSS variables over any skin. `fireside windows` lists window kinds, including
ones installed with `fireside window install <folder>`.

Some windows are templates over data. Keep their content in the project, not in
the template: `fireside data ideas @ideas.json` writes `.fireside/data/ideas.json`,
points the panel at it, and redraws the window. To change the content later, run
`fireside data` again; never edit a window's code for that.

There is no build step. Edits to `client/*.css` swap in at once; edits to
`client/*.js` or `index.html` reload the page once. Edits to `src/` restart the
server by itself after your turn ends, as long as the new code loads; the page
reconnects without reloading and chats reopen. Window and skin definitions refresh live without
restarting chats. Share definitions with `fireside export
window|skin <id> --out <file.zip>` and load them with `fireside import <file.zip>`
(`--project` for this project; `--as <name>` when the name is taken; `--replace`
updates a component of yours that is already installed there). Names are unique:
nothing in `~/.fireside` or a project can replace a built-in, so to change a
built-in window or skin, edit it in Fireside's own `windows/` or `skins/`. Keep personal content outside component folders so exports contain only
reusable files. See `reference/components.md` for the component lifecycle.

For panel data, prefer CLI commands: state
mutations are serialized and validated. Never overwrite malformed state to make
an error disappear. The running server retains the last valid state until fixed.

## Adding an agent

Any program that speaks the Agent Client Protocol can be a chat agent. When the
user asks for one, point them to **Add another agent…** in the Chat window (the ACP
registry, installed for them after they confirm) or **Run a command…**. If they
want it done for them, check the program is installed and answers over ACP, then
write `~/.fireside/agents/<id>.json` (`.fireside/agents/` for this project only):

```json
{ "name": "OpenCode", "command": "opencode", "args": ["acp"] }
```

It appears in the agent menu within seconds. See `reference/acp.md` for the fields.

## Installing a shared window or skin

When the user drops a component ZIP on the desk, Fireside unpacks it into
`.fireside/inbox/` without installing it and asks you to. Shared components are
trusted code once installed: they run in the desk and can run commands. So:

1. **Look before installing.** Read `window.json`/`skin.json`, `window.js`, and
   any other scripts. Before asking anything, tell the user in a message (not
   only in your thinking) what it does in a sentence or two, and call out
   anything surprising: `commands` in `window.json`, `ctx.exec`, network
   requests, reading or writing files outside its own data. If it looks harmful,
   say so and do not install it unless they insist.
2. **Check the name.** The prompt says where a component with the same id
   already exists (`fireside windows`, `fireside skin --list` show the rest). A name
   can be used once: Fireside refuses to install a second "chat", because the desk
   would run one copy while the other is edited. If it is identical to what is
   installed (`diff -r`), say so and install nothing. If the taken name is the
   user's own component in the same place, ask whether this updates it. Otherwise
   ask the user for a new name, and suggest one.
3. **Ask where and whether to show it.** Installing goes to `~/.fireside` for every
   project; `--project` keeps it to this one. For a window, ask whether to put it
   on the desk now.
4. **Install** with `fireside import <zip>` (`--as <name>` with the new name,
   `--replace` only to update the user's own copy, `--project` if asked). Put a window up with
   `fireside panel <id> --kind <kind> --title <title>` if they want it; a skin is
   picked with `fireside skin <id>` or from the Skins window.
5. **Clean up** the inbox folder and ZIP when you are done, installed or not.

## Check what the user sees

A command that succeeded has not shown anything yet, and windows sometimes fail
to load. Every time you put up or change a window, look at it before you tell
the user it is there:

```sh
fireside shot <panel-id>        # → .fireside/shots/<panel-id>.png, plus any problems
```

`fireside shot` opens the desk in a headless browser of its own (not the user's
tabs), pictures that one window, and lists what went wrong in it: script
errors, failed requests, images or videos that did not load. Then:

- Open the PNG and look at it. Check that the content you meant is there, and
  look for blank areas, clipped text, overflow at the panel's `--span` and
  `--height`, and colours that clash with the skin.
- Fix every problem it lists, then shoot again. A preview whose server is not
  up yet shows as a failed request; start it first.
- It uses the default layout, so it confirms the window draws, not where the
  user has moved it. With no Chrome, Chromium, or Edge (or `FIRESIDE_BROWSER`),
  fall back to reading the window back with `fireside state`, checking its paths
  exist and its URLs answer (`curl -sI`), and reading any HTML for broken markup.

If you could not verify something, say so rather than claiming it looks right.
When the user reports that a panel looks wrong, fix what they reported. Do not
recreate the panel from scratch.

See `reference/panels.md` for schemas and `fireside --help` for CLI flags.
