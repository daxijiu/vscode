# Vendor ACP Agents: Cursor And CodeBuddy

Updated: 2026-05-26

## Scope

This note summarizes Cursor Agent ACP and CodeBuddy Code ACP based on the user-provided docs and a read-only environment check.

Primary sources:

- Cursor ACP docs: <https://cursor.com/cn/docs/cli/acp>
- Cursor ACP docs, English canonical: <https://cursor.com/docs/cli/acp>
- Cursor CLI parameters: <https://cursor.com/docs/cli/reference/parameters>
- Cursor CLI usage: <https://cursor.com/docs/cli/using>
- CodeBuddy ACP docs: <https://www.codebuddy.ai/docs/cli/acp>
- CodeBuddy quick start: <https://www.codebuddy.ai/docs/cli/quickstart>
- CodeBuddy IAM: <https://www.codebuddy.ai/docs/cli/iam>
- CodeBuddy CLI reference: <https://www.codebuddy.ai/docs/cli/cli-reference>
- Local registry examples:
  - `E:\Projects\sub-projects\registry\cursor\agent.json`
  - `E:\Projects\sub-projects\registry\codebuddy-code\agent.json`

## Cursor Agent ACP

The Cursor ACP entry is an external agent server. The command shape is:

```powershell
agent acp
```

or:

```powershell
cursor-agent acp
```

On Windows, built-in integration should prefer resolving `.cmd` launchers where available, rather than relying on PowerShell shims from Electron/Node process spawning.

### Auth

Cursor owns its auth lifecycle. Practical paths are:

- user runs Cursor/Cursor Agent login first;
- user provides an API key through Cursor-supported CLI/env mechanisms such as `--api-key` or `CURSOR_API_KEY`;
- ACP auth method such as `cursor_login` is invoked by the client when advertised or when session creation reports auth-required.

This should be presented in VS Code as "use existing Cursor login" or "authenticate Cursor Agent." It should not be wired into Director Provider Backend credentials.

### Workspace Context

Cursor agent behavior depends on project context. The adapter must launch with the correct cwd and send `session/new` with the intended absolute cwd. It should preserve relevant environment variables such as PATH, HOME/USERPROFILE, proxy variables, and Cursor auth environment where the user has opted into that.

Cursor may load project rules and MCP config from project-relative locations. A wrong cwd can create misleading behavior and should be treated as a first-class bug.

### Resume And Compatibility

Cursor CLI has ordinary session listing/resume concepts. ACP docs mention session load behavior, but compatibility should be tested against the installed version. Session restore, MCP, permission, and model switching are areas where vendor versions can drift.

First implementation should not assume restore/list/model-switch support unless `initialize` capabilities and live smoke tests prove it.

### Subscription And Provider Boundary

Cursor owns its subscription, backend, and model routing. ACP does not standardize "use this editor-provided LLM provider credential" for Cursor.

Conclusion: Cursor ACP should be an optional external AgentHost provider that uses Cursor's own login/subscription/model stack. Director Provider switching is out of scope for this ACP integration goal.

## CodeBuddy Code ACP

The CodeBuddy ACP command shape is:

```powershell
codebuddy --acp
```

The registry entry uses an NPX distribution for `@tencent-ai/codebuddy-code` with `--acp`. Docs also describe Zed-style configuration with command, args, and optional env.

### Auth

CodeBuddy owns its auth lifecycle. It supports browser login and environment/API-key approaches. IAM docs describe priority among auth token, token helper, and API key mechanisms. It also supports environment variables related to China/international/enterprise/iOA deployments.

For VS Code integration, that means:

- surface clear "CodeBuddy login required" state;
- support secret references/env injection only with explicit user configuration;
- redact env values in logs;
- avoid implying Director's provider picker changes a live CodeBuddy account.

### Workspace Context

Docs emphasize running from the project directory. The ACP adapter should launch with the intended workspace cwd and send `session/new` with that cwd. Multi-root workspaces need an explicit selected root.

CodeBuddy supports CLI concepts such as continue/resume/add-dir/model flags. ACP support for session load/replay should be capability-gated and smoke-tested.

### Subscription And Provider Boundary

CodeBuddy can route to third-party model services through its own environment/config model. That is still CodeBuddy-owned provider switching.

VS Code can display and configure CodeBuddy as a CodeBuddy-owned external agent. It should not hand Director Provider Backend Hub credentials to CodeBuddy at runtime for this workstream.

## Common Vendor Requirements

For both Cursor and CodeBuddy, the minimal built-in UI should show:

- installed/enabled status;
- command path and args;
- resolved cwd behavior;
- auth state or "vendor login required" status;
- agent-reported models/modes if available;
- session restore availability if capability-proven;
- logs with redaction;
- a clear boundary between vendor subscription/login/model state and Director Providers.

## Common Risks

| Risk | Cursor | CodeBuddy | Notes |
| --- | --- | --- | --- |
| Wrong cwd | High | High | Agent rules/MCP/project context depend on cwd. |
| Windows spawn quirks | Medium-high | Medium-high | `.cmd`, PATH, package manager shims, quoting. |
| Auth confusion | High | High | Users may expect VS Code provider settings to affect vendor agents. |
| Env leakage | Medium | High | API keys/base URLs may be provided via env. |
| Session restore drift | Medium | Medium | Capability-gate and smoke-test. |
| Model switching drift | Medium | Medium | ACP stable/v1 does not make vendor provider switching generic. |

## Conclusion

Cursor and CodeBuddy validate the "external optional ACP agent using its own subscription" path. They do not validate universal Director Provider switching, and that switching is not part of the re-anchored goal.

Recommended product wording:

```text
External ACP agents use their own account, terms, billing, and model routing.
Director Providers are used by Director.
VS Code adapts the external agent interaction into the native AgentHost UI.
```
