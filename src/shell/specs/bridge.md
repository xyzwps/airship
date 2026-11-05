# bridge

## Purpose
应用与壳之间那一层调用：返回值怎么拆、失败怎么说、身份从哪来。
契约方法的清单见 [架构](../../../docs/architecture.md) §5，这本册子只管"用户/开发者看得见的结果"。

### Requirement: 调用只返回信封，失败必须是中文句子
渲染侧看到的是普通 `try/catch`，看不到 Electron 的内部措辞。

#### Scenario: BR-001 成功调用只把值交给应用
- **WHEN** 应用调一条契约方法且壳办成了
- **THEN** 应用拿到的是值本身，看不到 `ok` / `value` 这层信封

#### Scenario: BR-002 失败时念出中文原因，不念 Electron 的话
- **WHEN** 同一条调用被壳拒了或办坏了
- **THEN** 应用 catch 到的 `Error.message` 是那句中文原因
- **AND** 里面不出现 `Error invoking remote method` 这类内部措辞

### Requirement: 身份由壳注入，冒充不了别人
应用侧根本没有"传 id"这个动作；主进程还按来源窗口反查一次。

#### Scenario: BR-003 以别的应用名义调用被拒
- **WHEN** vcp 的窗口拿 PDF 的名义调一条应用接口
- **THEN** 拒，原因读得到「身份不匹配：这个窗口属于 vcp，不能以 pdf 的名义调用」
- **AND** 这一笔被记进日志（身份不匹配，已拒绝）

#### Scenario: BR-004 没登记过的来源一律拒
- **WHEN** 一个不是壳开出来的窗口（或已销毁的窗口）来调
- **THEN** 拒，原因读得到「调用来源不是壳注册的窗口，拒绝」

#### Scenario: BR-005 两套面各走各的
- **WHEN** 应用窗口调只有启动器能用的接口，或启动器调应用专用接口
- **THEN** 前者听到「这个接口只有启动器能用」，后者听到「这个接口只给应用用，启动器不该调」

### Requirement: 未声明的能力一律拒绝（不变量 I-3）
静默降级会让边界形同虚设，所以拒了要说清该改哪份清单。

#### Scenario: BR-006 能力没声明就调，原因点出能力名与清单路径
- **WHEN** 一个没声明 `settings` 的应用读写设置
- **THEN** 原因读得到「<id> 没有声明 settings 能力（要用它就在 apps/<id>/app.ts 的 capabilities 里声明）」

#### Scenario: BR-007 共享命名空间没声明就用不了
- **WHEN** 应用把路径解析到没在自己清单 `sharedNamespaces` 里写过的命名空间
- **THEN** 原因读得到「<id> 没有声明共享命名空间 <ns>（在 apps/<id>/app.ts 的 sharedNamespaces 里声明）」

#### Scenario: BR-008 参数不合法要把收到的值念出来
- **WHEN** 应用传的 path 或 key 是空串、非字符串
- **THEN** 原因读得到「path 必须是非空字符串，收到 0」这种形状，把收到的值原样念出来

### Requirement: 事件只回到该收的那个窗口
单一频道，按归属投递；一个监听器抛错不影响其他监听器。

#### Scenario: BR-009 渲染侧拿不到 ipcRenderer
- **WHEN** 看桥暴露出去的东西
- **THEN** 只有包好的 `airship`（应用）与 `airshipShell`（仅启动器窗口）两个对象
- **AND** 没有任何一处把 `ipcRenderer` 整个交出去

#### Scenario: BR-010 别的应用收不到这个应用的事件
- **WHEN** vcp 名下子进程的输出回流
- **THEN** 只有 vcp 自己的窗口收到；PDF 的窗口与启动器一条都收不到
- **AND** vcp 窗口没开时事件被丢弃，不广播兜底
