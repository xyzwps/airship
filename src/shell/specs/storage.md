# storage

## Purpose
设置与数据的落盘规矩：文件怎么分、写坏怎么办、落盘是不是原子的。
目录布局见 [架构](../../../docs/architecture.md) §9。

### Requirement: 每应用一份设置，壳自己一份
#### Scenario: ST-001 应用之间看不到彼此的设置
- **WHEN** vcp 写一条自己的设置，PDF 读同一个键名
- **THEN** PDF 读不到 vcp 那笔（它拿到自己的回落值）
- **AND** 磁盘上是两份文件：`apps/vcp/settings.json` 与 `apps/pdf/settings.json`，壳自己那份在根上 `settings.json`

#### Scenario: ST-002 写 undefined 等于把这个键删掉
- **WHEN** 应用把某个键设成 `undefined`
- **THEN** 落盘的文件里这个键不再存在
- **AND** 再读它拿到的是调用方给的回落值

### Requirement: 落盘是"临时文件 + 改名"
#### Scenario: ST-003 中途不留半个文件
- **WHEN** 写一次设置
- **THEN** 目录里只剩改好名的正式文件，`.tmp` 那一步不残留
- **AND** 文件内容是完整可解析的 JSON，缩进两格

### Requirement: 坏文件不致命
#### Scenario: ST-004 解析失败就改名留证、记日志、从空开始
- **WHEN** 某应用的文件内容是残缺 JSON，然后有人读它的设置
- **THEN** 那次读返回回落值而不是抛错
- **AND** 坏文件被改名成 `<原名>.bad` 留在原地供排查，日志里有一条「设置文件解析失败，已重置」

#### Scenario: ST-005 顶层是数组或别的形状时同样从空开始
- **WHEN** 设置文件里是一个 JSON 数组
- **THEN** 读出来是空表加回落值，不把这个形状当设置用

### Requirement: 连续操作不能互相覆盖
#### Scenario: ST-006 连着写两笔，最后一份文件里两笔都在
- **WHEN** 同一应用连续设置两个不同键
- **THEN** 重读磁盘那份文件，两个键都读得到（后一次写不吞掉前一次）

#### Scenario: ST-007 一次拿全是副本，改它不影响壳里那份
- **WHEN** 应用 dump 自己的设置后改返回对象
- **THEN** 再读某个键拿到的还是壳里记的那份值

#### Scenario: ST-008 装好之后第一次读写就能落进自己的目录，不看启动时刻
- **WHEN** 壳已经跑起来了，之后才装进一个应用，它头一次读写自己的数据
- **THEN** 读到的路径落在 `userData/apps/<id>/data`，目录不存在就当场建出来，设置文件同样可写
- **AND** 不出现 `Cannot read properties of undefined (reading 'data')` 这类"目录表里没有它"的失败
