# 版本号管理

目前本项目有两类包体：

1. 基础包。包括 `@airship/contract`, `@airship/sdk`, `@airship/cli`, `create-airship-app` 等
2. 应用包。在 `src/apps` 目录下。

我们约定版本号演进是这样的：基础包的版本号统一一致演进，应用包的版本号各自演进。

此外，我们说增加版本号的时候，没有明确说明的时候，总是增加 patch 号，而不是增加 major 和 minor。
