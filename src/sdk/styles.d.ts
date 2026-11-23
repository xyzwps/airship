/**
 * `import './styles/airship.css'` 的声明垫片（host.tsx 用）。
 * 构建走 `tsc`，它不认 CSS——发布物里这条 import 原样留着，
 * 吃这份 SDK 的是 vite（应用构建）与 vitest（用例），两边都解得了 CSS。
 */
declare module '*.css'
