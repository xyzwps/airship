# textdecode

## Purpose
把一批字节解成中文正文：墨读解 TXT、vcp 读字幕都问它同一件事。
判据是"解出来的是不是那句人话"，不是内部走了哪条分支。
为什么顺序不能换，见 [../architecture.md](../../../docs/architecture.md) §8.2。

### Requirement: 带 BOM 的一律先按 BOM 判
BOM 是文件自己申报的编码，先听它申报的。
把 UTF-16 排到最后兜底是错的：UTF-16 的中文字节常常也能被 UTF-8 严格解"成功"，
于是交出去的是一串乱码，永远轮不到 UTF-16。

#### Scenario: TD-001 带 UTF-16LE BOM 的文件解出中文
- **WHEN** 解一段开头是 `FF FE` 的 UTF-16LE 中文字节
- **THEN** 得到的是那句中文（「网络」），不是乱码
- **AND** 结果里不含替换字符

#### Scenario: TD-002 带 UTF-16BE BOM 的文件同样按 BOM 判
- **WHEN** 解一段开头是 `FE FF` 的 UTF-16BE 中文字节
- **THEN** 得到的是同一句中文，字节顺序没有把它绊倒

#### Scenario: TD-003 BOM 判在 UTF-8 之前，原缺陷不再复现
- **WHEN** 同一段 UTF-16LE 中文字节，既能让 UTF-8 解出点什么、也能让 GBK 解出点什么
- **THEN** 交出来的仍是 UTF-16 那句中文
- **AND** 不会因为"UTF-8 也解得动"就把乱码交出去

### Requirement: 没有 BOM 时先试 UTF-8，解不动再回退 GBK
UTF-8 是"能解就必须是人话"的严格判据：解出替换字符就算解不动，这时才轮到 GBK。
国内下载的 TXT 绝大多数是 GBK。

#### Scenario: TD-004 正路 UTF-8 的中文直接解
- **WHEN** 解一段没有 BOM、本身就是合法 UTF-8 的中文
- **THEN** 得到原文，不含替换字符

#### Scenario: TD-005 UTF-8 BOM 要剥掉
- **WHEN** 解一段开头是 `EF BB BF` 的 UTF-8 文本
- **THEN** 正文第一个字符就是句子的第一个字，开头不带那个不可见的 BOM 字符

#### Scenario: TD-006 GBK 的中文靠回退认出来
- **WHEN** 解一段没有 BOM 的 GBK 中文（UTF-8 严格解会出替换字符）
- **THEN** 得到的是那句中文（「中文」），不是带替换字符的 UTF-8 结果

### Requirement: 两条都解不出来时交出一份能看的东西，不抛错
用户手里可能是残缺文件或混合编码的文件，界面不该因此卡住。

#### Scenario: TD-007 UTF-8 与 GBK 都解不动时返回带替换字符的结果
- **WHEN** 解一段两种编码都对不上的字节
- **THEN** 拿到一个字符串而不是异常，解不动的位置是替换字符
- **AND** 长度与顺序仍按原字节走，调用方能把剩下的内容显示出来
