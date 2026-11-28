# bridge

## Purpose
应用与 runtime 之间那一层调用：返回值怎么拆、失败怎么说、身份从哪来。
契约方法的清单见 [架构](../../../docs/architecture.md) §5，这本册子只管"用户/开发者看得见的结果"。

### Requirement: 调用只返回信封，失败必须是中文句子
渲染侧看到的是普通 `try/catch`，看不到 Electron 的内部措辞。

#### Scenario: BR-001 成功调用只把值交给应用
- **WHEN** 应用调一条契约方法且 runtime 办成了
- **THEN** 应用拿到的是值本身，看不到 `ok` / `value` 这层信封

#### Scenario: BR-002 失败时念出中文原因，不念 Electron 的话
- **WHEN** 同一条调用被 runtime 拒了或办坏了
- **THEN** 应用 catch 到的 `Error.message` 是那句中文原因
- **AND** 里面不出现 `Error invoking remote method` 这类内部措辞

### Requirement: 身份由 runtime 注入，冒充不了别人
应用侧根本没有"传 id"这个动作；主进程还按来源窗口反查一次。

#### Scenario: BR-003 以别的应用名义调用被拒
- **WHEN** airship-ffmpeg 的窗口拿 airship-s3 的名义调一条应用接口
- **THEN** 拒，原因读得到「身份不匹配：这个窗口属于 airship-ffmpeg，不能以 airship-s3 的名义调用」
- **AND** 这一笔被记进日志（身份不匹配，已拒绝）

#### Scenario: BR-004 没登记过的来源一律拒
- **WHEN** 一个不是 runtime 开出来的窗口（或已销毁的窗口）来调
- **THEN** 拒，原因读得到「调用来源不是 runtime 注册的窗口，拒绝」

### Requirement: 没声明过的共享区一律拒绝
静默降级会让边界形同虚设，所以拒了要说清该改哪份清单。共享区看 `sharedNamespaces` 那一份名单。

#### Scenario: BR-007 共享命名空间没声明就用不了
- **WHEN** 应用把路径解析到没在自己清单 `sharedNamespaces` 里写过的命名空间
- **THEN** 原因读得到「<id> 没有声明共享命名空间 <ns>（在 apps/<id>/app.ts 的 sharedNamespaces 里声明）」

#### Scenario: BR-008 参数不合法要把收到的值念出来
- **WHEN** 应用传的 path 或 key 是空串、非字符串
- **THEN** 原因读得到「path 必须是非空字符串，收到 0」这种形状，把收到的值原样念出来

### Requirement: 拖放文件换本机路径是渲染侧就地算的，不过桥
preload 用 Electron 的 `webUtils.getPathForFile` 读浏览器已经交出来的那个对象，不新增任何授权面。

#### Scenario: BR-012 拖进来的文件能在渲染侧就地换成路径，不占任何授权面
- **WHEN** 应用窗口把拖放/选择事件里那颗文件交给 `api.fs.pathForFile`
- **THEN** 盘上有真身的文件得到本机绝对路径；JS 自造的（盘上没有对应文件）得到空串
- **AND** 不碰设置的空清单应用照样换得到——它只是读出浏览器已经给你的那个对象的名字，能不能读那份文件仍由 grants 的路径表说了算

### Requirement: 事件只回到该收的那个窗口
单一频道，按归属投递；一个监听器抛错不影响其他监听器。

#### Scenario: BR-009 渲染侧拿不到 ipcRenderer
- **WHEN** 看桥暴露出去的东西
- **THEN** 只有包好的 `airship` 一个对象，没有第二套 runtime 侧的面
- **AND** 没有任何一处把 `ipcRenderer` 整个交出去

#### Scenario: BR-010 别的应用收不到这个应用的事件
- **WHEN** airship-ffmpeg 名下的后端推出事件
- **THEN** 只有 airship-ffmpeg 自己的窗口收到；airship-s3 的窗口一条都收不到
- **AND** airship-ffmpeg 窗口没开时事件被丢弃，不广播兜底

<!--
  BR-005 于 2026-11-19 删除：启动器退场，桥只剩应用这一套面，"两套面各走各的"失去对象。
  BR-011 于 2026-11-24 删除：`net` 能力位整族退场（连同 CSP 的 net 变体与窗口 webSecurity 豁免）。
  直连外部服务的唯一来路改成应用随包自带的后端进程（backend.md），那不在渲染侧授权面里；
  此前只有 airship-s3 用过这一位，迁移后没有任何应用需要豁免同源策略。编号不复用、不重排。
  BR-006 于 2026-11-27 删除：capabilities 整族退场（不变量 I-3 随之取消）。渲染进程没有沙箱，
  这族位拦不住真心想绕的人，settings / log / tray / notify 又是个个要用的基础功能——
  拒绝语料里"没有声明 X 能力"那一句随之消失，闸只剩身份、那份名单与 grants。
  proc-tools.md 整本册子（PT-001~PT-008、PT-010）于 2026-11-27 显式删除：外部工具整族从 runtime 退场。
  闸的强度不及它的承诺——应用随包自带的后端进程本就是无限制的 Node，能跑什么在那里没有边界可言，
  runtime 侧再摆一张工具表只是让老实人多写一行声明；发现逻辑（哪台机器上 ffmpeg 落在哪）也从来是
  这台机器的知识，不该由发布出去的契约代管。外部命令改由应用自己的后端进程负责（backend.md）。
-->
