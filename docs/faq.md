# FAQ

## just build 在 NSIS 步骤报 `spawn UNKNOWN` 怎么办？

根因大概率是 **Smart App Control（SAC）开启**：electron-builder 的 NSIS 流水要先编译一个未签名的
"卸载器生成桩"并把它弹起来跑一遍（`computeScriptAndSignUninstaller`：编译桩 → 跑桩 → 才签名），
SAC 会拦这个刚出炉的未签名 exe，spawn 直接失败。

判据：事件查看器 → 应用程序和服务日志 → Microsoft → Windows → **CodeIntegrity/Operational**，
看有没有与构建尝试时间对应的 3118（SAC 拦截详情）+ 3077（强制拦截）成对记录，被拦目标即 `release\*-Setup-*.exe` 桩。
注册表 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` 的 `VerifiedAndReputablePolicyState=1` 即强制开启。

处置（公开解法按代价排序）：

1. **关闭 SAC**（dev 机推荐）：Windows 安全中心 → 应用和浏览器控制 → Smart App Control 设置，
   或 `start windowsdefender://smartappcontrol`。新版 Windows 更新后**关掉还能重开，无需重装系统**（官方 FAQ 已改口）。
   关后不用重启，直接重跑 `just build`。
2. **换构建环境**：在没有 SAC 的机器或 CI（如 GitHub Actions windows runner）上出包。
3. **完全自定义 NSIS 脚本**（`nsis.customScript` 指整份 .nsi）会让 electron-builder 跳过弹桩流程，
   代价是自己接管卸载器生成与注册——本仓 `build/installer.nsh` 只是 include 片段，不触发该分支。

无效的路：SAC **没有逐应用白名单**，Defender 排除路径对它也不生效（它是独立于 Defender 的 WDAC 强制层）；
代码签名救不了这一步——桩是在签名**之前**被弹起来的，永远是未签名状态。
