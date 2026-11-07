# CHANGE_ME

## Purpose
这个应用管的那块用户可见的东西。一本册子只管一块，写不出可执行判据的期望别进来。

### Requirement: 这个应用锁的第一条不变量
依据：为什么这么定（一段话，指向 docs/architecture.md 的某节，别把依据抄成长段）。

#### Scenario: CHANGE_ME-001 界面第一屏读得到哪句话
- **WHEN** 打开这个应用
- **THEN** 界面上读得到「显示名」
- **AND** 不出现 Electron 的内部措辞

<!--
  四档结构是硬的：Purpose → Requirement → Scenario → WHEN/THEN，一条 Scenario ≤ 5 行、只锁一个不变量。
  编号是稳定句柄：不复用、不重排；`just casecov` 会把册里编号与用例编号做双向差集，
  册里有号没用例 = 未实现，用例挂了号册里没有 = 私测，两边都算红。
  界面观感（宽度、圆角、真排版好不好看）不进册子，那是 `just shot` 截图走查的事。
  前缀取两个没被用过的字母（AP BK BR CA CL DG GR IM LB LF LG PD PT SH ST TD TH TR VC WL PK 已占用）。
-->
