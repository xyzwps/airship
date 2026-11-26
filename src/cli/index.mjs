/**
 * `@airship/cli` 的门面：库用法（`code/pack-app.mjs` 这类仓内调用方）只从这里取，
 * 命令行看 bin/airship.mjs。
 */

export { packPackage, collectEntries, renameWithRetry } from './lib/pack.mjs'
export { installerScript, nsisText, buildInstaller, extractWindowsIcon, findMakensis, readArchiveManifest } from './lib/installer.mjs'
export { readAppManifest, findAppManifestFile, installedSdkVersion } from './lib/manifest.mjs'
export { findRuntime, RUNTIME_EXE } from './lib/runtime.mjs'
export { locateApp, buildAndPack, compileBackend, copyIcons, runDev, runStart } from './lib/app-pipeline.mjs'
