/**
 * @airship/contract 的唯一入口。
 *
 * 契约层是依赖图的叶子：只有类型、常量与人读的措辞，不 import 任何别的东西。
 * 外面一律 ，不许摸包内文件——
 * 与共享包同一条规矩（I-6），由 tests/architecture.test.ts 扫 import 图挡住。
 */
export * from './protocol.ts'
export * from './app.ts'
export * from './errors.ts'
export * from './registryRules.ts'
export * from './packageRules.ts'
