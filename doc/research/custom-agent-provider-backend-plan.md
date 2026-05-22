# 自定义 Agent Harness 与 Provider Backend 接入计划

## 目标

在现有 VS Code AgentHost / Agent Sessions UI 体系下，接入一个或多个自定义 agent harness，并新增统一的 Provider Backend 层。

该 Provider Backend 支持用户配置多种后端：

- OAuth provider
- API key provider
- OpenAI-compatible provider
- Anthropic-compatible provider
- 本地或第三方开源 provider
- 自定义 HTTP / CLI / runtime provider

同时，该后端应能替换除 Copilot 相关路径之外的第三方 agent 后端。

Copilot、Copilot Cloud、Copilot CLI、GitHub Copilot 账号验证与 CAPI 路径保持隔离，不纳入替换范围。

## 总体架构

```text
VS Code Agent UI / Agent Sessions
        |
AgentHost IAgent Provider
        |
Agent Harness Adapter Layer
        |
Provider Backend Hub
        |
OAuth / API Key / Local / Third-party Provider
```

## 核心原则

1. 不改主 Chat UI。
2. 不复用 Copilot token、Copilot CAPI 或 GitHub entitlement。
3. Harness 不直接管理密钥。
4. Provider、Auth、Model 统一由 Provider Backend Hub 管理。
5. 新增 agent harness 时只写 adapter。
6. 新增模型服务商时只写 provider backend。
7. AgentHost 只看到统一的 session、model、tool、auth 状态。

## 范围划分

### 保留原样

- GitHub Copilot
- Copilot Cloud
- Copilot CLI
- Copilot extension 内部账号、订阅、token、CAPI 逻辑

### 可替换后端

- Claude-like harness
- 自定义 agent harness
- 第三方 CLI agent
- 开源 agent runtime
- Anthropic / OpenAI-compatible agent runtime
- 未来新增的非 Copilot agent

## 模块设计

### 1. AgentHarnessAdapter

负责把某个 agent harness 接入 AgentHost。

接口职责：

- 创建 session
- 恢复 session
- 发送用户消息
- 中止任务
- 切换模型
- 接收流式事件
- 映射 tool call
- 映射文件变更
- 映射 usage / error / status

示例接口：

```ts
interface AgentHarnessAdapter {
  readonly id: string;
  readonly displayName: string;

  createSession(config: HarnessSessionConfig): Promise<HarnessSession>;
  sendMessage(sessionId: string, message: HarnessMessage): Promise<void>;
  abort(sessionId: string): Promise<void>;
  changeModel(sessionId: string, model: ProviderModel): Promise<void>;
  listSessions(): Promise<HarnessSessionSummary[]>;
}
```

### 2. ProviderBackendHub

统一管理所有非 Copilot provider。

职责：

- provider 注册
- OAuth token 管理
- API key 管理
- base URL 管理
- model list 拉取
- capability 描述
- request adapter
- token refresh
- secret storage 读写

Provider 类型：

```text
api-key
oauth
openai-compatible
anthropic-compatible
local
custom-http
custom-cli
```

### 3. ProviderBackend

单个 provider 的运行时抽象。

```ts
interface ProviderBackend {
  readonly id: string;
  readonly displayName: string;
  readonly authType: 'apiKey' | 'oauth' | 'none';

  listModels(): Promise<ProviderModel[]>;
  createClient(auth: ProviderAuthState): Promise<ProviderClient>;
  testConnection(): Promise<ProviderConnectionResult>;
}
```

### 4. Auth Bridge

负责把用户配置的 OAuth / API key 注入 Provider Backend Hub。

OAuth 路径：

```text
ProtectedResourceMetadata
        |
agentHostAuth.ts
        |
VS Code AuthenticationService
        |
IAgent.authenticate(resource, token)
        |
ProviderBackendHub
```

API key 路径：

```text
Provider Settings UI
        |
VS Code Secret Storage
        |
ProviderBackendHub
```

### 5. AgentHost Bridge

新增一个非 Copilot 的 `IAgent` provider，作为所有自定义 harness 的统一入口。

职责：

- 向 AgentHost 暴露 provider descriptor
- 向 UI 暴露 models
- 处理 OAuth protected resources
- 创建 session
- 根据 harness / provider / model 路由请求
- 把 harness event stream 映射成 AgentHost session state

## 用户侧交互

### Provider 配置 UI

需要支持：

- Add Provider
- Edit Provider
- Delete Provider
- Test Connection
- OAuth Login
- API Key 输入
- Base URL 输入
- Refresh Models
- 选择默认模型

配置内容：

```text
provider id
display name
provider type
auth type
base URL
OAuth issuer
OAuth scopes
model list strategy
capabilities
```

密钥和 token 不进入普通 JSON 配置，只进入 Secret Storage。

### Agent 创建 UI

用户创建 agent session 时选择：

```text
harness
provider
model
working directory
permission mode
tool policy
session config
```

这些选项通过 AgentHost 现有 config chips / picker 体系暴露，不单独重写 Chat UI。

## 实施阶段

### Phase 1：协议和边界确认

目标：确定非 Copilot agent 的统一抽象。

任务：

- 定义 `AgentHarnessAdapter`
- 定义 `ProviderBackend`
- 定义 `ProviderBackendHub`
- 定义 provider config schema
- 明确 Copilot exclusion policy
- 明确 session state / tool call / error / usage 映射格式

产出：

- 架构接口定义
- provider 配置 schema
- harness adapter contract
- Copilot 隔离规则

### Phase 2：Provider Backend Hub

目标：先做统一 provider 后端。

任务：

- 实现 provider registry
- 实现 API key provider
- 实现 Secret Storage 集成
- 实现 model list refresh
- 实现 connection test
- 实现 provider capabilities
- 预留 OAuth provider 接口

产出：

- 可配置 API key provider
- 可拉取模型
- 可测试连接
- provider metadata 可供 AgentHost 使用

### Phase 3：自定义 AgentHost Provider

目标：把 Provider Backend Hub 暴露给现有 AgentHost UI。

任务：

- 新增非 Copilot `IAgent`
- 注册到 `agentHostMain`
- 暴露 descriptor / models / protected resources
- 实现 `createSession`
- 实现 `sendMessage`
- 实现 `changeModel`
- 实现 `abort`
- 实现 `resolveSessionConfig`

产出：

- Agent Sessions UI 中可看到自定义 agent
- 可选择 provider / model
- 可创建 session
- 可发送消息

### Phase 4：接入第一个自定义 Harness

目标：接入已经实现的 Claude-like harness。

任务：

- 实现 `CustomHarnessAdapter`
- 把 provider client 注入 harness
- 映射 harness event stream
- 映射 tool calls
- 映射 terminal / search / subagent / file-change
- 映射 usage 和 error
- 实现 session restore

产出：

- 自定义 harness 可以复用 AgentHost UI
- 不走 Copilot CAPI
- 后端由 Provider Backend Hub 提供

### Phase 5：OAuth Provider

目标：支持用户自定义 OAuth provider。

任务：

- 实现 OAuth provider config
- 实现 VS Code `AuthenticationProvider`
- 接入 `ProtectedResourceMetadata`
- 接入 `IAgent.authenticate`
- 支持 token refresh
- 支持 logout / re-auth
- 支持 OAuth provider model refresh

产出：

- 用户可以添加 OAuth provider
- Agent session 可以使用 OAuth provider 后端
- token 不暴露给 UI 或普通配置文件

### Phase 6：替换第三方 Agent 后端

目标：把非 Copilot 第三方 agent 从各自后端切到 Provider Backend Hub。

任务：

- 识别所有非 Copilot agent / harness
- 为每个 harness 写 adapter
- 移除对 Copilot CAPI 的后端依赖
- 替换模型列表来源
- 替换 token / API key 来源
- 统一 tool / event / session 映射

产出：

- Claude-like harness 后端可替换
- 未来第三方 harness 只需新增 adapter
- Provider Backend Hub 成为统一后端入口

### Phase 7：持久化与恢复

目标：保证 session、provider、auth 状态可恢复。

任务：

- provider config 持久化
- secret 持久化
- session URI 设计
- session list restore
- event log restore
- model / provider missing 时的降级提示
- auth expired 时的重新登录流程

产出：

- 重启后 provider 可用
- 重启后 session 可恢复
- token 过期时有明确恢复路径

### Phase 8：验证

目标：确认 UI、auth、runtime、工具调用稳定。

验证项：

- API key provider 创建成功
- OAuth provider 登录成功
- model list 正确刷新
- 自定义 harness session 可创建
- 消息流式输出正常
- tool call UI 正常
- terminal / search / subagent 类型展示正常
- abort 正常
- change model 正常
- session restore 正常
- Copilot 路径不受影响

建议命令：

```bash
npm run compile-check-ts-native
npm run valid-layers-check
```

如修改 Copilot extension 相关代码，再补充：

```bash
npm --prefix extensions/copilot run typecheck
```

## 风险点

### 1. ClaudeProxyService 不应直接泛化成唯一方案

`ClaudeProxyService` 适合参考 Anthropic-compatible proxy 形状，但它当前绑定 Copilot CAPI。长期方案应抽象为 provider backend，而不是把所有 provider 都塞进 Claude proxy。

### 2. OAuth 不只是 AgentHost 声明 resource

如果 OAuth issuer 不是已有 GitHub / Microsoft provider，还必须实现 VS Code `AuthenticationProvider`，否则 AgentHost 无法拿到 token。

### 3. AgentHost language model provider 不是普通 chat request provider

AgentHost models 主要用于 agent session picker，不应假设它能直接替代普通 chat language model request。

### 4. 多 provider token fan-out

如果多个 provider 共用同一个 protected resource，`authenticate` 可能触发多个 provider 副作用。自定义 provider 应使用自己的 resource id。

### 5. Harness 与 Provider 不要强耦合

错误设计：

```text
ClaudeHarness -> AnthropicProvider
OpenAIHarness -> OpenAIProvider
LocalHarness -> LocalProvider
```

推荐设计：

```text
Any Harness -> ProviderBackendHub -> Any Compatible Provider
```

## 最终形态

```text
Agent Sessions UI
        |
Custom AgentHost Provider
        |
Harness Router
        |
+--------------------------+
| Custom Harness Adapter   |
| Claude-like Adapter      |
| Third-party CLI Adapter  |
| Open-source Agent Adapter|
+--------------------------+
        |
Provider Backend Hub
        |
+--------------------------+
| API Key Provider         |
| OAuth Provider           |
| OpenAI-compatible        |
| Anthropic-compatible     |
| Local Provider           |
| Custom HTTP Provider     |
+--------------------------+
```

最终新增第三方 agent 时，只需要：

1. 新增一个 harness adapter。
2. 复用已有 Provider Backend Hub。
3. 复用现有 AgentHost UI。

最终新增模型服务商时，只需要：

1. 新增一个 provider backend。
2. 配置 auth / model / capabilities。
3. 所有兼容 harness 自动可用。
