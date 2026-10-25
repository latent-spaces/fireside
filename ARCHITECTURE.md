# Fireside design principles

Fireside is a small, stable desktop that hosts flexible, live, shareable components. Separate desktop code, component definitions, and user data for maintenance and sharing. Components are trusted code and can work together freely; these are organizational boundaries, not security walls between windows.

The shell composes desktop geometry, skins, component loading, storage, and one
live connection. Every window—including chat—lives in `windows/` and
uses the same lifecycle. Chat owns its input, controls, drafts, transcript, and
styles; agent processes remain a shared host service. Built-in components export
and import through the same ZIP format as user-created ones.

**Local-first assumption:** Fireside runs on the user's own machine. The shell, components, and project data belong to that user, and installed components are trusted. Do not introduce tenant isolation, per-component permissions, or security walls between windows. External agent providers and remote content may still use the network; preserve their existing behavior.

## Three boundaries

| Layer | Owns | Example |
| --- | --- | --- |
| **Fireside** | Desktop layout, component loading, saving, live updates, and shared host services | Opening and positioning a notes window |
| **Component** | Reusable behavior, appearance, bundled assets, settings definitions, and starter content | The notes editor, its styles, and an empty-note template |
| **User data** | Each window's content and settings, layouts, drafts, conversations, credentials, and project files | What you wrote in each note |

**A component is the template; an instance is your use of it.** Two notes windows can use the same component while keeping separate content. Changing the component updates both editors; it does not replace either note.

## Rules that keep it simple

1. **Components use a simple shared Fireside interface.** They can read the desk's shared state, use live feeds, save content, prepare prompts, and interact with other windows. This keeps them independent of the shell's implementation without adding permission layers.
2. **Fireside provides common saving.** Each instance has a default place for its content, and components can deliberately share data. This avoids mixing content into reusable code; it does not restrict access between windows.
3. **Editing a component and editing its content are separate actions.** Appearance and behavior live in the component folder; notes and settings live in the user's project. Built-in and imported components follow the same contract.
4. **Live refresh is normal operation.** Creating or editing a component updates the running desk, including installed use. Refresh saves pending edits, releases the old component's listeners, and reloads the affected instances. It does not restart working chats.
5. **Updates preserve identity and data.** Components have a stable ID and version; instances have separate IDs. Data-format changes require an explicit migration. An incompatible update shows an error and leaves the user's data untouched.
6. **Report component errors directly.** Catch loading and rendering failures and show the error in the affected window. Do not silently substitute another window type. Trusted components share the page, so this is ordinary error handling, not a guarantee of isolation.

## Sharing

Export a component as a ZIP containing its definition, code, styles, assets, and explicitly bundled dependencies. Its manifest declares its ID, version, and supported Fireside interface. Export packages the component folder rather than collecting the data it can access. Personal content is excluded by default; the user can deliberately include selected example content.

Import unpacks and validates the component, checks compatibility, and makes it available in the catalogue. It does not run installation scripts. An existing component with the same ID is an explicit update or a new copy, never a silent overwrite. Installed components can be edited locally; importing an update must not overwrite those edits without a choice.

Sharing a whole desk later can reuse the same model: component packages plus a layout and explicitly selected content, with credentials and conversations excluded by default.

Keep the current model of trusted components running in the desktop page with access to shared state. No per-window sandbox, capability permission system, or message bridge is required. The useful separation is on disk and in export: reusable component files stay separate from user content. Preserve the existing sandbox for HTML/iframe previews, which is a different feature.

## Lean implementation

Use one catalogue for windows and skins, one data-saving path for both the CLI and
components, and one replacement path for folder installs, ZIP imports, and builds.
API methods and JSON parsing belong in the request dispatcher. Live feeds share
one scheduler, which stops when nothing needs it. Chat changes and reconnects use
one snapshot shape; the browser uses one request helper, one refresh queue, and
one drag lifecycle for windows, icons, resizing, and tab scrolling. Reapply a skin
only when its definition or theme changes; a window edit should leave it alone. Keep the first run simple; do not
scan a project in the background to generate suggestions. An agent looks when the user asks it to.

## Technical direction

Use a TypeScript local server that Node runs directly, and serve the shell through Vite in every desk. There is no build step: Vite serves the shell, and Fireside's own stream says when it changed: its CSS is swapped in place, its scripts reload the page once, and nothing else does. Component edits arrive through Fireside's own refresh, and server edits through an automatic restart that waits until no chat is replying and the new code loads; the page reconnects to it without reloading. Keep JSON storage and the existing features.

The result should be a desktop that rarely needs to change, with components users can create, edit, refresh, and share without mixing in their private data.

## Code map

- `client/app.js`: shell assembly, shared context, chrome, and refresh coordination.
- `client/desktop.js`: windows, geometry, dock, and desktop icons.
- `client/runtime.js`: shared commands, feeds, and automatic lifecycle cleanup.
- `client/live.js`: the single live connection.
- `windows/<kind>/`: all window behavior, styles, and bundled modules.
- `src/server.ts`: host composition; `routes.ts` and `chat-routes.ts`: HTTP services.
- `.fireside/`: user state, layout, data, drafts, and conversation records.

Existing workspace files keep their formats. The desktop uses generic reopening
and deletion properties rather than identifying special window kinds.
