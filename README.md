# Codex Quota Monitor

Codex Quota Monitor 是一个本地运行的 v0.2.0 beta 插件，用来观察 Codex 账户窗口、发现本机会话，并给出每会话订阅额度消耗的透明估算。它不会把估算结果包装成官方精确拆账。

[English README](./README.en.md) · [诊断指南](./docs/diagnosis.md)

## 当前版本能做什么

- 通过本机 SQLite 元数据只读发现会话，兼容新的 paginated 路径和 legacy 路径；不会写入 Codex 数据库。
- 主面板显示当前账户的官方剩余/已用百分比、采样时间和北京时间重置时间；无需填写套餐倍率。接口只返回 Pro 时，不推断它是 5x 还是 20x。
- 默认每 5 秒刷新本地缓存，默认每 30 秒读取一次账户额度。两个频率都可以在面板中调整。
- 在监控开始之后记录会话样本，显示消耗百分比、观察速度、重置倒计时和基于线性趋势的耗尽预估。
- 检查账户是否返回 `threadUsage`；本版本以本机 token 增量比例分摊账户窗口变化，逐任务 credits 校准尚待后续版本实现。当前已验证账号返回 `threadUsage=null`。
- 面板每次打开都会显示以下说明，并提供“不再提醒”复选框和确认按钮：

  > 需要说明：每会话百分比和速度仍是透明标注的估算值，而不是官方提供的精确拆账或未来保证。

数字保留小数点后三位只是显示格式，不代表底层数据或官方拆账具有三位小数的精度。样本不足时会显示“待校准”，不会把缺少证据的速度显示成零。

## 成本与准确性边界

界面每 5 秒读取一次本地缓存，默认约 720 次/小时；服务运行时账户额度默认每 30 秒读取一次，约 120 次/小时。模型列表和逐任务能力探测各每小时一次；失败后最短一分钟重试。面板计数是 RPC 调用次数，底层认证或重试可能产生更多 HTTP 请求。刷新本身不调用模型，但本地 HTTP、SQLite、CPU 和网络请求仍有成本；开启工具的原始 Codex 会话仍会按照正常方式消耗 token 和订阅额度。

账户窗口是账户级数据。每会话数据属于估算，并且只覆盖监控开始之后的样本，不是会话生涯统计。当前 `threadUsage=null` 时，插件只能按照本机 token 增量比例分摊账户变化；不同模型的真实权重未知，其他设备、后台任务或未被发现的线程也可能污染账户窗口，所以这类结果会标为低置信度。账户窗口发生变化而本机没有可匹配 token 增量时，差额会留在 `unattributed`，不会强行分配给某个会话。服务离线期间的账户变化也归入未归因项；同一窗口内重启保留已记录累计值。

重置时间使用账户窗口提供的倒计时。耗尽时间是根据最近观察速度做的线性预估；突发赠送、人工调整或其他未知重置不会被提前知道，也不会被伪装成确定事件。

## 与原生 Codex UI 的边界

已定向核验桌面版 Codex 0.153.4 的插件挂载点、生命周期 Hook 与 App Server schema。Hook 面向 session/turn，没有原生窗口启动事件；`turn/steer` 不接受 model 覆盖，默认 model 也不热加载到已运行的任务。详见[官方 App Server 文档](https://developers.openai.com/codex/app-server)和[Hooks 文档](https://developers.openai.com/codex/hooks)。本插件不通过修改 Electron 包、注入页面或中断任务实现这些功能。

当前没有官方挂载接口可以保证在每次打开原生 Codex 窗口时弹出自定义弹窗，也没有官方接口可以把“已处理 xx 分钟 xx 秒、实时速率、已消耗额度”嵌入原生 Codex 文本。因此 v0.2.0 beta 提供独立/compact 面板来承载免责声明和指标，不宣称已经完成这些原生 UI 要求。

自动切换模式是可选的，必须由用户在界面中明确开启。启用后只写入默认 `model` 和 `model_reasoning_effort`，作用于下一次新任务；不会接管已经运行的任务，也不会宣称它一定是性价比最高或官方最优方案。Codex Radar 和 Codex Reset 仅作为产品参考入口：<https://codexradar.com/#model-ratings>、<https://codex-reset.com/zh/>。

插件不拦截 composer 输入、不代替用户提交 turn，也不承诺修复 `failed to submit turn input: EmptyInput`。遇到该错误请先按[诊断指南](./docs/diagnosis.md)区分宿主 Codex、CLI/App Server 和本地面板的问题。

## 安装与本地运行

要求：Node.js `>=22.13.0`。运行时不需要 npm 依赖；Node 22.13 的 `node:sqlite` 仍处于实验状态，但在本项目中受支持。

先下载或克隆 [GitHub 仓库](https://github.com/tristan-me/codex-quota-monitor)。macOS 可以双击 `Open-Monitor.command`；也可以从仓库根目录运行独立面板：

```bash
node plugins/codex-quota-monitor/server/launcher.mjs
```

再在另一个终端把本地 marketplace 加入 Codex，并安装插件：

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-quota-monitor@codex-quota-monitor
```

优先使用与桌面版兼容的内置 Codex CLI。若系统 PATH 中存在更旧的 CLI，插件的 App Server 能力可能与桌面版配置不匹配；请先检查 `codex --version`，不要把版本差异当成额度数据问题。

启动后在 Codex 中打开 Codex Quota Monitor。面板使用本机 `127.0.0.1` HTTP 服务和随机访问 token，不是公开站点；不要公开分享带 token 的本地地址。正常重启会复用已保存的端口和 token；若端口被其他程序占用，会报错而不会关闭那个程序。

请通过正式启动器打开真实账户。`--demo` 是开发测试模式，使用独立 `demo/` 目录、独立 token，并醒目标明合成数据。演示地址不能代表你的账户。连接中断时页面撤下实时数据并提示重新打开启动器。

关闭接管仅停止后续自动修改；推荐区的“恢复接管前的默认模型”可以恢复。若你已在别处手动修改模型，恢复操作会拒绝覆盖。配置修改使用版本校验，测试在独立临时 CODEX_HOME 中完成。

停止后台服务：

```bash
node plugins/codex-quota-monitor/scripts/stop.mjs
```

本地数据默认位于 `~/.local/share/codex-quota-monitor-v2`。可用 `CODEX_QUOTA_MONITOR_DATA_DIR` 覆盖；用 `CODEX_QUOTA_MONITOR_CODEX_BIN` 指定与桌面兼容的 Codex 可执行文件。

## 隐私

插件不读取认证文件，也不保存或上传 prompt、回答内容或遥测。它读取 SQLite 中的任务名称、模型、时间、状态、token 计数；legacy 回退会读取有限长度的 JSONL 尾部，只提取生命周期及 token 元数据，忽略对话内容。任务标题本身可能源自请求首行，因此仍属于本地私有信息。派生状态仅保存在本机。提交问题时请删除访问 token、账号额度、私人会话 ID、工作目录和对话内容。

## 开发与验证

项目刻意保持零 npm 依赖。测试矩阵覆盖 Node 22.13 和 Node 24：

```bash
cd plugins/codex-quota-monitor
node --test tests/*.test.mjs
```

Node 22.13 运行 SQLite 测试时，如本机要求显式启用实验 API，可使用：

```bash
node --experimental-sqlite --test tests/*.test.mjs
```

欢迎通过 GitHub issue 提交经脱敏的诊断信息、可重现 fixture、文档改进和跨平台测试。
