# Claude AgentHost Phase Handoff

更新时间：2026-05-22

适用范围：

- 本文用于后续 agent 接手 `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude` 下的 Claude AgentHost 工作。
- 主要依据当前 checkout 中的 `roadmap.md`、各 `phase*-plan.md`、`CONTEXT.md`、以及代码中仍存在的 TODO / stub。
- 本文是交接摘要，不替代源计划；动手前仍应先读对应 phase plan 和当前代码。

## 1. 总体目标

在 VS Code Agent Host 中实现一个 `ClaudeAgent`，与现有 `CopilotAgent` 并列注册。Claude Agent SDK 作为本地子进程运行，但所有 Anthropic 格式的 `/v1/messages` 流量不直连 Anthropic，而是走本地 `IClaudeProxyService`，再转到 GitHub Copilot CAPI。

目标体验可以概括为：

- 用户用 GitHub Copilot 凭据认证。
- AgentHost 暴露 Claude agent 会话。
- Claude SDK 认为自己在调用 Anthropic API。
- 本地 proxy 将 Anthropic 请求转换为 Copilot CAPI 调用。
- Workbench 复用 Agent Sessions 的会话、工具、权限、子代理、恢复等 UI。

核心路径：

```text
Claude Agent SDK subprocess
  -> ANTHROPIC_BASE_URL=http://127.0.0.1:<proxy>
  -> IClaudeProxyService
  -> ICopilotApiService
  -> GitHub Copilot CAPI
```

相关源文件：

- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\roadmap.md`
- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\CONTEXT.md`
- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\claudeAgent.ts`
- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\claudeAgentSession.ts`
- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\claudeAgentSdkService.ts`

## 2. 当前总体状态

按 `roadmap.md` 当前标记：

- 已完成：Phase 1、1.5、2、3、4、5、6、7、8、8.5、9、10、10.5、12、13。
- 未完成或未落地：Phase 6.5 fork、Phase 11 customizations/plugins、Phase 14 hardening/telemetry、Phase 15 SDK distribution。
- 当前 checkout 分支为 `main`。
- 相关计划最近一次看到的提交为 `336d4b28ca9 Phase 10.5: unify ClaudeAgentSession lifecycle, retire ClaudeMaterializer (#317884)`。

重要判断：

- 这不是从零 backport Claude AgentHost；当前树里已经有相当完整的 Claude AgentHost 实现。
- 后续工作更像 productization / de-Copilotization / 补齐未落地 surface，而不是重写基础设施。
- 若在 Director replay 体系中承接，优先保持现有阶段边界：AgentHost core 放 `004-director-agent-engine`，Agent Sessions UI 放 `005-director-chat-built-in-mode`，包装/产品层放 `003-director-product-build-release`。

## 3. Phase 1-13 摘要

### Phase 1 - ICopilotApiService

实现 Copilot CAPI 的底层服务：

- 获取、缓存、失效 Copilot token。
- 调用 CAPI `messages` 和 `models`。
- 支持 streaming / non-streaming。
- 支持 abort 和 SSE body cancellation。

这是所有 proxy 转发的底座。

### Phase 1.5 - Raw Anthropic Event Stream

将 `ICopilotApiService.messages()` 从“文本 delta”升级为完整 `Anthropic.MessageStreamEvent` 流。

关键点：

- 使用 `@anthropic-ai/sdk` 类型。
- 保留完整 Anthropic event shape，供 Claude SDK / mapper 消费。
- `countTokens()` 加入接口，但 CAPI 没有真实 endpoint 时可 throw / 501。

### Phase 2 - IClaudeProxyService

实现本地 Anthropic 兼容 HTTP proxy：

- 入站暴露 `/v1/messages`、`/v1/models`、`/v1/messages/count_tokens`。
- 出站调用 `ICopilotApiService`。
- 绑定 `127.0.0.1` 和 ephemeral port。
- 使用 `Bearer <nonce>.<sessionId>` 做本地鉴权。
- 忽略用户自己的 `x-api-key`，避免误用 Anthropic personal key。
- 做 model id resolution 和 `anthropic-beta` 过滤。

这一 phase 不接 `IAgent`，只交付可被 SDK 指向的 proxy。

### Phase 3 - Ground SDK Contract

研究并固化官方 Copilot Claude 实现中的 SDK 契约。

重点是区分：

- Phase 4 启动 SDK 必需的 `Options`。
- 后续阶段才需要的 MCP、plugins、edit tracking、settings tracker、OTel、ripgrep、checkpoint 等。
- 哪些是 Claude SDK 的硬要求，哪些只是 Copilot extension 的历史包袱。

结论：生产实现是 reference，不是 blueprint。后续每个 phase 只引入它真正需要的 concern。

### Phase 4 - ClaudeAgent Skeleton

注册 `ClaudeAgent` provider 骨架：

- 实现 `IAgent` provider id / descriptor。
- 定义 session URI scheme，例如 `claude:/<sessionId>`。
- 声明 GitHub protected resource。
- `authenticate()` 保存 GitHub token，并懒启动 `IClaudeProxyService` handle。
- 将 Claude models 暴露给 root state。
- 其他未实现方法当时以 `TODO: Phase N` stub 形式占位。

这是让 workbench 能“看见 Claude agent”的最小接入。

### Phase 5 - Session Lifecycle

实现基本 session 生命周期：

- `createSession`
- `listSessions`
- `disposeSession`
- `shutdown`
- metadata overlay / sidecar DB
- SDK transcript store 作为 session truth

这一步让 Claude session 能被创建、列出、清理，并为后续恢复历史记录留出 seam。

### Phase 6 - sendMessage

实现第一版真正可对话的 `sendMessage`：

- 首次发送时 materialize provisional session。
- 启动 Claude SDK subprocess / WarmQuery / Query。
- 传入 proxy URL、bearer token、model、cwd、permission mode 等 Options。
- 将 SDK stream 映射成 AgentHost progress signals。
- 单轮文本对话可跑通。

范围刻意不含工具调用，只保证“能聊起来”。

### Phase 6.1 - Mapping Conformance Pass

补齐协议到 SDK 的映射一致性。

主要处理：

- session config bag 不丢失。
- model / permissionMode / effort 等字段从 `IAgentCreateSessionConfig` 正确流入 `Options`。
- runtime mutation 和 startup-only config 的边界更清晰。
- 校准 `CONTEXT.md` 中 M11 / M12 一类配置规则。

这是一个“把前面跑通的东西校正到协议语义上”的补洞阶段。

### Phase 6.5 - Fork

计划中的 fork 支持，目前仍延后。

关键原因：

- Claude SDK 的 `forkSession({ upToMessageId })` 要的是 SDK `SessionMessage.uuid`。
- AgentHost / workbench 常用的是 turn id。
- Phase 13 最终没有把 `turnId -> sdk message uuid` 作为 mapper 副产品暴露出来。
- 因此 Phase 6.5 若落地，需要在 fork 时自己读取 SDK transcript，重建目标 UUID。

当前代码中 `createSession({ fork })` 仍抛 `TODO: Phase 6.5`。

### Phase 7 - Tool Calls, Permission, User Input

实现 Claude SDK 工具调用和 AgentHost UI 的桥接：

- SDK `tool_use` / `tool_result` 映射为 AgentHost tool call signals。
- `canUseTool` 接 permission UI。
- `respondToPermissionRequest` 回写用户决策。
- `AskUserQuestion`、`ExitPlanMode` 等 interactive built-ins 接入 input request flow。
- 工具结果按 Anthropic `tool_result` 形式送回 SDK。

这是 Claude 从纯聊天变成真正 agent 的关键阶段。

### Phase 8 - File Edit Tracking

接入文件编辑跟踪：

- 观察 SDK / tool 对文件的读写。
- 映射为 AgentHost resource read/write 或相关 UI 能理解的文件变更。
- 利用 Claude SDK 的 checkpoint / file rewind 能力做验证。

目标是让工具改文件不只是静默发生，而能在会话 UI 中被追踪和展示。

### Phase 8.5 - Rich Tool Rendering

增强工具调用渲染，对齐 Copilot 的富 UI。

主要是 UX parity：

- 更好的工具名 / display name。
- 工具状态、结果、失败信息渲染。
- 子结构和 nested 工具显示更接近 Copilot。
- 给 Phase 12 subagent 的嵌套工具显示打基础。

### Phase 9 - Abort, Steering, Model Change, Shutdown Polish

实现长会话所需的控制面：

- abort / stop session。
- steering message / pending message。
- `changeModel` 以及 effort 等 model config 热切换。
- SDK subprocess crash recovery。
- yield-restart：当某些 startup-only 配置变化时，关闭当前 Query，用 `resume: sessionId` 重启。
- shutdown / dispose 顺序加固。

这是从“能跑 demo”到“可以持续 dogfood”的阶段。

### Phase 10 - Client-Provided Tools / In-Process MCP

将 workbench / client 提供的工具暴露给 Claude SDK：

- `setClientTools(session, clientId, tools)` 接收 AgentHost protocol 的工具定义。
- 转为 SDK `tool(...)`。
- 包装到 `createSdkMcpServer`。
- 通过 `Options.mcpServers` 注入 SDK。
- `onClientToolCallComplete` 把客户端执行结果回填到 SDK handler 的 pending promise。

关键设计：

- In-process MCP tools 是 `Options.mcpServers`，对 live Query 不可变。
- 工具列表变化时走 yield-restart，而不是 `Query.setMcpServers()`。
- 外部 MCP server 才是 `Query.setMcpServers()` 的 runtime hot-swap 桶。

### Phase 10.5 - Unified ClaudeAgentSession Lifecycle

Phase 10 后的结构性重构。

目标：

- 删除 `_provisionalSessions + _sessions` 双 map。
- 删除 `IClaudeProvisionalSession` 形态。
- 删除 `ClaudeMaterializer` 类。
- 由一个 `ClaudeAgentSession` 对象拥有自己的 provisional / materialized 生命周期。
- materialize、rebind、client tools、abort、dispose 的 race 由结构消解，而不是补偿代码兜底。

这是代码健康和竞态风险控制阶段，不改变 `IAgent` 外部 surface。

### Phase 11 - Customizations / Plugins

计划中还未落地的插件/自定义能力。

目标：

- `setClientCustomizations(...)` 调 `agentPluginManager.syncCustomizations`，将 `CustomizationRef[]` 同步为本地 plugin dirs。
- 下次 `query()` 时通过 `Options.plugins: [{ type: 'local', path }]` 注入 SDK。
- `setCustomizationEnabled(uri, enabled)` 不默认 restart，而是 defer-and-coalesce 到下一 yield boundary，调用 `Query.reloadPlugins()`。
- 只有 plugin 引发工具集合变化时，才走 yield-restart。
- 补齐 `onDidCustomizationsChange`、`getCustomizations()`、`getSessionCustomizations(session)` 等 Copilot parity surface。

当前代码中 `setClientCustomizations` 和 `setCustomizationEnabled` 仍是 `TODO: Phase 11`。

### Phase 12 - Subagents

实现 Claude SDK 子代理作为 AgentHost first-class 子会话：

- 识别 `Task` / `Agent` 工具产生的 subagent start。
- 发 `IAgentSubagentStartedSignal`。
- 使用 `<parent>/subagent/<toolCallId>` URI shape。
- 父会话中显示 subagent marker。
- 点击 marker 时，通过 `getSubagentMessages` 加载子代理 transcript。
- 处理 live 子代理内部 text / thinking / tool calls。
- 建立 `SubagentRegistry` / resolver strategy chain，解决 SDK 缺少 `(parentSessionId, toolCallId) -> agentId` 原生 API 的问题。

重要经验：

- `SessionMessage.parent_tool_use_id` 在 replay 路径不可用，经验上始终不能作为 join key。
- `forwardSubagentText: true` 必须设置，否则 live 子代理内容不完整。
- resolver 目前靠 TextSuffix / PromptMatch / LiveCapture / Native placeholder 分层策略。

### Phase 13 - Session Restoration

实现历史会话恢复：

- `getSessionMessages(session)` 从 SDK JSONL transcript 重建 AgentHost `Turn[]`。
- 不需要 live `Query`。
- 将 user text、assistant markdown/thinking/tool call、tool_result、system notification 映射回 AgentHost transcript。
- replay 中工具调用只还原终态，不还原 live streaming 状态。
- parent transcript 中的 subagent marker 可恢复；Phase 12 之后 marker 可进一步打开子代理 transcript。
- 明确不实现 `IAgent.truncateSession`，因为 Claude SDK fork 总是生成新 session id，和协议的 in-place truncate 语义不一致。

这一步让 AgentHost 重启后，Claude 历史会话还能显示和继续。

## 4. 当前最重要的接手点

### 第一优先级：Phase 11

Phase 11 是当前最自然的下一步，因为：

- Phase 10 / 10.5 已经把 client tools 和 session lifecycle 稳住。
- Phase 12 / 13 已经完成子代理和恢复。
- 代码里仍有明确 `TODO: Phase 11`。
- `CONTEXT.md` 已经给出 M6 / M11 的设计约束。

建议先写 `phase11-plan.md`，不要直接冲实现。

最小计划应包含：

- 文件清单。
- `agentPluginManager.syncCustomizations` 接入点。
- `Options.plugins` 如何保存在 `ClaudeAgentSession` 并进入 materialize / resume。
- `reloadPlugins()` 何时调用。
- 工具集合变化时如何触发 yield-restart。
- `getCustomizations()` / `getSessionCustomizations()` / `onDidCustomizationsChange` 的 source of truth。
- 单元测试、集成测试、手工 E2E 验收。

### 第二优先级：Phase 6.5 fork

如果用户关心 truncate / fork UX，再做 6.5。

注意不要把 Phase 13 mapper 改宽成 `{ turns, turnIdToLastAssistantUuid }`，原计划已经明确拒绝这个方向。fork 是冷路径，应在 fork 时读取 transcript，自行重建 `turnId -> SessionMessage.uuid`。

### 第三优先级：Phase 15

当前 SDK 仍通过用户配置路径加载：

- setting: `chat.agentHost.claudeAgent.path`
- env: `AgentHostClaudeSdkPathEnvVar`

这对开发可用，但对交付不可用。Phase 15 方向是通过 marketplace extension 分发 SDK 和 native deps。

### 第四优先级：Phase 14

Phase 14 是 hardening / telemetry：

- proxy request / response 计数。
- model usage / token usage / result metadata。
- SDK subprocess crash telemetry。
- abort storms / leak check。
- long-running session stress。
- 一轮 team dogfood。

## 5. 发现的计划/代码同步债

### 1. `getSessionMessages` 注释过期

`claudeAgent.ts` 的注释仍说 subagent URI 会 `TODO: Phase 12`，但代码实际已经调用 `getSubagentTranscript(...)`。

位置：

- `E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost\node\claude\claudeAgent.ts`
- 注释大约在 `getSessionMessages` 前。

建议：小清理，更新注释为 Phase 12 已接入，父 session 缺失时返回 `[]`。

### 2. Phase 10.5 的旧文案/历史引用残留

Phase 10.5 计划说旧 `_provisionalSessions` / `IClaudeProvisionalSession` / `ClaudeMaterializer` 应清掉。行为层面已基本落地，但 grep 仍能看到旧错误文案和历史注释，例如：

- `Cannot materialize unknown provisional session`
- 测试注释中的 `_provisionalSessions`
- phase plan 中的历史描述

这不一定是功能 bug，但若要让计划和代码更干净，可以做一轮文案级收尾。

### 3. Phase 11 没有独立 plan 文件

目录下有 `phase10-plan.md`、`phase10.5-plan.md`、`phase12-plan.md`、`phase13-plan.md`，但未看到 `phase11-plan.md`。

后续 agent 接手 Phase 11 前，建议先生成并 review 该 plan，避免把 plugins/customizations、client tools、external MCP 三个概念混在一起。

## 6. 容易踩坑的边界

### Client tools 与 plugins 不是同一个东西

- Client tools：Phase 10，走 in-process MCP，`Options.mcpServers`，工具列表变化通常 restart-required。
- Plugins/customizations：Phase 11，走 `Options.plugins` + `Query.reloadPlugins()`，默认 defer-and-coalesce，不是直接 restart。
- External MCP servers：未来若接，才更接近 `Query.setMcpServers()` hot-swap。

不要用 `reloadPlugins()` 解决 client tools 变化。

### Startup-only 与 runtime setter 要分清

Claude SDK 有两类配置面：

- `Options`：启动时传入，多数字段对 live Query 不可变。
- `Query` runtime methods：`setModel`、`setPermissionMode`、`applyFlagSettings`、`setMcpServers`、`reloadPlugins` 等。

如果字段只存在于 `Options`，变化通常要 yield-restart。

### Effort 的 `max` 是特殊值

`Options.effort` 支持 `max`，但 runtime `applyFlagSettings({ effortLevel })` 不支持 `max`。中途切换到 `max` 不能简单当热切换处理，要么降级到 `xhigh`，要么走 restart-required。

### Subagent replay 不要读 `SessionMessage.parent_tool_use_id`

经验验证：replay path 上该字段不能作为 join key。Subagent correlation 应走 resolver 策略层，而不是直接拿这个字段做关联。

### Director replay 侧不要扩大所有权

若把这些改动纳入 Director replay：

- 不要粗暴 claim `src/vs/platform/agentHost/**` 或 `src/vs/sessions/**`。
- broad glob 只用于发现，最终应缩成明确 touched files。
- 生成树可用于验证，但耐久改动应落到 replay patches / manifest / profile / reports 等源头。

## 7. 建议接手流程

1. 先读 `roadmap.md` 的 Phase 11 段和 `CONTEXT.md` 的 M6 / M11。
2. grep 当前 TODO：

```powershell
rg -n "TODO: Phase 11|setClientCustomizations|setCustomizationEnabled|reloadPlugins|getCustomizations|getSessionCustomizations|onDidCustomizationsChange" E:\Projects\Director-Code-batch\vscode\src\vs\platform\agentHost
```

3. 对照 `copilotAgent.ts` 的 customizations surface，但只借鉴 wiring pattern，不照搬 Copilot runtime 假设。
4. 先写 `phase11-plan.md`，明确文件清单、状态源、测试矩阵。
5. 再开始实现，保持小步提交。
6. 验证至少包含：

```powershell
npm run compile-check-ts-native
```

以及 agentHost 相关 unit / integration suite。具体命令以该 checkout 的 package scripts 和现有 plan 文件为准。

## 8. 快速结论

当前 Claude AgentHost 主线已经具备：

- proxy-backed Claude SDK 对话；
- AgentHost session 生命周期；
- streaming progress；
- tool calls / permissions / user input；
- file edit tracking；
- rich tool rendering；
- client-provided tools；
- unified session lifecycle；
- subagents；
- session restoration。

下一位 agent 最该接的是：

1. 先补 `phase11-plan.md`。
2. 再实现 Phase 11 customizations/plugins。
3. 按需要处理 Phase 6.5 fork。
4. 最后推进 Phase 14/15 的产品化硬化和 SDK 分发。
