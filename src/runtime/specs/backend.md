# backend

## Purpose
应用随包自带的后台程序：前端怎么调它、它拿到哪几个目录、它退出了会怎样、什么时候被收掉。
后台**不是能力位、也不进清单**：有它靠约定——源项目应用目录里一份 `backend.ts` 或 `backend.js`，
产包流水编成包根 `backend.js`（`package.md` PK-040 / PK-041），runtime 见到那个条目才起进程。
对话复用桥上的信封与单事件频道（`bridge.md`）；这本册子钉的是**应用调用时读得到的句子与 runtime 这一侧看得见的事**。
真机上的崩溃隔离与进程形态（独立 Node 进程、父子消息通道的不对称、就绪握手）是实测记进
[架构](../../../docs/architecture.md) 的。

### Requirement: 后端有没有由包形状判，身份与来源照旧过同一道闸
#### Scenario: BE-001 包根没有 backend.js，调用被拒并念出这条约定
- **WHEN** 一个归档根里没有 `backend.js` 条目的应用调 `api.backend.invoke`
- **THEN** 拒，原因原样读得到「<id> 没有自带后台程序：包根要有 backend.js——源项目里放一个 src/backend.ts 或 src/backend.js，产包就会带上」

#### Scenario: BE-002 冒充别的应用名义调用被拒
- **WHEN** vcp 的窗口以 `pdf` 的名义发起后端调用
- **THEN** 拒，原因读得到「身份不匹配：这个窗口属于 vcp，不能以 pdf 的名义调用」

#### Scenario: BE-003 method 不合法时把收到的值原样念出来
- **WHEN** 调用传的 method 是空串或数字
- **THEN** 拒，原因读得到「method 必须是非空字符串，收到 <原样值>」

### Requirement: 一次调用是一次请求-回话，只把结果交回来
#### Scenario: BE-004 办成了只把值交给应用
- **WHEN** 后端对 `add` 回了成功与值
- **THEN** 应用 await 到的就是那个值本身；后端收到的 method 与 payload 与前端发出的逐字一致

#### Scenario: BE-005 后端回的失败原样读得到，不被套第二层话
- **WHEN** 后端对一条调用回了失败，原因写的是「没有这条待办」
- **THEN** 应用 catch 到的就是「没有这条待办」，不出现 "Error invoking remote method" 这类内部措辞

### Requirement: 后端是它自己的一份进程，拿到的目录只有它应用那一族
#### Scenario: BE-007 起后端时把三个位置原样交给它
- **WHEN** runtime 为一个应用起后端程序
- **THEN** 交给它的启动环境里读得到 `AIRSHIP_APP_ID`（这个应用的 id）、`AIRSHIP_DATA_DIR` 与 `AIRSHIP_CACHE_DIR`（它自己那族数据与缓存目录的绝对路径）
- **AND** 起的是磁盘上摊平落好的那份影子，文件名以 `.cjs` 结尾——扩展名自带 CommonJS 声明，落点哪怕在一份声明 `"type": "module"` 的 package.json 的目录树里（外部作者 dev 模式的落点就在项目里），也照旧起得来

#### Scenario: BE-008 迟迟不报就绪，起动作废且进程不留
- **WHEN** 后端入口起了但始终没发第一条就绪握手
- **THEN** 调用被拒，原因读得到「<id> 的后端程序没在 10 秒内报就绪：后端入口启动后要最先给 runtime 发一条 { ready: true }」
- **AND** 那个进程被收掉，不留一个"半起"的摊子

### Requirement: 生命周期跟着窗口走
#### Scenario: BE-009 后端中途退出，在途调用被拒并点名方法
- **WHEN** 一次调用还在等回话，后端进程先退出了
- **THEN** 这次调用被拒，原因读得到「后端程序中途退出，没等到 <method> 的回话（下一次调用会再拉起一个新的）」

#### Scenario: BE-010 退出之后再调用，会重新起一个并办成
- **WHEN** 后端退过出，前端再发起一次调用
- **THEN** 调用成功，值正常交回；用的是一个新起的进程，不是死的那个

#### Scenario: BE-011 关掉应用窗口，它名下的后端跟着收掉
- **WHEN** 一个应用的后端还在跑，把它的窗口关掉
- **THEN** 它的后端进程被收掉，在途调用听到的是 BE-009 那句
- **AND** 别的应用的后端一条都不碰

#### Scenario: BE-012 一次调用超时不回，只拒这一条调用
- **WHEN** 后端对某条调用迟迟不回话（过了 30 秒）
- **THEN** 这条调用被拒，原因读得到「后端程序没在 30 秒内回话：<method>（调用取消了，后端进程还留着——它要是之后回了话会被丢弃）」
- **AND** 后端进程没有被收，随后别的调用照常能通

### Requirement: 后端主动推的东西只回它自己那扇窗
#### Scenario: BE-013 后端推事件，只有归属窗口收得到
- **WHEN** vcp 的后端主动推一条事件
- **THEN** vcp 的窗口收到一条 `backend:event`，method 与 payload 原样；别的应用的窗口一条都收不到

<!--
  BE-006 于 2026-11-23 删除：backend 退出能力位与清单字段，改走 src/backend.ts|js → 包根 backend.js 的约定
  （package.md PK-040 / PK-041），"声明了能力却没写入口"这条配对契约失去了对象；
  BE-001 随之改写为"包根没有 backend.js 时念出约定"。编号按规矩不复用、不重排。
-->
