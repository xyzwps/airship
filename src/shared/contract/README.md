# @airship/contract

airship 运行时与应用之间的契约层：能力表、清单类型、拒绝措辞、注册与包形状的判据。

这一层只有类型、常量与纯函数，不 import 任何东西——产包侧、runtime 注册侧与应用安装器念的是**同一批函数**，所以"包能不能注册"这件事在全链路只有一份答案。

## 给应用作者的用途

应用清单（`src/app.ts`）用的类型从这儿来：

```ts
import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  id: 'my-todo',
  name: 'my-todo',
  description: '一句话说清这个应用是干什么的',
  capabilities: []          // 唯一授权面，用不到就写空数组
}
```

常用导出：

- `AppMeta` / `Capability` / `CAPABILITY_LABEL`——清单形状、能力位名单与每一位的中文念法；
- `APP_ID_PATTERN`——应用 id 的规矩（1~32 位，小写字母开头，其后小写字母、数字与连字符）；
- `packageRules`——包（zip 归档 `<id>.airship`）的注册判据；
- 各条拒绝路径的中文措辞——错误话术也只有一份真源。

装它通常不是你直装，而是 `npx create-airship-app` 建出来的项目骨架里已经带上。
