# @airship/contract

The contract layer between the airship runtime and its apps: manifest types,
rejection wordings, and the single set of rules for registration and package layout.

Types, constants and pure functions only — it imports nothing. The packing pipeline,
runtime registration and the app installer call the **same functions**, so whether a
package is valid has exactly one answer across the whole chain.

## For app authors

The app manifest (`src/app.ts`) takes its types from here:

```ts
import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  name: 'My Todo',
  description: 'One sentence on what this app does'
}
```

The manifest does NOT declare `id`: its only source is the project `package.json`
`name`, injected into `manifest.json` at packing time.

Key exports:

- `AppMeta` — the manifest shape; the remaining gates are the grants path table
  and the identity check;
- `APP_ID_PATTERN` — id rules (1–32 chars, lowercase letter first, then lowercase
  letters, digits, hyphens);
- `packageRules` — rules for the package (zip archive `<id>.airship`);
- rejection wordings — every refusal sentence has one source, too.

You usually get it through the skeleton created by `npx create-airship-app`.
