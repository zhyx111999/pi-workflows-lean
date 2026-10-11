# pi-workflows-lean 架构导读

这份导读按“一句话到结果”的顺序说明插件如何运转：先看主流程，再看目录，最后看关键设计和改代码时的入口。代码与注释是英文的，阅读时可以对照本文中的文件名。

## 一句话定位

这是一个 Pi 扩展。主模型判断任务值得拆分时，就把任务交给若干**子代理**（每个都是一个全新的 Pi 会话）并行处理。子代理在后台运行，结果自动送回对话。用户不用学命令，配置和调用都由 AI 完成。

插件只给主模型两个工具：

| 工具 | 作用 |
|---|---|
| `subagents` | 启动：任务列表（每个任务一个子代理）、多步骤脚本，或按名字运行已保存的工作流 |
| `subagents_control` | 管理：`list`、`status`、`read`、`stop`、`resume`、`message` |

## 主流程：从一句话到结果

```text
用户输入一句话
  │  workflow-editor.ts：在 before_agent_start 追加一条隐藏消息（主模型提示词，display:false）
  ▼
主模型决定调用 subagents
  │  subagents-tool.ts：归一化参数，三选一（tasks / script / name）
  ▼
WorkflowManager.startInBackground()          workflow-manager.ts
  │  取得运行租约，写入第一份运行记录，立即返回 runId（本轮对话结束）
  ▼
executeRun()                                 manager/run-execution.ts
  │  把运行时事件接到实时快照上（manager/run-events.ts），节流写盘
  ▼
runWorkflow()                                workflow.ts
  │  解析脚本 meta → 装配脚本全局（agent、parallel、pipeline、checkpoint…）→ 在 vm 中执行
  ▼
agent() 调用                                 runtime/agent-call.ts → agent-execution.ts → agent-attempt.ts
  │  校验选项、占用槽位；能从日志复用就直接返回，否则在并发限制内真正运行
  ▼
WorkflowAgent.run()                          agent.ts
  │  选工具（agent/session-tools.ts）→ 选模型（agent/model-selection.ts）
  │  → 开子会话（agent/child-session.ts）→ 发提示 → 取结果（agent/turn-result.ts）
  ▼
结果写入日志（journal）和运行记录         run-persistence.ts / run-record-store.ts
  ▼
运行结束，管理器发出 complete 事件
  │  task-panel.ts：按会话把结果投递回对话（task-panel/delivery-*）
  ▼
主模型收到结果，审查后汇报给用户
```

管理动作走另一条线：`subagents_control`（`subagents-control-tool.ts`）调用管理器的 `stop()`、`resume()`、`steerAgent()`、`attachCheckpointResponse()` 和 `findRun()`；需要的展示文字由 `run-report.ts` 生成。

## 目录地图

源码共约 120 个文件，按层组织。原先 1800～2400 行的五个大文件，都已拆成一个入口加若干单一职责的模块。仍超过 500 行的几个文件，要么是开头写明主流程的入口（`workflow-manager.ts`、`workflow-ui.ts`、`task-panel.ts`、`agent.ts`），要么是 `run-persistence.ts`、能力契约和额度调度器这类内聚的单一模块。

### 入口层

| 文件 | 职责 |
|---|---|
| `extensions/workflow.ts` | Pi 加载的入口：导入编译后的 `dist/pi-extension.js`，并带上修改时间参数，让 `/reload` 能加载新构建 |
| `pi-extension.ts` | 装配一切：注册两个工具和斜杠命令，安装隐藏提示钩子、结果投递、额度暂停后的自动恢复；`session_start` 时绑定会话、处理跨项目切换 |
| `extension-reload.ts` | `/reload`、`/new`、resume、fork 时，把正在运行的管理器交给下一代扩展，后台运行不中断 |
| `workflow-editor.ts` / `parent-prompt.ts` | 隐藏的主模型提示词、`/workflows run` 的指令文字、`/workflows-progress` 命令 |

### 工具层（给主模型）

| 文件 | 职责 |
|---|---|
| `subagents-tool.ts` | `subagents` 工具：参数归一化，三种启动方式 |
| `subagent-tasks.ts` | 任务列表：固定脚本 + 任务作为 `args`；修改后重跑时计算“哪些任务没变” |
| `subagents-control-tool.ts` | `subagents_control` 工具：六个动作 |
| `run-report.ts` | 给模型看的运行摘要、子代理状态、等待中的暂停点、子代理会话末尾 |
| `builtin-workflows.ts` / `deep-research.ts` | 内置工作流（deep-research）及按名字解析 |

### 管理层：运行的生命周期（`workflow-manager.ts` + `manager/`）

`workflow-manager.ts` 是入口：启动、暂停、停止、恢复、删除、接管、追加指令都从这里进入。具体步骤拆在 `manager/`：

| 模块 | 职责 |
|---|---|
| `new-run.ts` | 创建一次运行的内存状态 |
| `run-execution.ts` | 跑一次执行，并记录它如何结束 |
| `run-events.ts` | 把运行时进度事件写进实时快照 |
| `run-outcome.ts` | 判断结束状态：完成、失败、暂停，以及“全部子代理都没产出”的警告 |
| `run-record.ts` | 把内存状态转成要写盘的记录 |
| `persist-throttle.ts` | 合并高频的进度写入 |
| `live-runs.ts` | 让内存中的运行与磁盘记录保持一致，忽略已被替代的旧执行 |
| `record-ops.ts` | 对本进程不拥有的记录，在租约保护下修改 |
| `resume-state.ts` | 从磁盘记录重建运行，以便恢复 |
| `task-list-reuse.ts` | 修改后的任务列表：把没变的任务映射到原来的调用 |
| `checkpoint-response.ts` | 暂停点：附加回应，恢复时校验 |
| `abort-control.ts` / `execution-settlement.ts` | 记录用户的暂停或停止造成的中止，并有界地等待执行收尾 |
| `terminal-retention.ts` | 控制内存里保留多少个已结束的运行 |

### 运行时层：执行一个脚本（`workflow.ts` + `runtime/`）

`workflow.ts` 的 `runWorkflow()` 只有三段：准备运行、装配全局、执行并收尾。

| 模块 | 职责 |
|---|---|
| `script-meta.ts` / `determinism.ts` | 读取并校验脚本开头的 `export const meta`；拒绝 `Date.now()`、`Math.random()` 等不可重放的写法 |
| `run-context.ts` | 一次运行的可变状态，以及各全局函数共享的服务 |
| `run-limits.ts` | 把设置变成运行限制：并发闸门、最大子代理数、超时、重试 |
| `script-vm.ts` | 建立 vm 上下文，只暴露声明过的全局 |
| `agent-options.ts` | 校验 `agent()` 选项；可用选项以能力契约的 `AGENT_OPTIONS` 为准 |
| `agent-call.ts` | `agent()`：占用槽位，先尝试从日志复用，否则交给执行 |
| `agent-execution.ts` / `agent-attempt.ts` | 真正运行：worktree 隔离、用量统计、重试、写日志、超时 |
| `call-identity.ts` | 调用的身份哈希：决定日志里的结果能不能复用；`agentCallId` |
| `fanout.ts` | `parallel()` 与 `pipeline()`：可恢复的分支失败返回 `null` |
| `checkpoint.ts` / `durable-json.ts` | 暂停点；暂停点数据必须能无损地存进 JSON |
| `run-teardown.ts` | 收尾：失败时封存运行，等待尚未结束的 `agent()` 调用 |

### 子代理层：一个子代理会话（`agent.ts` + `agent/`）

`agent.ts` 的 `WorkflowAgent.run()` 依次完成：选工具 → 选模型 → 开会话 → 发提示 → 取结果。

| 模块 | 职责 |
|---|---|
| `session-tools.ts` | 子代理的工具集；始终禁用 `subagents` 和 `subagents_control`，防止递归开子代理 |
| `model-selection.ts` | 选模型和思考等级：显式 model > 角色定义的 model > tier > 阶段路由 > 继承主模型（需开启 `inheritMainModel`）> 默认 medium 档 > Pi 默认模型 |
| `available-models.ts` / `model-registry.ts` | 可用模型列表；宿主没有提供注册表时，构建后备注册表 |
| `child-session.ts` | 打开子会话；不加载主会话扩展，所以隐藏提示词不会传给子代理 |
| `session-managers.ts` | 会话放在内存还是磁盘；同名 `thread` 复用同一个会话 |
| `resource-loaders.ts` / `provider-middleware.ts` | 资源加载器按目录共享；只放行白名单里的 provider 中间件 |
| `turn-result.ts` | 取结果：结构化输出，或最后一个工具结果之后的回答文字 |
| `turn-progress.ts` / `session-usage.ts` | 向宿主汇报历史快照和 token 用量 |
| `provider-limit.ts` | 识别额度或限流错误，让运行暂停而不是失败 |
| `windows-cwd.ts` | 拒绝 Windows 启动进程时会被悄悄换掉的目录 |

子代理收到的提示词只有三部分：角色定义正文（如果指定了角色）、任务原文，以及要求结构化输出时那段固定的输出格式说明。自动会话压缩由 Pi 自己完成；`agent.ts` 保证压缩改写会话后，仍能取回子代理的输出。

### 持久化层

| 文件 | 职责 |
|---|---|
| `run-persistence.ts` | 运行记录的读写、列表、删除、租约；本实例见过、但已被别的进程删除的记录，不会重建 |
| `run-record-store.ts` | 存储格式：变更日志（历史超过运行本身数倍时改写成一个快照）加一个原子提交的小索引头，详见 `docs/run-storage.md` |
| `fs-persistence.ts` | 原子写入、备份等文件系统基础操作 |
| `workflow-paths.ts` | 目录布局：`~/.pi/workflows/projects/<项目键>/`；Windows 上同一目录的不同写法共用一个项目键 |
| `workflow-saved.ts` | 已保存的工作流（`saved/<name>.json`）：项目级和用户级两层，项目级优先 |
| `shared-store.ts` / `logger.ts` | 运行内的键值存储；运行日志 `<runId>.log` |

### 投递与界面层

| 文件 | 职责 |
|---|---|
| `task-panel.ts` | 入口：实时面板，以及把结果按会话投递回对话 |
| `task-panel/delivery-*.ts` | 会话端点、发送与确认、有界重试 |
| `task-panel/pending-markers.ts` | 先写“待投递”标记再发送，发送失败或进程崩溃都不丢结果 |
| `task-panel/host-send-capture.ts` | 捕获宿主会话的发送函数，保证结果送回发起它的那个会话 |
| `task-panel/result-text.ts` | 完成、失败、暂停、等待暂停点时的通知文字 |
| `task-panel/panel-*.ts` | 输入框下方的实时进度面板 |
| `workflow-ui.ts` + `navigator/` | `/workflows` 导航器：运行列表 → 阶段 → 子代理 → 详情 → 全文分页 |
| `workflow-commands.ts` / `saved-commands.ts` / `builtin-commands.ts` | 人工使用的斜杠命令；处理函数通过 `CommandDeps`（`command-registry.ts`）的 getter 读取当前的管理器、存储和目录 |
| `display.ts` / `agent-history.ts` | 快照与子代理历史的展示格式；数字格式（`fmtFull`、`fmtCompact`）和运行状态图标都只有这一份 |

### 配置层

| 文件 | 职责 |
|---|---|
| `workflow-settings.ts` | `settings.json`：全局 → 仓库本地 → 项目覆盖，后者优先；运行限制只从这里读 |
| `model-tier-config.ts` / `model-spec.ts` / `model-routing.ts` | 模型档位（`model-tiers.json`）、模型写法解析、按阶段路由 |
| `agent-registry.ts` | 角色定义（agentType）：项目的 `.pi/agents` 优先于 `~/.pi/agent/agents` |
| `usage-limit-scheduler.ts` | 额度暂停后的自动恢复：退避、抖动、上限 |
| `worktree.ts` | 每个子代理独立的 git worktree：短路径；超时时结束整棵进程树 |

### 文档治理

| 文件 | 职责 |
|---|---|
| `workflow-capability-contract.ts` | 能力契约：脚本全局和工具参数的唯一事实来源；运行时按它注入全局 |
| `workflow-authoring-reference.ts` | 根据契约生成 README 能力表和技能参考文档（`npm run docs:generate`） |
| `workflow-context-measurement.ts` | 统计常驻提示、工具定义和技能各占多少字节（`npm run context:generate`） |

## 关键设计：为什么这样做

**始终后台运行。** 子代理可能跑很久，阻塞主对话就等于让用户干等。所以调用后立即返回 runId，结果靠投递机制送回，进度靠面板和 `read` 查看。

**日志与复用。** 每个完成的 `agent()` 调用都按“调用身份哈希”写进日志（`runtime/call-identity.ts`）。恢复或修改后重跑时：
- 脚本：只复用“最长未改动前缀”。后面的调用可能依赖前面的结果，前面一改，后面的结果就不可信。
- 任务列表：任务彼此独立，所以每个没变的任务都直接复用，不受顺序影响（运行选项 `independentCalls`）。
- 每个运行都保留日志，所以已完成的运行也能修改后重跑，已停止的运行也能继续。

**租约。** 同一个运行只能由一个进程执行。执行者持有租约，才能整份写入记录；没有租约的内存副本只算缓存，修改记录前必须重新取租约，并以磁盘为准。这避免了多个 Pi 窗口互相覆盖或重复执行同一个运行。

**删除跨进程生效。** 一个进程删掉运行后，其他进程不能把它写回来：本实例见过的记录一旦消失，写入就会抛 `RunRecordDeletedError`，持有旧副本的进程丢弃副本，并放弃投递。

**投递先落盘再发送。** 结果先写“待投递”标记，再发给会话，收到确认后才清除。Pi 重启、会话切换、发送失败都不会丢结果，也不会把结果发到别的会话。

**隐藏提示词。** 提示词作为 `display:false` 的消息紧跟在用户消息后面：模型能看到，界面上不显示，用户的原文保持不变；写进会话后，之后的请求前缀不变，不会破坏模型缓存。

**子代理上下文干净。** 子代理不加载主会话扩展，插件也不往提示词里加填充语。子代理只知道自己的任务，主模型负责拆分和审查。

**确定性脚本。** 脚本必须可重放：禁止 `Date.now()`、`Math.random()`，需要的外部值通过 `args` 传入。否则恢复时，同一个调用会算出不同的身份哈希，无法复用。

**能力契约是唯一事实来源。** 运行时注入哪些全局、`agent()` 接受哪些选项、文档里列出哪些能力，都来自同一份契约，并有测试保证三者一致。

**只服务 Pi，不做兼容层。** 插件只由 Pi 通过 `extensions/workflow.ts` 加载，没有给其他程序用的库出口；只支持当前的 Pi，没有为其他宿主或旧版本保留的分支；运行记录只读当前的“索引头 + 日志”格式，也只读 `~/.pi/workflows` 下的目录。唯一保留的旧数据处理是 `manager/resume-state.ts` 过滤日志里带其他 `runId` 标签的条目，因为现有记录里确实有这类条目。

**`dist/` 随仓库提交。** Pi 从 git 安装插件时只执行 `npm install --omit=dev`，不安装 TypeScript，也不编译，所以必须提交编译产物。`npm run check:dist` 保证提交的产物与源码一致。

## 推荐阅读顺序

1. `pi-extension.ts`：插件装了哪些东西。
2. `subagents-tool.ts` → `workflow-manager.ts` 的 `startInBackground()` → `manager/run-execution.ts`：一次运行怎么开始。
3. `workflow.ts` → `runtime/agent-call.ts` → `runtime/agent-execution.ts`：脚本怎么执行、`agent()` 怎么复用。
4. `agent.ts`：一个子代理怎么跑。
5. `task-panel.ts`：结果怎么回到对话。
6. `run-persistence.ts` 与 `docs/run-storage.md`：记录怎么存、租约怎么用。

## 常见修改从哪下手

| 想做的事 | 要改的地方 |
|---|---|
| 给 `agent()` 加一个选项 | 能力契约的 `AGENT_OPTIONS` → `runtime/agent-options.ts`（如需校验）→ `runtime/agent-execution.ts` 或 `agent.ts` 使用它 → 如果会影响结果，加进 `runtime/call-identity.ts` → `npm run docs:generate` |
| 加一个设置项 | `workflow-settings.ts`（解析与默认值）→ 用到它的地方 → 技能 `skills/subagents-setup/SKILL.md` |
| 改工具说明 | `subagents-tool.ts` 或 `subagents-control-tool.ts` → `npm run context:generate` → 核对 `tests/workflow-prompt-budget.test.ts` 的体积预算 |
| 改投递通知文字 | `task-panel/result-text.ts` |
| 改导航器某个页面 | `navigator/` 里对应的 `*-view.ts` |

## 检查与测试

```bash
npm test             # Biome、类型检查、构建、docs:check、context:check、全部单元测试
npm run check:dist   # 提交前：dist/ 必须与源码一致
```

- 单元测试会给每个测试进程一个临时 home（`tests/helpers/isolated-home.ts`），不会写入真实的 `~/.pi`。
- 单独跑一个测试文件时也要带上：`npx tsx --test --import ./tests/helpers/isolated-home.ts tests/<name>.test.ts`。
- 全仓统一使用 LF 换行。
