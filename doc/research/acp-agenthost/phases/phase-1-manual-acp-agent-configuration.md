# Phase 1 - Manual ACP Agent Configuration

Updated: 2026-05-27

## Goal

Represent ACP agents as explicit, user-enabled manual configurations without registry install.

The output is a Workbench-owned **External ACP Agents** management page, a config model, and a secret-free snapshot that AgentHost can consume.

## Entry Criteria

- Phase 0 boundary is accepted.
- The target settings surface is chosen.
- First milestone capability policy is text-only and pre-authenticated.
- Config apply behavior is chosen: restart/reconnect required or dynamic provider reconcile.

## Scope

- Add a config model for manual ACP agents.
- Add the first version of the neutral "External ACP Agents" management UI. This is the phase that owns the management page.
- Store only safe metadata:
  - id;
  - display name;
  - command;
  - args;
  - cwd policy;
  - vendor/subscription label;
  - enabled flag;
  - trust state;
  - allowed capabilities;
  - env variable names or secret references, not raw values.
- Write a secret-free snapshot for AgentHost.
- Support enable/disable.
- Support add/edit/remove of manual agents.
- Support a visible apply state:
  - first slice may show "changes apply after AgentHost restart/reconnect";
  - dynamic reconcile is allowed only if Phase 3 adds safe provider unregister/reconcile.
- Separate snapshot state from live AgentHost state:
  - the snapshot must immediately omit disabled/untrusted agents;
  - the live AgentHost may still show a previously registered provider until restart/reconnect if dynamic reconcile is not implemented;
  - the management page must show pending apply when snapshot and live state can diverge.
- Render the management list from config only. Do not launch external agent processes just to show status.
- Keep registry discovery and package install out.

## Non-Goals

- No ACP process launch yet.
- No "Test Connection" unless it is explicitly user-triggered and routed through a later runtime phase.
- No registry browse/install.
- No secrets stored in JSON snapshots.
- No file/terminal capability enablement.

## Implementation Tasks

1. Define shared DTOs under `src/vs/platform/agentHost/common/**`.
2. Define Workbench config service:
   - load manual agents;
   - validate id/command/args/cwd policy;
   - normalize provider id.
3. Implement the basic management page:
   - list configured ACP agents;
   - add/edit/remove manual agent;
   - enable/disable;
   - show command/args/cwd policy;
   - show vendor subscription label;
   - show trust state;
   - show apply/restart requirement if dynamic reconcile is not implemented.
4. Define snapshot writer:
   - writes enabled manual ACP agents;
   - redacts env/secret values;
   - includes subscription display label.
5. Define apply-state tracking:
   - clean/applied;
   - pending restart/reconnect;
   - failed snapshot write;
   - invalid config.
6. Decide storage scope:
   - user profile;
   - workspace;
   - local desktop/local workspace behavior for the first version;
   - remote workspace behavior is documented as follow-up, not a first-version blocker.
7. Add tests for snapshot redaction, id normalization, disabled-agent omission, and no eager process launch from the management page.

## Likely Files

- `src/vs/platform/agentHost/common/acpAgentConfig.ts`
- `src/vs/workbench/contrib/agentProviders/**`
- `src/vs/workbench/contrib/directorCode/**` only if reused deliberately
- `src/vs/workbench/contrib/**/test/**`

## Acceptance Criteria

- A manual ACP agent can be added, enabled, disabled, and removed.
- Snapshot contains no API keys, bearer tokens, OAuth tokens, or raw secret env values.
- Provider id is valid for `AgentSession.uri`.
- Multi-root cwd policy is explicit.
- First-version storage/cwd behavior is explicit for local desktop/local workspace.
- Disabled or untrusted agents are not emitted to the secret-free snapshot.
- If live AgentHost needs restart/reconnect before reflecting that change, the management page shows pending apply.
- The External ACP Agents management page can add/edit/remove/enable/disable manual agents.
- The management page renders without starting external ACP processes.
- If changes require restart/reconnect, the page says so clearly.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
```

If only docs/config schema are touched:

```powershell
git diff --check -- <changed-doc-paths>
```

## Risks

- Settings UI can accidentally imply VS Code owns vendor subscriptions.
- Env values can leak if the model stores raw env instead of references.
- Multi-root cwd ambiguity can cause agents to load wrong project rules.
- A management page that starts external commands for status checks can become surprising and unsafe.
- Pulling remote workspace semantics into Phase 1 would conflict with the local-desktop first release matrix.

## Handoff Output

- Secret-free ACP config snapshot DTO and writer.
- Manual agent config model.
- External ACP Agents management page for custom/manual agents.
- Unit tests for redaction, provider id normalization, disabled-agent omission, apply-state behavior, and no eager process launch.
- Local-desktop storage/cwd decision plus remote follow-up note.
