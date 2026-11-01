# 测试范围

这里保留可重复运行的回归源码；日志、截图、抓包和临时安装树不放在此目录。

| 范围 | 文件 |
|---|---|
| 配置、应用与生命周期 | `activation`、`apply`、`lifecycle`、`launch` |
| 执行器与进程桥接 | `backends`、`harness-adapters`、`regressions`、`hot-switch`、`spawn`、`private-server` |
| 恢复与数据安全 | `footprints`、`project`、`restore`、`safety`、`update` |
| Web / 请求验证 / 打包 | `web`、`capture`、`verification`、`window`、`release` |
| 网关插件 | `magpie/` |
| 真实浏览器 | `browser/` |

`npm test` 自动发现顶层 `*.test.mjs`，并运行旧断言式测试与插件测试。`isolate.mjs` 在配置模块求值前设置临时环境，避免读写真正的用户配置。

UI 测试单独运行 `npm run test:ui`。需要真实宿主的请求捕获由 `npm run test:harness` 执行，不能混同于模拟适配器测试。

新增测试按功能命名，不使用时间戳或“final-v2”等过程名称。提交源代码，不提交输出；开发入口见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
