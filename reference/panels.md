# Fireside reference

## State

`.fireside/state.json` contains the authored desktop document:

```json
{
  "version": 1,
  "title": "My project",
  "theme": { "skin": "fireside", "vars": {} },
  "status": { "text": "ready", "tone": "idle" },
  "icons": [],
  "panels": []
}
```

`project` is derived from the project directory. Panel IDs must be unique,
nonempty strings. Runtime chat status takes
precedence over the authored fallback status. CLI mutations serialize the whole
read/modify/write transaction. Hand edits are watched but do not acquire that
lock; coordinate them with other writers.

## Window fields

| Field | Meaning |
|---|---|
| `id` | Stable identity; reuse to update a window |
| `kind` | One of the panel kinds below |
| `title`, `tag`, `note` | Title, short title-bar tag, footer note |
| `order` | Sorting order; new panels default to the next multiple of 10 |
| `span` | Initial/tidy width in twelfths; default 6 |
| `height` | Initial/tidy natural height in pixels |
| `collapsed` | A new window starts in the dock |
| `data` | Inline JSON, or a `.json` file name in `.fireside/data/`, for windows that are a template over data |

A file named by `data` is read in by the server: the window gets its contents as
`panel.data`, or `panel.dataError` when it is missing or not valid JSON, and a
change to the file redraws the window. `fireside data <panel-id> @file.json` (or
`-` for stdin) writes the panel's file (`data`'s name, else `<panel-id>.json`)
atomically and points the panel at it. Data files are kept when a window is
deleted and are not served under `/files/`.

Positions, sizes, closed state, stacking order (`z`, higher in front), and
`pinned` (the title bar's pin keeps a window above every unpinned one) live in browser storage under
`fireside-geo:<absolute-project-path>`. Tabs on the same origin synchronize through
storage events. Different ports have independent browser storage. Resizing a
panel definition does not override an existing user layout; tidy uses the new
sizing. Tidy leaves pinned windows where they are and arranges the rest in the
work area above the tray; a window can still be dragged down behind the tray. Icons are shortcuts in the menu bar: as many as fit, the rest behind ⋯. Windows cascade when the desktop has no free space. Minimum window sizes
can exceed the available screen area; keep the number of open panels small.

## Panel kinds

Each kind is a folder named after it (built in under `windows/`, or installed; see Skins below):
`window.json` (`icon`, `title`, `description`, `catalogue`, `ask`, `height`, `width`, `aloneWidth`, `fill`, `feeds`, `commands`), `window.js`, whose default
export has `render(panel, ctx)` and optionally `update(root, news, panel, ctx)`,
and an optional `window.css`. `feeds` names the live data the window follows
(`git`, `usage`, `subscriptions`, `lines`, `activity`, `theme`): news goes to `update` when the
window has one, otherwise the window redraws. The server polls git and tails
logs only for panels whose window follows `git` or `lines`. Windows read live
data from `ctx.store`. A window may write its own data file
with `ctx.save(panelId, data)` (`POST /api/panel/data {id, data}`, guarded like
panel delete), and `ctx.send(prompt, label)` sends a prompt at once from a button
the user pressed. `commands` maps names to argument arrays
(`{"status": ["node", ".fireside/scripts/site.mjs", "status"]}`) that the window runs
with `ctx.run(panelId, name)`, with no icon on the desk: the browser sends only the
window id and the name to `POST /api/window/command`, the server reads the command
from the manifest on disk, runs it in the project without a shell, and answers once
it exits (25s at most; a failure carries its last stderr line). One window's
commands run one at a time. A command that changes what the window shows should
write the window's data with `fireside data`, which redraws it. For anything else, `ctx.exec(cmd, {cwd, timeout})` runs any
command (an argument list, no shell; `cwd` relative to the project) and resolves
with `{code, stdout, stderr}`: windows are trusted local code. A kind whose height depends on its content may export `heightFor(panel)`, used when the panel sets no `height`. `chat` uses the same component folders and loader as every other
window. See [component lifecycle](components.md) for setup, commands, cleanup,
and live refresh.

The **＋** at the end of the dock opens the catalogue, where the user adds a
window without asking the agent. A kind with `catalogue: true` goes up at once:
say it only for a window that is useful the moment it opens with no panel
properties set — `feeds` is not that test, since `stream` feeds on lines yet
needs a `source` the agent supplies. The browser sends only the kind to
`POST /api/panel/add` (guarded like panel delete) and the server builds the panel
from the manifest, so the desktop never composes a panel of its own. A kind
already on the desk comes forward instead of arriving twice, and a kind the user
reaches from a `window` icon is left out of the catalogue entirely — unless it
says `multiple: true` (Browser does), in which case every click adds a fresh one.

All entries share one grid, sorted by title, each drawn as a mock of the window
from its component's `preview`; the ones that draft a message carry a ✎.

A kind with an `ask` string is a frame with no content of its own, so the
catalogue drafts that prompt in the composer rather than creating a panel; the
user completes it and sends it, and the agent builds the window. `state.suggestions`
(`{label, hint, prompt}`, written with `fireside catalogue --suggest`) draft the same
way, above the generic kinds, and a free-text box drafts whatever the user types.
Every catalogue entry carries a `title` and a one-line `description`.

| Kind | Content |
|---|---|
| `markdown` | `body`: Markdown text; headings, paragraphs, lists, quotes, tables, fenced code, links. Or `source`: a Markdown file in the project, read again every few seconds while in view, so the window follows its edits |
| `diff` | With no data, the project's uncommitted changes (tracked and new files), read again every few seconds while in view; `source` names a repository below the project, `base` a commit or branch to compare against (default `HEAD`). With data `{diff, title?, note?}` (`git diff` output, written with `fireside data <id> @diff.json`), that diff instead. File by file with line numbers, changed words marked, unified or side by side, a file filter and an Explain button per file; clicking line numbers (shift-click or drag for a range) drafts a question quoting those lines |
| `html` | `html`: inline HTML, or `file`: filename under `.fireside/panels/`, read again every few seconds while in view, so the window follows its edits; the frame redraws only when the file changed |
| `gallery` | `items`: `{src, caption}` images or videos. One fills the window, two sit side by side (a before and after), more wrap into rows that keep each picture's shape; a click opens a viewer that steps through them with ← and →. A picture that does not load says why (not found, private folder) in its place |
| `video` | `src`: one video, or `items`: `{src, caption, poster}` for a playlist that plays through. A project path or a direct link plays in a `<video>` (the place you stopped is remembered in that browser); a YouTube or Vimeo link plays in the site's embed, and a YouTube link with `list=`, or a `youtube.com/playlist` link, plays the whole list. The video and second you reached on YouTube are remembered in that browser too. `loop` repeats a single video |
| `files` | `items`: `{path, label, note}` file links |
| `stream` | `source`: log path, or lines from `fireside push <id>` |
| `progress` | `steps`: `{label, state, note}`; state is `todo`, `active`, or `done`; optional `value`, `max` |
| `stat` | `items`: `{label, value, delta}` |
| `actions` | `items`: action objects below |
| `browser` | `url`: start page. An address bar with back, forward and reload; the last address is remembered in that browser. Pages may show their own dialogs (alert, confirm, "leave this page?"); one blocks the whole desk until answered, so `dialogs: false` turns them off for a preview that shouldn't interrupt. Sites that refuse framing show a notice with a button to open them in a tab (`POST /api/frame-check` reads their headers) |
| `iframe` | `url`: preview URL; sandboxed. A page on the desk's own origin gets no origin storage; a page from another site keeps its origin, so embeds like YouTube play |
| `chat` | Owning session's transcript, context-token count, and reply composer |
| `activity` | Hook events, most recent first |
| `git` | Branch, changed files, recent commits; `source` names a repository folder below the project (default: the project itself) |
| `tokens` | Claude and Codex plan limits (read every five minutes or on Refresh); each idle five-hour window offers a low-cost-model wake-up action (Haiku for Claude); shown as **Usage** in the catalogue |
| `skins` | Available skin picker |
| `solitaire` | Local game, loaded when opened |
| `ideas` | `data`: `{review, sections: [{label, lede, ideas: [{title, text, why, size, impact}]}]}`; tabs of idea cards whose Review button prepares `review` with `{idea}` filled in |
| `notepad` | `data`: `{prompt?, items: [{id, text, at, sent?}]}`, saved by the window itself; jot small tasks, edit them in place, and Send one (or all) to Claude; `prompt` wraps each with `{task}` |

HTML runs in a sandbox with scripts enabled. It inherits theme variables when
rendered. Buttons with `data-prompt` prepare text in the parent composer through
a constrained message bridge. They do not send automatically. File links and
media resolve against the project; project-file serving answers byte ranges, checks real paths and
blocks private Fireside descriptors. Inside `.fireside/` only `panels/`, `skins/assets/`, `icons/`, `shots/`, `media/` and `images/` (pictures pasted into a chat) are served. Files outside the project are not served: `fireside panel` copies a gallery or video file from elsewhere into `.fireside/media/` and points the panel there, and it reports a file that does not exist or sits in a private part of `.fireside/`. A query such as `?v=2` is kept on file links.

Logs retain 500 lines in the server and browser, capped at 16,000 characters per line. Reads are bounded, preserve
partial UTF-8 lines, and reset on file rotation. Chat seeds from the last 2 MB,
shows the last 120 parsed messages initially, and retains up to 400 messages.
Usage describes observed messages, not the full history of a truncated session.

## Actions and icons

```json
{"label":"Show changes","prompt":"Explain the current diff","tone":"primary"}
```

Actions support `label`, `prompt`, `tone` (`primary` or `danger`), `disabled`
(reason string), `immediate` (default false), `window`, and `hint`. An item with
`window` (a window kind) opens that window instead of drafting a prompt. Give any
item a `hint` and the window draws full rows that share its height, instead of
small buttons.

Icons support `id`, `label`, `glyph`, `color`, optional `image` (a project path or URL,
set with `--image`), and one of:

- `kind: "exec"`, `cmd`: nonempty string argument array, e.g. `["open", "-a", "Safari"]`
- `kind: "url"`, `url`
- `kind: "prompt"`, `prompt`
- `kind: "window"`, `panel`

Any window can be deleted from the dock, open or closed: hovering its name
shows 🗑 above it, and a second click within 3 seconds confirms. `POST /api/panel/delete` requires the desktop
origin and request header and accepts only `{ "id" }`. It removes the panel,
and its layout entry. `window` icons that open it stay and keep its definition as
`restore`; clicking one puts the window back (`POST /api/icon/restore`). Panel files under
`.fireside/panels/` are kept.

Executable icons are preserved and validated. `/api/icon` requires POST, a local
desktop Origin and request header, and an existing icon ID as its only input.
Commands are read from the state file; the browser cannot replace that file or
supply executable arguments. The process launches without a shell. `--app`
extracts the native macOS icon, `--exec` parses quoted arguments, and `--cmd`
accepts an explicit JSON array.

## Skins

Skins come from `skins/` (built in), `~/.fireside/skins/` (installed with
`fireside skin install`), then `.fireside/skins/` (this project); the same id in a
later one wins. A skin is `<id>.json`, or a folder `<id>/` with `skin.json` and
its images. An asset with `file` (a path inside the folder) is served from the
skin; an asset with `url` is fetched and cached. Skins are trusted local
configuration. `theme.vars` in the state (`fireside theme --accent C`, `--vars`,
`--reset`) sets CSS variables over whichever skin is on.

Window kinds come from the same three places: `windows/`, `~/.fireside/windows/`
(`fireside window install <folder>`), then `.fireside/windows/`. `fireside windows`
lists every kind and where it comes from. Installed windows run in the page.

```json
{
  "id": "night",
  "name": "Night",
  "base": "dark",
  "vars": { "--accent": "#7aa2f7" },
  "assets": [{ "id": "bg", "url": "https://example.com/art.png", "credit": "Artist" }],
  "wallpaper": "url('{{asset:bg}}')"
}
```

Optional fields: `fontHref`, `css`, `scene`, `sceneStyle`, `credit`, `note`,
`tint: {from, span}`. Artwork must have an image content type and is limited to
12 MB while downloading. An asset with `referer` sends that page as the Referer, for
sites that only serve images to their own pages. A page attempts each selected skin's missing assets
once; reload to retry. Downloads are stored under `.fireside/skins/assets/`.

## Delivery

Prompts from the desk go to the chat on screen, over ACP; see `acp.md` for how
pending messages are kept. Browser retries reuse their submission ID to avoid
sending the same submission twice.

`/api/push` requires a private descriptor token. Browser mutations require
a local origin when supplied and a Fireside request header. HTTP state replacement and
terminal typing are not supported. App launching uses the restricted `/api/icon`
endpoint described above.
