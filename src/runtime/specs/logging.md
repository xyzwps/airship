# logging

## Purpose
日志的行形状、分文件、以及"写日志不能把应用带崩"这条底线。

### Requirement: 一天一个文件，行形状固定
#### Scenario: LG-001 日志按天落到一个文件里
- **WHEN** 今天记下一条日志
- **THEN** 它落在 `<userData>/logs/airship-YYYY-MM-DD.log`（本地日期的年月日），文件名里带这一天的日期
- **AND** 目录不存在时自动建出来

#### Scenario: LG-002 一行的形状是"时间 级别 [来源] 消息 详情"
- **WHEN** 记一条带详情的 info
- **THEN** 行首是 ISO 时间戳，紧跟补齐五格的 `INFO`，再是 `[来源]` 与消息
- **AND** 详情在同一行尾部，能解析回原对象的内容

#### Scenario: LG-003 详情里的换行折成可见标记，长详情截到四千字
- **WHEN** 详情是一串带换行的长文本
- **THEN** 落盘仍是**一行**，换行处变成 `⏎`，超过 4000 字的部分被丢掉
- **AND** 详情完全没法序列化时写 `[unserializable detail]`，不抛错

#### Scenario: LG-004 级别决定控制台出口
- **WHEN** 分别记 info / warn / error
- **THEN** warn 走 console.warn、error 走 console.error、info 走 console.log，磁盘上三份都留痕

### Requirement: 写日志失败不致命
#### Scenario: LG-005 日志写不进去不能把应用带崩
- **WHEN** 日志目录被一个同名文件占住，写不进去
- **THEN** 记日志这一句正常返回，不抛错、不中断当前操作
- **AND** 该走控制台的仍然走到控制台
