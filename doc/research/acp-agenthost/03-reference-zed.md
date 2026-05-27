# Reference: Zed ACP External Agents

Updated: 2026-05-26

## Scope

This note summarizes `E:\Projects\sub-projects\zed`, which has a mature ACP external-agent implementation. Zed is not VS Code, but it is the strongest reference for productizing ACP agents inside an editor instead of only as a standalone extension.

## What The Repository Does

Zed treats ACP agents as external agent runtimes. Registry/settings produce an agent command; a connection store launches and caches the ACP subprocess; ACP sessions are mapped into Zed's conversation/thread model; UI surfaces external agents alongside native agents.

Important files and crates:

- `E:\Projects\sub-projects\zed\Cargo.toml`
- `E:\Projects\sub-projects\zed\crates\agent_servers\src\acp.rs`
- `E:\Projects\sub-projects\zed\crates\agent_servers\src\custom.rs`
- `E:\Projects\sub-projects\zed\crates\project\src\agent_registry_store.rs`
- `E:\Projects\sub-projects\zed\crates\project\src\agent_server_store.rs`
- `E:\Projects\sub-projects\zed\crates\agent_ui\src\agent_connection_store.rs`
- `E:\Projects\sub-projects\zed\crates\agent_ui\src\agent_registry_ui.rs`
- `E:\Projects\sub-projects\zed\crates\agent_ui\src\agent_panel.rs`
- `E:\Projects\sub-projects\zed\crates\agent_ui\src\conversation_view.rs`
- `E:\Projects\sub-projects\zed\crates\acp_thread\src\acp_thread.rs`
- `E:\Projects\sub-projects\zed\crates\acp_thread\src\connection.rs`
- `E:\Projects\sub-projects\zed\crates\acp_thread\src\terminal.rs`
- `E:\Projects\sub-projects\zed\crates\acp_tools\src\acp_tools.rs`
- `E:\Projects\sub-projects\zed\docs\src\ai\external-agents.md`
- `E:\Projects\sub-projects\zed\docs\src\extensions\agent-servers.md`

## Architecture Pattern

Zed's shape can be summarized as:

```text
Agent registry/settings UI
        |
Agent server store
        |
Connection store
        |
ACP process + JSON-RPC bridge
        |
ACP thread adapter
        |
Conversation UI
```

The closest VS Code equivalent should be:

```text
Workbench registry/settings UI
        |
secret-free ACP config snapshot
        |
AgentHost node ACP connection store
        |
ACP process + JSON-RPC bridge
        |
IAgent / session action adapter
        |
Agent Sessions UI
```

The important lesson is separation of concerns. Zed does not treat external ACP agents as normal model providers. It treats them as agent runtimes with their own process, auth, and lifecycle.

## Registry And Install

Zed fetches the ACP registry from:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

It caches registry JSON and icons, selects platform-specific binary distributions, handles NPX commands, tracks refresh state/errors, and supports registry/custom sources.

For this VS Code fork, Zed suggests a staged approach:

1. Start with custom/manual commands.
2. Add registry browsing after the runtime bridge works.
3. Add managed install only after trust, version pinning, cache cleanup, checksums/signatures, and enterprise policy are designed.

The registry UI is not the hard part. The protocol-to-AgentHost lifecycle and side-effect mediation are harder.

## Connection Lifecycle

Zed caches one connection per external agent, resets connections when config/version changes, captures stderr/logs, and exposes debug tooling.

For VS Code, the matching design is an AgentHost node service that owns:

- configured ACP agents;
- process handles;
- initialized ACP connections;
- session mappings;
- stderr and protocol logs with redaction;
- disposal/kill on shutdown;
- restart after config/version changes.

This should live in AgentHost node, not Workbench, because the process and session runtime are backend concerns.

## Session And Event Mapping

Zed maps ACP session updates into its thread UI:

- user messages;
- assistant chunks;
- thoughts;
- tool calls;
- tool updates;
- plans;
- config changes;
- mode changes;
- usage;
- titles;
- auth states.

This maps cleanly to the VS Code requirement: build an ACP-to-AgentHost action adapter. The existing AgentHost session state should remain the UI contract.

## Auth Lessons

Zed's docs and implementation keep external-agent auth separate. External agent billing, legal terms, accounts, and credentials belong to the external provider.

Zed may pass environment variables, invoke terminal auth, or trigger ACP auth, but it does not present external agents as Zed-hosted model providers.

For this fork, that supports the baseline design:

- Cursor ACP uses Cursor login or Cursor API key.
- CodeBuddy ACP uses CodeBuddy login/API key/environment.
- Director Provider Backend remains a different auth system.

## Debug Surface

Zed has ACP log tooling that shows incoming/outgoing JSON-RPC plus stderr. This is useful, but dangerous if copied naively.

VS Code should have a debug/log surface eventually, but it must redact:

- prompts;
- file contents;
- API keys;
- bearer tokens;
- env values that may contain secrets;
- terminal output likely to include credentials.

A product default should not raw-log protocol traffic.

## Lessons For This Fork

Zed strongly supports these decisions:

- put ACP runtime in AgentHost node;
- use Workbench for settings, registry, install/auth UI, and secret references;
- publish agents into existing AgentHost root state;
- do not duplicate chat UI;
- keep external-agent auth separate from model-provider auth;
- add registry later, after custom command support;
- treat file/terminal capabilities as high-risk features, not baseline free wins.

## Difficulty Signals From Zed

| Area | Difficulty | Why |
| --- | --- | --- |
| Settings/custom command | Low-medium | Schema/UI work, not much protocol complexity. |
| Process/stdio transport | Medium | Windows, remote, stderr, restart, parse errors, cwd/env. |
| Connection cache | Medium | Need lifecycle and config invalidation. |
| Auth | Medium-high | ACP auth, terminal auth, env redaction, account state. |
| File/terminal bridge | High | Permission, containment, output streaming, cancellation. |
| Session restore | High | ACP support varies by agent and version. |
| Registry install | High/security | Supply chain, trust, version pinning, enterprise policy. |

## Recommended Borrowed Pattern

Use Zed as the product-shape reference:

```text
custom ACP command first
        |
AgentHost connection store
        |
streaming session update adapter
        |
auth-required UX
        |
permission-gated file/terminal capabilities
        |
registry browse/install
```

Do not start with registry install. Do not start with provider switching. Start with one known local ACP command and prove AgentHost lifecycle compatibility.
