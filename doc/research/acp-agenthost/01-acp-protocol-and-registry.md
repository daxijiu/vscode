# ACP Protocol And Registry Research

Updated: 2026-05-26

## Scope

This note summarizes the official Agent Client Protocol (ACP) docs, the local protocol repo at `E:\Projects\sub-projects\agent-client-protocol`, and the local registry repo at `E:\Projects\sub-projects\registry`.

Primary sources:

- Official docs: <https://agentclientprotocol.com/get-started/introduction>
- Architecture: <https://agentclientprotocol.com/get-started/architecture>
- Transports: <https://agentclientprotocol.com/protocol/transports>
- Initialization: <https://agentclientprotocol.com/protocol/initialization>
- Authentication: <https://agentclientprotocol.com/protocol/authentication>
- Session setup: <https://agentclientprotocol.com/protocol/session-setup>
- Prompt turn: <https://agentclientprotocol.com/protocol/prompt-turn>
- Tool calls: <https://agentclientprotocol.com/protocol/tool-calls>
- File system: <https://agentclientprotocol.com/protocol/file-system>
- Terminals: <https://agentclientprotocol.com/protocol/terminals>
- Registry: <https://agentclientprotocol.com/get-started/registry>
- Registry JSON: <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
- Local protocol repo: `E:\Projects\sub-projects\agent-client-protocol`
- Local registry repo: `E:\Projects\sub-projects\registry`

## What ACP Is

ACP is an editor-to-agent protocol. It is not an LLM provider API.

The ACP client is the editor. The ACP server is a coding agent process. The editor launches or connects to the agent, negotiates protocol/capabilities, creates sessions, sends prompt turns, receives streamed session updates, and mediates side effects such as file access, terminal access, permission prompts, authentication, and optional session restore.

For this VS Code fork, that means ACP agents should become optional AgentHost agents. They should sit beside Copilot, Claude, and Director as `IAgent` providers. Each ACP agent should keep using its own subscription, login, billing, and model routing. They should not become entries in the Director Provider Backend Hub, because Director Providers represent model-provider routing, while ACP represents complete external agent runtimes.

## Stable Version And Transport

The local ACP repo identifies stable protocol version `1`. The repo also contains v2 material, but it is draft/unstable and should not be the first implementation target.

The standard local transport is newline-delimited JSON-RPC over stdio. The editor owns:

- process launch;
- cwd/env construction;
- stdin/stdout framing;
- stderr capture;
- timeout, restart, and kill behavior;
- JSON-RPC request/response correlation;
- initialization and capability negotiation;
- cancellation cleanup.

One ACP process can support multiple sessions if the agent supports it, but implementations vary. The first VS Code slice should be conservative: one configured ACP agent connection with one active session path, then expand to multi-session once compatibility is proven.

## Core Lifecycle

The common ACP flow is:

1. VS Code launches an agent command from manual config or registry metadata.
2. VS Code calls `initialize` with protocol version, client info, and client capabilities.
3. The agent returns negotiated protocol info, agent capabilities, optional auth methods, and optional metadata.
4. VS Code authenticates if the agent requires it.
5. VS Code calls `session/new` with an absolute `cwd` and MCP server configuration.
6. VS Code calls `session/prompt` with the user prompt.
7. The agent streams `session/update` notifications for assistant chunks, thoughts, tool calls, tool updates, plan/status/mode/model updates, usage, and completion.
8. VS Code may call `session/cancel`.
9. Optional capabilities may add session list/load/resume/close/delete and config/mode/model changes.

The critical implementation point is that ACP updates are incremental. The AgentHost bridge must not wait for a final response before publishing UI state. It needs a streaming mapper from ACP update variants into AgentHost session actions.

## Capabilities

ACP capabilities are the boundary between an external agent and editor-owned resources.

Client-side capabilities include:

- file read;
- file write;
- terminal create/output/wait/kill/release;
- permission requests;
- optional model/mode/config support;
- optional MCP forwarding.

Agent-side capabilities vary. A client must capability-gate optional calls and not assume a registry entry supports every method. This matters for Cursor/CodeBuddy compatibility because version drift can affect session restore, model selection, permission flows, and MCP behavior.

## Messages And Tool Calls

ACP message content follows MCP-like content blocks. Text is baseline. Images, audio, embedded resources, and resource links are capability-sensitive.

Tool calls are not just text. They are streamed session updates with state transitions, content, diffs, terminal data, and permission relationships. For this VS Code fork, the hard part is not rendering text; it is preserving ordering and state across:

- assistant text chunks;
- reasoning/thought chunks;
- tool-call start/update/finish;
- permission prompts;
- file edits;
- terminal output;
- cancellation;
- final stop reason.

The correct target is AgentHost's existing session action model, not a new ACP-specific webview.

## Authentication

ACP auth is agent-scoped. During `initialize`, an agent can advertise `authMethods`. The client may call `authenticate`. Even after initialization, `session/new` can fail with an auth-required error, so the bridge needs an auth retry path.

The registry currently requires agents to support either Agent Auth or Terminal Auth. The docs also discuss environment-variable auth patterns, but registry validation focuses on agent/terminal auth methods.

This auth model should stay separate from Director Provider auth and subscription state:

- ACP agent auth belongs to the external agent vendor or command.
- ACP agent subscription and billing state also belongs to that external agent vendor.
- Director Provider auth belongs to the Director provider registry, Secret Storage, and runtime credential bridge.
- VS Code should not hand arbitrary Director API keys or OAuth tokens to a third-party ACP agent in this workstream.

## Registry Shape

The ACP registry is a launch/install catalog, not a model registry.

Agent metadata includes identity, display fields, repository/website/license/icon, authors, auth methods, and distribution. Distribution types observed in the local registry include:

- `binary`;
- `npx`;
- `uvx`.

Binary distributions are platform-specific and provide archive URLs, commands, args, and env. NPM/NPX distributions specify package names and launch args.

Useful local registry examples:

- `E:\Projects\sub-projects\registry\cursor\agent.json`
- `E:\Projects\sub-projects\registry\codebuddy-code\agent.json`
- `E:\Projects\sub-projects\registry\codex-acp\agent.json`
- `E:\Projects\sub-projects\registry\claude-acp\agent.json`
- `E:\Projects\sub-projects\registry\github-copilot\agent.json`

Important limitation: the registry schema does not provide a complete supply-chain trust story. Download URLs, NPX packages, and command execution need explicit VS Code trust UX, version pinning, cache boundaries, checksum/signature strategy, and enterprise disable policy before productizing automatic install.

## Implications For This Fork

ACP should enter through AgentHost:

```text
VS Code Agent Sessions UI
        |
AgentHost root state / session state
        |
ACP IAgent provider
        |
ACP stdio JSON-RPC transport
        |
External ACP agent process
        |
Vendor-owned subscription/login/model/runtime
```

Director should remain separate:

```text
Director IAgent provider
        |
Director AgentEngine adapter
        |
Director Provider Backend Hub
        |
Director API key / OAuth / local provider runtime
```

The two lines can coexist, but they should not be collapsed. ACP is an agent runtime protocol. Director Providers are model-provider backends.

## Risk Register

| Risk | Level | Notes |
| --- | --- | --- |
| File/terminal side effects | High | ACP can ask VS Code to read/write files and operate terminals. This must go through AgentHost permission UI, workspace containment, audit logs, cancellation cleanup, and redaction. |
| Registry install supply chain | High | Registry entries can point at binaries or package managers. Avoid silent install/execute. |
| Auth mismatch | Medium-high | ACP auth is vendor-owned. Director auth is Secret Storage-backed and should not leak into arbitrary ACP agents. |
| Protocol/event impedance | Medium-high | ACP session updates must map into AgentHost actions without duplicated chunks, hung tools, or lost cancellation. |
| Version drift | Medium | Implement ACP v1 first and capability-gate optional v2/unstable methods. |
| Process lifecycle | Medium | Need parse-error recovery, stderr handling, process kill on dispose, and per-agent connection cache policy. |

## Recommended First Interpretation

Treat ACP as an optional external agent rail:

- manual command configuration first;
- v1 protocol only;
- conservative client capabilities at first;
- no registry install in the first runtime slice;
- no Director Provider credential injection into third-party ACP agents;
- no generic provider switching goal;
- focus implementation difficulty on VS Code-native UI adaptation, permission mediation, and external-agent lifecycle.
