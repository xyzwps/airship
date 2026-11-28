# App Directory File Conventions

What an app directory contains is pure **file-name convention** — no config file maps anything, and a missing required file fails the pack loudly.
The runtime artifact carries no app code, and the runtime injects no DOM into app windows: everything a window can touch lives in `@airship/contract` and the SDK — only then does a package fit into someone else's runtime.

## The conventional files

| File | Role | After packing |
| --- | --- | --- |
| `app.ts` | Pure-data manifest `app: AppMeta` (no `id` — see below) | Package root `manifest.json` (with `id` injected from the project's `package.json` name, plus `schemaVersion` / `sdkVersion` / `entry`) |
| `index.html` | Entry document: just `<div id="root">` and `./main.tsx` | Package root `index.html`, i.e. `airship://<id>/index.html` |
| `main.tsx` | One line: `createAirshipApp({ meta, component, icon })` | Built into the bundle |
| `icon.png` / `icon.ico` | Icons, by file-name convention | See [icons.md](icons.md) |
| `backend.ts` | Optional: packaged background process | Bundled into package root `backend.js` |

An app = **one self-contained document** (renderer process) + **one bridge** (runtime main process) + **optionally one packaged Node background process**.

## `app.ts`: the manifest

Pure data (`app: AppMeta`). Packing writes it as the package root `manifest.json`, injecting `id` and adding `schemaVersion` / `sdkVersion` / `entry`.
`app.ts` never declares `id`: its only source is the project's `package.json` `name` (in this repo: the app directory name) — writing it twice is a chance to get it wrong.

## `index.html`: the entry document

Just `<div id="root">` and a `./main.tsx` reference; all paths relative. Never write a CSP in it — `src/sdk/cspPlugin.ts` injects one at build time, and a hand-written one is a hard error.

How the window loads it (`airship://<id>/<entry>`, `no-store`, the dev-side `AIRSHIP_DEV_URL`) is runtime behavior — see [../architecture.md](../architecture.md).

## `main.tsx`: the wiring

One line: `createAirshipApp({ meta, component, icon })`. The host pieces live in the SDK: it mounts the host from `src/sdk/host.tsx` into `#root` — title bar, theme application, the `flush` spacing, loading placeholder — identical for every app, so authors never draw them.

## `icon.png` / `icon.ico`: the icons

See [icons.md](icons.md).

## `backend.ts`: the optional background process

A window can neither reach the network nor touch disk (CSP `connect-src 'self' ipc:`), so anything external — network services, this machine's CLI programs, large streams, long tasks — goes through a Node process packaged with the app. It exists only if the archive root has `backend.js`; in the source directory, `backend.ts` or `backend.js` must appear in exactly one place, bundled by packing into that single file. Locating a tool on this machine (env var, `PATH`, known install dirs) is the app's own knowledge, not the runtime's: the runtime knows no tool by name.

What an author must honor:

- Reply `{ ready: true }` as the first act after start; then answer `{ seq, method, payload }` requests with `{ seq, ok, value | error }`, and push events as `{ event: true, method, payload }`. Timeouts: 10s readiness, 30s per reply — so a long task replies at once and streams back through events instead of holding the reply open.
- Receive config only via `AIRSHIP_APP_ID` / `AIRSHIP_DATA_DIR` / `AIRSHIP_CACHE_DIR`; write data only inside those two directories.
- Reap what you spawn. Closing the window terminates the backend process, and on Windows that does not carry the backend's own children with it — a spawned CLI keeps running unless the backend stops it (`SIGTERM`/`SIGKILL` handler plus an exit hook).

Lifecycle (spawn on window open, teardown on close, crash-isolated) and where the bundle lands at runtime are the runtime's business, not the author's contract.

## The bridge: runtime main process (shared by all apps)

Not a file in the app directory, but the bridge itself is the whole outward face: the renderer reaches the system only through `window.airship`, injected by preload. settings, log, tray and notify are base functions, open to every app — the renderer has no sandbox, so a declared permission bitmap could never stop anyone determined to bypass it. What still gates: the identity check (the main process re-derives your app from `event.sender`). Refusals come back in plain Chinese wording, not Electron internals; events are delivered only to their owning window — dropped if the app isn't open, never broadcast.

On top of that gate, `fs` must also pass a path table: anything inside the app's own data directory is read/write by nature; outside it, only paths the user explicitly picked via a system dialog during this session.
