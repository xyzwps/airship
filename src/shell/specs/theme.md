# theme

## Purpose
三档主题的选定与落地：谁有权改、每个窗口怎么把主题落到自己那份文档上、"跟随系统"由谁算。
启动器那一屏的其余内容见 `shell.md`。

### Requirement: 主题只有启动器能改
应用侧只读，改由启动器发起，壳落盘后广播。

#### Scenario: TH-001 启动器读得到三档，档位名字就是那三档
- **WHEN** 打开启动器看主题那一格下拉
- **THEN** 依次读得到「跟随系统」「亮色」「暗色」三档，没有第四档
- **AND** 下拉当前显示的就是壳记下的那一档

#### Scenario: TH-002 应用窗口里改不了主题
- **WHEN** 在应用窗口里问"能不能改主题"
- **THEN** 答复是只读：拿不到 setter，界面里也没有任何改主题的入口
- **AND** 同一个 hook 在启动器里才给得出 setter

#### Scenario: TH-003 "跟随系统"的实际亮暗由启动器算好交给壳
- **WHEN** 系统偏好是暗色，在启动器把主题切到「跟随系统」
- **THEN** 发给壳的请求带着 `system` 与实际算出的 `dark`
- **AND** 主进程自己不去猜系统偏好（它没有 matchMedia）

#### Scenario: TH-004 亮暗两档是直接落定的实际结果
- **WHEN** 在启动器把主题切到「亮色」
- **THEN** 发给壳的请求里 mode 与 resolved 都是 `light`

### Requirement: 每个窗口都得自己把主题落到文档上
窗口化之后每个窗口是独立文档：没人落地，整窗 CSS 变量就是空的。

#### Scenario: TH-005 窗口挂载后文档上带着实际生效的亮暗
- **WHEN** 壳说现在生效的是暗色，应用窗口挂载起来
- **THEN** 这个窗口的 `<html>` 上 `data-theme` 是 `dark`，`color-scheme` 也是 `dark`
- **AND** 生效值换成亮色后，同一份文档跟着变成 `light`

#### Scenario: TH-006 桥还没回话时先按系统偏好画，避免白闪
- **WHEN** 主题查询还没返回
- **THEN** 首帧的亮暗取自系统的 `prefers-color-scheme`，不是空白或默认亮色

#### Scenario: TH-007 壳广播主题变更，所有窗口一起跟上
- **WHEN** 有人改了主题，壳把变更广播出来
- **THEN** 窗口里读到的主题快照跟着换，`<html>` 的实际亮暗在同一趟里落地

### Requirement: 主进程读主题时不编造实际值
`system` 档在渲染侧才算得准，主进程只兜底。

#### Scenario: TH-008 没记过主题时读出来是跟随系统
- **WHEN** 壳设置里还没写过主题
- **THEN** 读到的 mode 是 `system`
- **AND** resolved 回落成"上一次实际生效的那档"，默认 `light`

#### Scenario: TH-009 写过的档位原样读回
- **WHEN** 壳设置里记着 `{ mode: 'dark' }`
- **THEN** 读到的 mode 是 `dark`，resolved 也是 `dark`
