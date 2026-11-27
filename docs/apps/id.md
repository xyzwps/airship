## Id of An App

Every app has a unique id. We use the `name` from `package.json` as the app id.

About `AIRSHIP_APP_ID`,
1. During packing it is a transient build-time environment variable: it tells the shared vite config which app is being compiled right now.
2. Vite `define` bakes it into the bundle as the compile-time constant `import.meta.env.AIRSHIP_APP_ID` — the SDK host reads it to learn which app this window is (in-repo dev has no such baking and falls back to the document URL).
3. At runtime it is a real environment variable handed to each packaged backend process — the only identity a backend gets, alongside `AIRSHIP_DATA_DIR` / `AIRSHIP_CACHE_DIR`.
