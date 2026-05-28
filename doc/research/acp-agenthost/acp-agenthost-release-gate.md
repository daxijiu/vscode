# ACP AgentHost Release Gate

Updated: 2026-05-28

## First-Release Matrix

| Area | First Release | Deferred |
| --- | --- | --- |
| VS Code host | Local desktop | Web-only host |
| Workspace | Local `file` workspace folder | SSH, remote server, WSL, dev containers, Codespaces, virtual workspaces |
| AgentHost process | Local AgentHost node or utility process | Remote AgentHost placement |
| ACP runtime | Local pre-installed ACP CLI | Managed install, package-manager execution, download/extract |
| Vendor auth | Already authenticated by vendor CLI/account | Full vendor login orchestration and terminal-auth |
| Config | Local user profile ACP config and snapshot | Remote profile/config reconciliation |
| Cache/logs | Local VS Code user data/log locations | Remote cache/log placement |
| CWD | Local file workspace CWD, fixed local CWD, or no CWD | Remote workspace CWD forwarding |

Remote targets are non-blocking follow-up work. The host must fail clearly instead of passing a remote or virtual workspace path as an ACP `cwd`.

## Policy Gates

| Setting | Default | Release Behavior |
| --- | --- | --- |
| `externalAcpAgents.execution.enabled` | `true` | When false, External ACP Agents are not written into the AgentHost snapshot, not registered, not tested, and not spawned. |
| `externalAcpAgents.registryBrowse.enabled` | `true` | Controls only the local browse catalog. It does not fetch from the network. |
| `externalAcpAgents.managedInstall.enabled` | `false` | Reserved copy/schema for the deferred install path. No managed install code path is enabled. |
| `externalAcpAgents.capabilities.tools.enabled` | `false` | Reserved for VS Code client-provided tool bridges. Vendor-reported ACP `tool_call` updates should still render for trusted local agents. |
| `externalAcpAgents.capabilities.files.enabled` | `false` | Controls whether VS Code advertises ACP `fs/*` client methods. It does not disable the vendor agent's own file tools. |
| `externalAcpAgents.capabilities.terminal.enabled` | `false` | Controls whether VS Code advertises ACP `terminal/*` client methods. It does not disable the vendor agent's own command execution. |

These are settings-level gates for this fork. Enterprise policy metadata remains future work unless the repository adopts a clear policy contribution pattern for this surface.

## Diagnostics Allowlist

Allowed ACP runtime diagnostics:

- event type;
- status;
- duration;
- exit code;
- signal;
- fixed stderr-available message;
- stderr availability, byte count, and line count;
- redacted command summary with executable basename, argument count, and resolution mode.

Diagnostics must not record prompts, tool arguments, file contents, terminal output, raw stderr text, raw environment values, tokens, bearer values, API keys, OAuth tokens, or full protocol payloads. Detailed local stderr capture is deferred to a future opt-in mode with explicit retention and export boundaries. ACP process/runtime diagnostics are local only; no ACP telemetry upload is added in Phase 9.

## Troubleshooting

| Symptom | Likely Cause | Resolution |
| --- | --- | --- |
| Agent is missing from Agent Sessions | Execution gate disabled, agent disabled/untrusted, invalid config, or pending restart/reconnect | Re-enable `externalAcpAgents.execution.enabled`, verify manual config, trust the agent, then restart/reconnect AgentHost. |
| Test Connection says execution is disabled | `externalAcpAgents.execution.enabled` is false | Turn the setting back on only if local external process execution is allowed. |
| Command not found on Windows | Command is absent from PATH or PATHEXT lookup | Use an absolute path or install the ACP CLI into PATH. |
| `.cmd` or `.bat` is rejected | Batch files run through an explicit `cmd.exe /d /s /c` shim and reject unsafe metacharacters such as quotes, pipes, redirects, environment expansion, and newlines | Prefer a real `.exe` where available; otherwise use a wrapper with simple safe arguments. |
| Remote workspace rejected | Phase 9 supports local file workspaces only | Use a local folder or set CWD policy to No CWD until remote placement is designed. |
| Auth required | Vendor CLI/account is not logged in | Use the vendor-owned login command/help and retry Test Connection or session creation. |

## Release Checklist

- Windows command resolution covers absolute paths, relative paths, PATH/PATHEXT, `.exe`, `.cmd`, `.bat`, safe spaces in paths/args, metacharacter rejection for batch shims, missing command, and redacted summaries.
- Execution disabled gate prevents snapshot registration, Test Connection, createSession, and runtime spawn.
- Managed install remains disabled and no package manager/download/extract path exists.
- Client-provided file, terminal, and tool bridge settings default false.
- Vendor-reported ACP tool calls for trusted local agents render with useful native AgentHost progress/results instead of unsupported placeholders.
- Crash during active prompt emits one terminal error, redacts sensitive data, and does not keep the turn active.
- Diagnostics match the allowlist and do not retain raw stderr text.
- Remote/local placement matrix is documented.
- External ACP wording continues to say vendor agents use their own subscription/account.
- Validation passes:
  - `npm run compile-check-ts-native`
  - `npm run transpile-client`
  - `npm run test-node -- --runGlob "vs/platform/agentHost/test/node/acp/**/*.test.js"`
  - `npm run test-node -- --runGlob "vs/workbench/contrib/agentProviders/test/**/*.test.js"`
  - `npm run valid-layers-check`
  - `git diff --check`
