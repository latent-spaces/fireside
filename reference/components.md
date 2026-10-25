# Local components

A window is a folder containing `window.json`, `window.js`, optional
`window.css`, and its assets or supporting modules. A skin is a folder containing
`skin.json` and assets, or a standalone JSON definition. Components are trusted
local code and windows share the desktop's state through their context.

Built-in, user, and project definitions use the same format. Each name is used
once: built-in first, then `~/.fireside`, then the project, and a later folder
with a name that is already taken is skipped (with a warning in the server log),
never swapped in. To change a built-in, change it in Fireside's `windows/` or
`skins/`; a variant of your own gets a name of its own. The window folder
name is its kind; each panel using it has a separate instance ID. Content belongs
in `.fireside/data/`, not in the reusable folder.

## Window lifecycle

`window.js` exports a default object:

```js
export default {
  // Optional: runs once when this component is loaded, even with no open instances.
  setup(ctx) {
    ctx.provide('my-command', () => { /* shared action */ });
    ctx.subscribe('activity', row => { /* shared live news */ });
    // Commands and subscriptions are automatically removed on reload.
    return { async prepareReload() { /* save component-wide drafts */ } };
  },
  render(panel, ctx) {
    const root = ctx.el('div');
    root.textContent = panel.data?.message || 'Hello';
    // ctx.store contains shared desk feeds; ctx.save(id, data) saves instance data.
    // Register cleanup when attaching global listeners, subscriptions, or timers.
    const onResize = () => { /* update this view */ };
    addEventListener('resize', onResize);
    ctx.onDispose(() => removeEventListener('resize', onResize));
    return root;
  },
  // Optional: save pending edits before replacing this component's code.
  async prepareReload(root, panel, ctx) {},
  // Optional: respond when the user closes or deletes this instance.
  beforeClose(root, panel, ctx) {},
  // Optional: release resources when a rendered instance is removed or replaced.
  dispose(root, panel, ctx) {},
  // Optional: the sketch the ＋ menu draws inside a mock frame of this window,
  // as an HTML string using the shared .mk-* shapes (see client/app.css).
  // Without one, the menu shows the window's icon.
  preview: () => '<i class="mk-l mk-h"></i><i class="mk-l"></i>',
  // Existing update(root, news, panel, ctx) and manifest feeds remain supported.
};
```

Every trusted window can use `ctx.save` and the shared JSON request helper
`ctx.request(route, payload)`. Existing helpers such as
`el`, `esc`, `md`, `fileURL`, `actionRow`, `chooseSkin`, `send`, and project-scoped
`recovery` remain available. `ctx.store` provides shared desk state and live feeds;
there is no per-window permission system.

`setup` and `render` contexts both provide `onDispose`, `provide(name, action)`,
`command(name, ...args)`, and `subscribe(feed, callback)`. Commands and subscriptions
belong to the registering scope and are cleaned up automatically. `ctx.notice`
shows an error or short message. `ctx.onDrag` provides the shared drag lifecycle;
register its returned cleanup through `onDispose`. `ctx.slots.tray` is a DOM mount
point for component controls; remove mounted nodes through `onDispose`.

The built-in chat uses `setup` to supply shared `arm`, `send`, `focusComposer`, and
`rescueDraft` commands and mount its tray input. Its ZIP includes its controls,
draft helper, and styles; it has no imports from private shell modules.

Instances may set `reopenToken` to reopen when a new token arrives and
`deletable: false` to omit the dock's delete action.

Fireside watches component folders in normal desks and development. Updated module
URLs carry a revision in their path, so relative imports and assets refresh too.
Changes replace affected window renderers in place, preserving window positions
and unrelated windows. Skins reload and reapply to the shell.

An editable component should save draft text through `ctx.recovery` as it changes
and finish outstanding project saves in `prepareReload`. Throwing from that hook
pauses refresh and shows a retry button. Fireside does not automatically serialize
arbitrary component state. The built-in notepad demonstrates this contract.

## ZIP format

```text
component.json       package format, type, ID, version, Fireside interface version
window.json          or skin.json
window.js            window only
window.css           optional
assets/...           bundled assets and supporting modules
```

Example `component.json`:

```json
{ "format": 1, "type": "window", "id": "notepad", "version": "1", "fireside": 1 }
```

`fireside export window|skin <id> --out <file.zip>` packages the resolved component
folder. Standalone skin JSON becomes `skin.json`. `.git`, `.fireside`, and
`node_modules` are excluded. Symlinked assets must be bundled as actual files.
User content is not collected; anything deliberately put inside the reusable
folder is part of the package. Linked remote assets remain links.

`fireside import <file.zip> [--as <name>] [--project] [--replace]` validates the
format and files, then installs the folder. It does not execute installation
scripts. A name already used elsewhere is refused; `--as` installs the component
under a new one. `--replace` only updates a component already installed in the
same place, and does not alter instance data. Component authors must preserve
their data format or explicitly migrate it when changing versions; automatic
data migrations are not implemented.
