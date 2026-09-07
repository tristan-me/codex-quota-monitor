# 诊断指南

这份指南用于区分账户数据、会话发现、本机 App Server 和面板之间的问题。诊断输出只应保留版本、状态、时间和计数；不要上传 token、凭证、prompt、回答、工作目录、私人会话 ID 或账户额度。

## 先判断现象

| 现象 | 优先检查 |
| --- | --- |
| 面板打不开或本地地址拒绝连接 | launcher 是否运行、本机端口、`127.0.0.1` 防火墙和随机 token |
| 账户窗口可见，但会话列表为 0 | SQLite 读取、paginated/legacy 发现、监控开始时间和本地数据库权限 |
| 会话出现但显示“待校准” | 样本数量、账户窗口是否有正增量、`threadUsage` 是否为 `null` |
| 账户变化进入 `unattributed` | 本机没有匹配 token 增量，或变化来自其他设备、后台任务或未发现线程 |
| App Server 离线或反复重试 | CLI 版本、桌面版配置兼容性、App Server 启动输出和请求方法 |
| Codex 报 `EmptyInput` | 先单独复现原生 Codex 提交；本插件不拦截 composer、不提交 turn，不能把该错误归因给额度面板 |

## “活跃会话 0 个”的旧版根因证据

旧版的代码审计发现了一个确定的结构性问题：活跃计数只来自 Hook 维护的 `active` 状态。`UserPromptSubmit` 才会打开状态，`Stop` 或 `SessionEnd` 会关闭状态；没有 Hook 事件时，App Server 的线程列表不会反向创建会话。旧版还只有在已经存在活跃或近期会话时才发起线程列表读取，所以空状态无法自我修复。

旧版 Hook 在输入字段缺失、JSON 解析失败或本地目录写入失败时静默退出。Hook 未信任、未加载、与面板使用不同的本地数据目录，或会话早于监控开始，都会让旧版显示 0。新版使用本机 SQLite 的 paginated 与 legacy 发现路径，并应在诊断中明确报告发现来源、读取状态和最近样本时间。

旧版还默认从 PATH 启动 `codex app-server`。如果 PATH CLI 比桌面版旧，App Server 的配置或方法可能不兼容。优先使用与桌面版匹配的内置 CLI，并在提交报告时同时记录桌面版和 `codex --version`，不要把版本号或完整本地路径之外的敏感环境变量贴出来。

## 推荐的排查顺序

1. 确认 launcher 仍在运行，浏览器或 Codex 面板连接的是 `127.0.0.1`，并且访问 token 没有被截断。不要把 token 写入 issue。
2. 在面板诊断区域记录本地服务状态、SQLite 发现来源、paginated/legacy 读取计数、最近成功读取时间和错误类别。
3. 记录 Codex 桌面版版本、`codex --version` 输出和 Node 版本。若两套 CLI 不匹配，先切换到桌面兼容的 CLI 再重试。
4. 重新打开面板后等待至少一个账户采样周期。会话发现和速度样本是异步的，刚启动时显示“待校准”是正常状态。
5. 若账户窗口有变化但所有会话 token 增量为零，检查是否有其他设备、后台任务或尚未被本机 SQLite 发现的线程；此时 `unattributed` 是保留证据的结果，不是读取失败。
6. 若只有原生 Codex 提交失败，关闭面板后在同一 Codex 窗口单独复现。面板没有 composer 注入和 turn 提交逻辑，因此目前不能承诺修复 `EmptyInput`。

## “一直思考”的旧版根因证据

旧版打开面板时会同步等待一次完整采样。多个 usage 探测按小批次顺序执行，每个请求还有较长超时；当 App Server 无响应或线程数较多时，宿主可能长时间显示工具调用进行中而没有面板内容。新版应优先返回缓存，再在后台执行探测，并在面板中显示最近成功采样时间和下一次重试时间。

这条证据只能解释工具调用等待，不能证明它产生了 `EmptyInput`。两者应分别收集复现时间、Codex 版本和脱敏诊断状态。

## 提交公开 issue 前的脱敏模板

请提供：

- 操作系统、Codex 桌面版版本、`codex --version`、Node 版本；
- 面板状态（服务、SQLite 发现来源、最近成功读取时间、是否待校准）；
- 是否只读到账户窗口，是否能读到会话；
- 可重复的最短步骤和预期/实际结果；
- 脱敏后的错误类别和时间戳。

请删除：访问 token、凭证、prompt、回答、账户额度、完整 session/thread ID、工作目录、机器名和任何业务数据。详见 [README 隐私说明](../README.md#隐私)。

## 官方参考

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex Radar（参考入口）](https://codexradar.com/#model-ratings)
- [Codex Reset（参考入口）](https://codex-reset.com/zh/)
