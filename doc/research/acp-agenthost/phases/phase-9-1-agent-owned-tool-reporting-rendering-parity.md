# Phase 9.1 - Agent-Owned Tool Reporting And VS Code UI Parity

Updated: 2026-05-28

## Goal

Correct the Phase 6A/Phase 9 boundary and align the implementation with the existing ACP clients we reviewed.

Supported local ACP agents already know how to use their own accounts, tools, file access, shell commands, and model routing when launched from a terminal. The VS Code integration should not reduce those capabilities. Its job is to adapt ACP events and client-method requests into native VS Code AgentHost UI.

This phase therefore has two tracks:

1. **Agent-owned reporting/rendering parity** - the agent executes its own tools and reports lifecycle/content through ACP `session/update`; VS Code renders that in AgentHost UI.
2. **VS Code client bridge parity** - when the agent asks the client to provide `fs/*` or `terminal/*`, VS Code implements those methods through native file/editor/terminal services and advertises the matching `clientCapabilities`.

## Reference Implementations Reviewed

### `E:\Projects\sub-projects\vscode-acp`

Key files:

- `src/core/ConnectionManager.ts` - builds fs, terminal, and permission handlers, then advertises `fs.readTextFile`, `fs.writeTextFile`, and `terminal: true`.
- `src/core/AcpClientImpl.ts` - dispatches `session/request_permission`, `session/update`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release`.
- `src/handlers/FileSystemHandler.ts` - reads unsaved open editor content or `workspace.fs`, supports line/limit, writes with `workspace.fs`, then opens the file.
- `src/handlers/TerminalHandler.ts` - runs commands, keeps output buffers, exposes wait/output/kill/release, and creates a VS Code pseudo terminal for display.
- `src/handlers/PermissionHandler.ts` - shows the ACP-provided permission options with VS Code QuickPick and returns the selected `optionId`.
- `src/ui/ChatWebviewProvider.ts` - turns `tool_call` into an inline tool row and `tool_call_update` into status updates.

Takeaway: `vscode-acp` treats agent-owned tool calls as UI events, not as client execution. It separately implements full client fs/terminal handlers.

### `E:\Projects\sub-projects\zed`

Key files:

- `crates/agent_servers/src/acp.rs` - ACP stdio connection, client capabilities, session updates, permission handling, fs and terminal client methods.
- `crates/acp_thread/src/acp_thread.rs` - thread state, tool call model, permission waits, file actions, plans, checkpoints.
- `crates/acp_thread/src/terminal.rs` - ACP terminal entity, output retention/truncation, exit/wait behavior.
- `crates/acp_thread/src/diff.rs` - ACP diff content and edit display model.
- `crates/agent_ui/src/conversation_view/thread_view.rs` - native conversation UI for tool cards, terminal cards, permissions, diff/content rendering.
- `crates/agent_ui/src/agent_panel.rs` - external agent entry points and registry browse surface.
- `crates/project/src/agent_server_store.rs` - custom/registry command resolution and external agent list.
- `crates/project/src/agent_registry_store.rs` - registry metadata, icons/cache/install metadata.
- `docs/src/ai/external-agents.md` - product wording: external agents keep their own accounts, configuration, billing, and tools.

Takeaway: Zed maps ACP into its native agent thread, not into a separate ACP webview. It preserves rich `tool_call` data (`kind`, `status`, `content`, `raw_input`, `raw_output`, `locations`, `tool_name`), renders diff and terminal content, and implements narrow but real local client fs/terminal methods.

### `E:\Projects\sub-projects\agent-client-protocol` and `E:\Projects\sub-projects\registry`

Key files:

- `docs/protocol/tool-calls.mdx`
- `docs/protocol/file-system.mdx`
- `docs/protocol/terminals.mdx`
- `docs/protocol/initialization.mdx`
- `src/v1/tool_call.rs`
- `src/v1/client.rs`
- `E:\Projects\sub-projects\registry\FORMAT.md`
- `E:\Projects\sub-projects\registry\agent.schema.json`

Takeaway: ACP tool calls are agent-owned execution reports. Client filesystem and terminal methods are optional client capabilities that must be advertised only when implemented. Registry distribution metadata tells the client how to launch/install an agent; it does not describe or constrain the agent's internal tool capabilities.

## Corrected Model

### Layer 1 - Agent-Owned Tool Reporting

- The vendor ACP agent executes tools in its own process, just as it would when launched from an integrated terminal.
- The agent reports progress, results, file locations, diffs, terminal references, raw input/output summaries, plans, commands, and modes through ACP updates.
- VS Code must render these updates through AgentHost-native transcript/tool/diff/terminal/permission UI.
- This must not depend on `externalAcpAgents.capabilities.files.enabled` or `externalAcpAgents.capabilities.terminal.enabled`; those settings are for client-provided bridges.

### Layer 2 - VS Code Client-Provided Bridges

- The agent asks VS Code to perform client methods such as `fs/read_text_file`, `fs/write_text_file`, or `terminal/*`.
- VS Code advertises these only when the corresponding local bridge is implemented.
- These methods should be implemented for local desktop/workspace using native VS Code editor/file/terminal surfaces, following `vscode-acp` and Zed as references.

## Entry Criteria

- Phase 0-9 are complete.
- The first-release matrix remains local desktop + local workspace + local pre-installed/pre-authenticated ACP CLI.
- External ACP agents are explicitly enabled and trusted before spawn.
- Managed install and remote runtime placement remain out of scope.

## Scope

- Replace Phase 6A "unsupported/redacted" tool rendering with useful AgentHost-native rendering.
- Preserve ACP `tool_call` / `tool_call_update` fields:
  - `toolCallId`;
  - `title`;
  - `kind`;
  - `status`;
  - `content`;
  - `locations`;
  - safe display summaries of `rawInput` / `rawOutput`;
  - vendor/tool name metadata when present.
- Map ACP tool kinds to native AgentHost presentation:
  - `read` -> file/read style;
  - `edit`, `delete`, `move` -> file/diff/edit style;
  - `search` -> search style;
  - `execute` -> command/terminal style;
  - `think` -> reasoning/tool-thought style;
  - `fetch` and `other` -> generic tool style.
- Render ACP tool content:
  - text/markdown content as tool result content;
  - diff content as VS Code diff/review content where possible;
  - terminal content as terminal output when backed by a VS Code-created ACP terminal id, otherwise command-style tool content;
  - resource links and locations as navigable VS Code resources when local and safe.
- Implement ACP permission passthrough:
  - show agent-provided options in native permission UI;
  - return the selected `optionId`;
  - return `cancelled` on turn cancellation;
  - do not default-deny every trusted local agent permission request.
- Implement local VS Code client fs bridge:
  - advertise `fs.readTextFile` only when read handler is active;
  - read unsaved editor contents when available;
  - fall back to workspace/file service reads;
  - support line/limit;
  - enforce local workspace containment and local-only release matrix.
- Implement local VS Code client write bridge:
  - advertise `fs.writeTextFile` only when write handler is active;
  - write through VS Code file/editor/edit services;
  - surface changed files through AgentHost changeset/diff/review UI where available;
  - keep accept/reject or revert semantics aligned with existing AgentHost edit surfaces.
- Implement local VS Code terminal bridge:
  - advertise `terminal: true` only when terminal handler is active;
  - create managed local terminals through AgentHost/terminal services;
  - support output, wait for exit, kill, and release;
  - link terminal content embedded in ACP tool calls to the created terminal id;
  - enforce local cwd and output retention/truncation.
- Keep diagnostics local and redacted:
  - user-facing session UI may show agent/tool output;
  - process diagnostics must still omit prompts, raw tool args/output, file contents, terminal output, tokens, raw stderr, and env values by default.

## Non-Goals

- No managed install, package-manager execution, download, extraction, or auto-update.
- No remote, WSL, dev container, Codespaces, or server-side ACP runtime placement.
- No vendor-side delete/archive.
- No broad enterprise policy metadata beyond existing settings-level gates.
- No separate ACP webview chat UI.
- No treating registry metadata as trusted executable authority.
- No blanket persistence of raw tool input/output into logs or diagnostics.

## Implementation Plan

### 9.1A - Agent-Owned Tool Reporting And Permission UI

1. Rename policy/copy language
   - Make `externalAcpAgents.capabilities.*` descriptions clearly refer to VS Code client-provided bridges.
   - Remove user-visible "Phase 6A does not execute tools" messages from AgentHost transcript content.

2. Upgrade `acpSessionUpdateMapper`
   - Parse ACP tool `kind`, `status`, `title`, `content`, `locations`, raw input/output display summaries, and vendor metadata.
   - Preserve lifecycle ordering across pending, in-progress, completed, and failed.
   - Render tool updates even when client fs/terminal capabilities are not advertised.

3. Adapt to AgentHost native UI
   - Use existing AgentHost `ToolCall` response parts rather than creating a custom ACP webview.
   - Map ACP kind to `_meta.toolKind` or equivalent AgentHost metadata.
   - Render text/markdown, diff, terminal references, and file locations with the closest existing AgentHost surfaces.
   - Fall back to bounded text previews only when a native surface is not available.

4. Replace default-deny-only permission bridge
   - Keep cancellation behavior.
   - Preserve original ACP `optionId` values.
   - Show agent-provided option labels/kinds.
   - Return the user-selected option to ACP.

5. Tests
   - Tool read/update renders without client fs capability.
   - Tool edit/diff renders without client fs capability.
   - Tool execute renders without client terminal capability.
   - Tool text/raw-output fallback renders in UI but not diagnostics.
   - Permission selection returns the exact ACP option id.
   - Cancellation returns `cancelled`.

### 9.1B - Local VS Code Filesystem Client Bridge

1. Implement `fs/read_text_file`
   - Prefer unsaved editor buffer content for the requested local path.
   - Fall back to file service.
   - Support line/limit.
   - Deny non-local or out-of-workspace paths with protocol errors.

2. Implement `fs/write_text_file`
   - Apply edits through VS Code editor/file services.
   - Record changed files through existing AgentHost changeset/file-edit surfaces.
   - Show reviewable diff where possible.
   - Keep local-only and workspace containment gates.

3. Advertise capabilities accurately
   - `fs.readTextFile` true only when the read bridge is active.
   - `fs.writeTextFile` true only when the write bridge is active.
   - Do not use these flags to control agent-owned tool reports.

4. Tests and smoke
   - Read unsaved buffer content.
   - Read with line/limit.
   - Deny outside workspace.
   - Write new file and modified file.
   - Verify changed file appears in AgentHost review/diff surface.

### 9.1C - Local VS Code Terminal Client Bridge

1. Implement `terminal/create`
   - Create a local managed terminal/process through AgentHost or terminal service.
   - Pass command, args, env, cwd, and output limit through a safe local policy path.
   - Return ACP terminal id immediately.

2. Implement terminal lifecycle methods
   - `terminal/output`;
   - `terminal/wait_for_exit`;
   - `terminal/kill`;
   - `terminal/release`.

3. Connect terminal content to AgentHost UI
   - When ACP tool content references a VS Code-created terminal id, render live or retained terminal output in the tool card.
   - Unknown terminal ids should degrade to bounded text/status, not fake a terminal.

4. Tests and smoke
   - Run a simple command.
   - Stream/output result is visible in AgentHost UI.
   - Wait returns exit code.
   - Kill cancels process.
   - Output truncation is deterministic.
   - Remote/virtual cwd is rejected clearly.

## Acceptance Criteria

- A trusted local ACP agent keeps the same practical native tool behavior it has when launched from an integrated terminal.
- Agent-owned `tool_call` and `tool_call_update` events are visible and useful in native AgentHost UI.
- Agent-reported reads, edits, searches, commands, diffs, locations, and terminal references are not hidden behind generic unsupported/redacted placeholders.
- ACP permission requests are actionable and return the selected ACP `optionId`.
- VS Code advertises and implements local `fs/read_text_file` and `fs/write_text_file` when enabled.
- VS Code advertises and implements local `terminal/*` methods when enabled.
- Managed install, registry execution, remote runtime placement, telemetry upload, and vendor-side delete remain out of scope.
- Diagnostics remain allowlisted while user-facing transcript/tool output remains visible in the session UI.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpAgentSession.ts`
- `src/vs/platform/agentHost/node/acp/acpSessionUpdateMapper.ts`
- `src/vs/platform/agentHost/node/acp/acpPermissionBridge.ts`
- `src/vs/platform/agentHost/node/acp/acpClientCapabilities.ts`
- `src/vs/platform/agentHost/node/acp/acpProcess.ts`
- `src/vs/platform/agentHost/node/acp/acpProtocol.ts`
- new `src/vs/platform/agentHost/node/acp/acpFileSystemBridge.ts`
- new `src/vs/platform/agentHost/node/acp/acpTerminalBridge.ts`
- existing AgentHost file/changset/terminal services
- `src/vs/workbench/contrib/agentProviders/browser/agentProviders.contribution.ts`
- `src/vs/platform/agentHost/test/node/acp/**/*.test.ts`
- `src/vs/workbench/contrib/agentProviders/test/**/*.test.ts`

## Implementation Status

- **9.1A completed**: ACP agent-owned `tool_call` / `tool_call_update` reports now render through native AgentHost tool-call response parts, keep useful status/content/location/raw summaries, and no longer depend on client fs/terminal capability gates. ACP permission requests surface the vendor-provided options and return the selected original `optionId`.
- **9.1B completed**: VS Code now implements local `fs/read_text_file` and `fs/write_text_file` for trusted local ACP agents when the Files bridge is enabled and a local workspace/root is available. Reads prefer the active renderer text model through the existing reverse client resource channel, then fall back to file service reads; writes go through the renderer text file service when connected, then fall back to local file service writes under workspace containment. Line/limit slicing, local-only containment, and capability advertisement are covered by ACP focused tests.
- **9.1C completed**: VS Code now implements local `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` for trusted local ACP agents when the Terminal bridge is enabled and a local workspace/root is available. ACP terminal requests create AgentHost managed terminals, run the requested command with args/env/cwd under workspace containment, retain/truncate output deterministically, support wait/kill/release lifecycle calls, and map ACP terminal content references into native AgentHost terminal tool content when the terminal id belongs to the bridge. Released ACP terminal ids become invalid for further `terminal/*` calls while the AgentHost terminal resource is retained until session disposal so already-rendered tool output remains visible.

## Validation

```powershell
npm run compile-check-ts-native
npm run transpile-client
npm run test-node -- --runGlob "vs/platform/agentHost/test/node/acp/**/*.test.js"
npm run test-node -- --runGlob "vs/workbench/contrib/agentProviders/test/**/*.test.js"
npm run valid-layers-check
git diff --check
```

## Manual Smoke

1. Configure a pre-authenticated Cursor or CodeBuddy ACP agent.
2. Ask it to read a local project file.
3. Ask it to edit or create a local file.
4. Ask it to run a simple local command.
5. Confirm the AgentHost transcript shows native tool progress/results, file/diff information, and terminal/command output instead of unsupported placeholders.
6. Confirm raw protocol payloads, raw stderr, prompts, file contents, and terminal output are not written to process diagnostics by default.

## Notes From Protocol And Reference Review

- ACP tool calls are reported through `session/update`; the agent handles the actual execution and clients display progress/results.
- ACP filesystem and terminal methods are optional client capabilities and must only be advertised when VS Code implements those methods.
- `vscode-acp` already implements both layers with extension-host Webview UI. We should reuse the semantics, not its UI shell.
- Zed already implements both layers with native agent conversation UI. It is the closest product reference for our AgentHost mapping.
- Registry launch/distribution metadata is not a permissions model and does not describe agent internal tool capabilities.
