import type { PlatformId } from './protocol.ts'

/**
 * The pure-data half of an app manifest: `AppMeta` and `APP_ID_PATTERN`.
 * Kept in its own component-free file because the main process reads it for
 * package layout. Conventions for other files (entry document, icons) live in
 * docs/apps/files.md.
 */

/**
 * The one and only shape of an app id — packing, registration, CLI and the
 * scaffold all import this single check. app.ts does NOT declare the id: its
 * only source is the project's package.json name (in this repo: the directory
 * name under src/apps), injected by packing into manifest.json. The id doubles
 * as the archive name (`<id>.airship`), the data dir (`~/.airship/data/<id>`),
 * the URL segment (`airship://<id>/…`) and a token in `relaunchCommand`,
 * which rules out: `#` / `?` (silently truncate the URL), `%` (validated
 * string diverges from the decoded dir name), `: < > " | * / \` (illegal in
 * Windows dir names) and whitespace (invalid URL segment). Lowercase avoids
 * case-folded collisions. Display names are unrestricted — that is what
 * `name` is for.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface AppMeta {
  /** Display name shown in the UI */
  name: string
  /** One sentence on what the app does */
  description: string
  /** Drop the runtime's default content padding (apps that control their own layout) */
  flush?: boolean
  /**
   * Window size; omit either field to take the runtime default (1100×740).
   * Layout is the app's own fact, not a runtime guess. The runtime persists
   * no window state, so edits here take effect immediately
   * (see src/runtime/specs/runtime.md SH-015 / SH-016 / SH-018).
   */
  defaultWidth?: number
  defaultHeight?: number
  /**
   * Platforms where the app works; omitted = all platforms.
   * The runtime refuses to open a window otherwise (wording: `platformIssue`
   * in src/shared/contract/errors.ts).
   */
  platforms?: PlatformId[]
}
