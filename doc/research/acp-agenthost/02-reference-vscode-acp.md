# Reference: vscode-acp Extension

Updated: 2026-05-26

## Scope

This note summarizes `E:\Projects\sub-projects\vscode-acp`, a VS Code extension that connects to ACP agents.

The project is useful as a transport and lifecycle reference, but it is not a product-architecture template for this fork. It builds a custom extension UI. Our target is to integrate ACP agents into built-in AgentHost and Agent Sessions UI.

## What The Repository Is

`vscode-acp` is an extension-host ACP client. It contributes:

- an Activity Bar container;
- a sessions tree view;
- a chat webview;
- command palette commands;
- extension settings for configured ACP agents;
- an ACP registry browser;
- status/log/traffic commands.

Key files:

- `E:\Projects\sub-projects\vscode-acp\package.json`
- `E:\Projects\sub-projects\vscode-acp\src\extension.ts`
- `E:\Projects\sub-projects\vscode-acp\src\core\AgentManager.ts`
- `E:\Projects\sub-projects\vscode-acp\src\core\ConnectionManager.ts`
- `E:\Projects\sub-projects\vscode-acp\src\core\SessionManager.ts`
- `E:\Projects\sub-projects\vscode-acp\src\core\AcpClientImpl.ts`
- `E:\Projects\sub-projects\vscode-acp\src\handlers\PermissionHandler.ts`
- `E:\Projects\sub-projects\vscode-acp\src\handlers\FileSystemHandler.ts`
- `E:\Projects\sub-projects\vscode-acp\src\handlers\TerminalHandler.ts`
- `E:\Projects\sub-projects\vscode-acp\src\config\RegistryClient.ts`
- `E:\Projects\sub-projects\vscode-acp\src\ui\ChatWebviewProvider.ts`

## Lifecycle Reference

The extension demonstrates the basic ACP sidecar loop:

```text
read configured agent
        |
spawn command over stdio
        |
create JSON-RPC ACP connection
        |
initialize with client capabilities
        |
session/new with cwd and MCP servers
        |
session/prompt
        |
session/update notifications
        |
cancel / set mode / set model / disconnect
```

This flow is directly reusable as a conceptual adapter for AgentHost. The classes should not be copied as-is, because they depend on extension APIs and a custom UI architecture.

## Config And Discovery

The extension stores agents in the `acp.agents` setting. Defaults include commands for several ACP-capable agents such as Claude ACP, Gemini, Qwen, Auggie, Qoder, Codex ACP, OpenCode, and others.

The registry client fetches:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

The extension can browse registry entries, but the implementation observed is closer to listing/manual add than a complete managed install system. For built-in VS Code integration, registry install needs more product controls than this extension supplies.

## Transport Lessons

Useful patterns:

- spawn ACP process from command/args/env/cwd;
- use stdio as JSON-RPC transport;
- initialize with client capabilities;
- tap stderr for debug logs;
- detect process exit and clear active state;
- handle auth-required session creation by calling ACP `authenticate`, then retrying `session/new`;
- provide a callback surface for permission, file system, terminal, and session updates.

Windows-specific detail: `.cmd` launch and shell/PATH handling matter. The extension works around some shell loading problems, but built-in code should be stricter and less surprising than generic `shell: true`.

## UI Lessons

The custom webview renders:

- text chunks;
- thought/reasoning chunks;
- tool calls;
- tool updates;
- plans;
- mode/model changes;
- slash commands;
- attachments;
- errors.

For this fork, these are mapping hints only. We should publish ACP updates into AgentHost session state and let the existing Agents UI render them. A new ACP webview would duplicate the product shell and fight the AgentHost architecture.

## Auth Lessons

The extension assumes external CLIs own real auth. It reacts to ACP auth-required states, calls `authenticate({ methodId })`, and leaves account storage to the agent. It does not integrate with VS Code `AuthenticationService`, Secret Storage, or Director's runtime credential bridge.

That matches the re-anchored ACP requirement:

```text
VS Code UI invokes the external agent.
The external agent uses its own existing login, subscription, billing, and model routing.
```

It intentionally does not solve provider switching:

```text
Switch a third-party ACP agent between its own subscription/login and Director Providers.
```

That is now out of scope for this workstream. If revisited later, it requires a cooperative vendor contract, explicit env/config support, or a Director-owned ACP bridge.

## Permission/File/Terminal Risks

The extension advertises file and terminal capabilities and then handles requests directly with VS Code APIs or spawned child processes. This is too trusting for built-in adoption.

Built-in integration must add:

- workspace path containment;
- explicit permission prompts;
- policy gates for terminal and file write;
- cancellation behavior for pending permission requests;
- secret and prompt redaction in logs;
- no raw traffic logging by default;
- enterprise disable policy for external process execution.

## What To Reuse

Reuse conceptually:

- ACP process lifecycle;
- JSON-RPC connection setup;
- auth retry shape;
- session prompt/cancel flow;
- update-to-UI mapping categories;
- registry fetch/cache shape;
- handler names and callback taxonomy.

Do not reuse directly:

- Activity Bar container;
- webview chat UI;
- extension settings as the final source of truth;
- raw terminal/file handlers;
- `npx @latest` defaults;
- raw protocol traffic logging;
- auth assumptions for Director or Copilot-adjacent code.

## Fit For This Fork

`vscode-acp` answers "how does a VS Code extension talk to ACP agents?" It does not answer "how should this VS Code fork productize ACP agents?"

The fork-specific answer should be:

```text
Workbench settings/registry UI
        |
secret-free ACP agent config snapshot
        |
AgentHost node ACP runtime adapter
        |
IAgent provider(s)
        |
existing Agent Sessions UI
```

The extension is most valuable for the sidecar adapter, not for UI.
