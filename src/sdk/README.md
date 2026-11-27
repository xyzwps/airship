# @airship/sdk

airship 应用面向的那一面：宿主、观感、CSP、工装钩子与测试替身。

写一个 airship 应用，前端代码里只需要这一个包——窗口外壳、主题落地、留白与占位都由宿主接管，你的组件只管画自己的内容。

## 起步

```tsx
// src/main.tsx（整个入口就一行）
import { createAirshipApp } from '@airship/sdk'
import { app } from './app.ts'
import App from './App.tsx'

createAirshipApp({ meta: app, component: App, icon: './icon.png' })
```

组件里拿到的 `api` 就是 runtime 的全部通道，随取随用。真正的边界只有三份名单：共享区看清单的 `sharedNamespaces`，外部工具看清单的 `tools`，文件路径看 grants 的授权表；越界时拒绝你收到的是一句人话。

常用导出：`createAirshipApp`、`useTheme`、`Titlebar` / `IconButton` / `Glyph`、`AIRSHIP_CSP`。

## 子入口

- `@airship/sdk/styles.css` —— 宿主样式（CSS 变量这一族是配色的唯一正源）；
- `@airship/sdk/testing` —— `FakeAirship` 与 `mountUi`，jsdom 里跑组件用例，不需要真 runtime；
- `@airship/sdk/vite` —— 给 vite 的 CSP 注入插件。

```tsx
import { FakeAirship, mountUi } from '@airship/sdk/testing'

const fake = new FakeAirship({ id: 'hello', sharedNamespaces: [], tools: [] })
const m = await mountUi(<MyApp api={fake.api} />, { fake })
```
