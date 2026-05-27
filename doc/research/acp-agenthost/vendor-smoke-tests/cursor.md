# Cursor Agent ACP Vendor Smoke Test

Updated: 2026-05-28

## Scope

Validate Cursor Agent as an external ACP runtime hosted by VS Code AgentHost. Cursor owns login, subscription, billing, and model routing. VS Code only launches the configured ACP command after explicit user action or AgentHost session start.

Candidate commands:

```powershell
agent acp
cursor-agent acp
```

Candidate login command:

```powershell
cursor-agent login
```

## Acceptance Checklist

- Logged out: creating an ACP session or running Test Connection reports a vendor-owned auth-required state.
- Logged out: UI copy tells the user to sign in with Cursor and does not mention Director Providers, Copilot CAPI, or VS Code-owned credentials.
- Logged out: Copy Login Command copies only the configured login command and does not start the ACP runtime.
- Logged out: Open Login Help opens only the configured help URL and records `loginHelpShown`.
- Logged in: Test Connection starts the configured ACP command only after the user clicks it, runs initialize, runs authenticate only for safe/explicitly allowed auth methods, sends no prompt, and caches `testSucceeded`.
- Logged in: creating a session and sending a text prompt streams text in Agent Sessions UI.
- Cancel: cancelling an active turn disposes/cancels cleanly and does not emit duplicate terminal states.
- Dispose: closing/replacing a session kills the Cursor ACP child process.
- No secret logging: status, snapshot, diagnostics, and UI do not include API keys, bearer tokens, OAuth tokens, raw env values, or prompt text.
- UI subscription ownership: labels continue to say the agent uses the Cursor account/subscription.

## Notes

- Terminal-auth is not part of Phase 5 acceptance. If Cursor requires an interactive terminal login, run it outside VS Code and retry.
- Tools, files, terminal, model switching, registry install, and session restore remain deferred to later phases.
