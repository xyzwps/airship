/**
 * `@airship/sdk/testing` —— 应用用例的地基：一个内存里的假壳与一个挂载器。
 *
 * 它住在 SDK 而不是壳的测试目录里，理由有两条：
 *   1. 应用不许引壳（AP-013），用例也不能——否则"包自持"在测试里是假的；
 *   2. 外部作者复制范本出去以后，装完 `@airship/sdk` 就该拿到同一个替身，
 *      他测到的"没声明 settings 时用户看见的那句中文"与仓库里测的是同一句。
 *
 * 替身只实现真 API 面上存在的方法：缺什么要喊出来，不许用可选链吞成空操作。
 */

export { FakeAirship } from './fakeAirship.ts'
export { mountUi, type Mount, type MountOptions } from './mount.tsx'
