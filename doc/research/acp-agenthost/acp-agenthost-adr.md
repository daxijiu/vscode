# ADR: ACP Agents As AgentHost Runtime Adapters

Updated: 2026-05-27

Status: Accepted for Phase 0

## Context

ACP support in this fork is intended to make external ACP agents appear as optional native AgentHost agents. These agents already own their runtime, subscription, login, billing, and model routing. VS Code should host their lifecycle and UI without turning them into Director Provider Backend clients.

This ADR locks the Phase 0 boundary before implementation begins. Later phase plans may add detail, but they should not contradict this ownership and safety contract.

## Decision

ACP agents are AgentHost runtime adapters. Each enabled ACP agent is represented as an AgentHost `IAgent` provider backed by an external ACP process and ACP protocol translation.

ACP agents are not Director Provider Backend entries. Director Providers remain for Director-owned agents and Director-owned model routing. Third-party ACP agents must not receive Director Provider API keys, OAuth tokens, model selections, or provider snapshots as a way to change their backend.

User-facing copy must identify external ownership:

- `Cursor Agent - uses your Cursor subscription`
- `CodeBuddy Code - uses your CodeBuddy account`
- `Claude ACP - uses your Claude Code / Anthropic-side auth`

Missing login or subscription state must come from explicit user actions, cached state from those actions, or runtime errors reported by the agent. The host must not background-probe third-party CLIs merely to populate status.

## Ownership Boundaries

VS Code owns:

- External ACP Agents configuration UI and secret-free config snapshots.
- AgentHost registration, session lifecycle, cancellation, and UI adaptation.
- Local process launch policy, timeout, disposal, redacted diagnostics, and future permission mediation.
- Clear subscription/login wording in Agent Sessions and management surfaces.

The ACP vendor agent owns:

- Login, subscription, billing, and account status.
- Model routing, backend selection, vendor-specific config, and vendor-side session identity.
- Any auth flow the agent advertises through ACP, subject to VS Code user action and policy gates.

Director owns:

- Director Provider Backend configuration and credentials.
- Director Agent model routing and Director-specific AgentHost adapters.

Director does not own ACP vendor subscriptions, ACP backend switching, or third-party ACP process credentials.

## Non-Goals

Phase 0 and the first milestone do not include:

- Copilot CAPI usage for ACP agents.
- Passing Director Provider credentials to third-party ACP agents.
- Generic switching between ACP agents and Director Providers.
- A custom ACP chat webview outside native AgentHost / Agent Sessions UI.
- Registry install or managed package execution.
- Full vendor login orchestration.
- File, terminal, write, tool, or permission side effects in the first text milestone.
- Session restore, vendor-side delete/archive, or broad remote workspace support.

## First Milestone Boundary

The first milestone is Phases 0 through 4:

```text
Manual ACP command
  -> AgentHost provider appears in UI
  -> pre-authenticated session
  -> send text prompt
  -> stream text
  -> cancel/dispose cleanly
```

The first milestone assumes real vendor agents are already authenticated. If an agent is not logged in, VS Code should show a clear vendor-login-required message and stop cleanly. Guided login and auth retry are Phase 5.

The first milestone supports text and reasoning/status updates only. Tool calls, file access, terminal actions, writes, and permission requests are explicitly unsupported until later phases add AgentHost policy and UI mediation.

## Protocol Strategy

The first implementation uses an internal ACP JSON-RPC-over-stdio transport and local ACP DTOs. This keeps dependency and bundling risk low while the AgentHost integration shape is still being proven.

The `@agentclientprotocol/sdk` package remains a possible later replacement only after dependency, bundling, licensing, and runtime compatibility review accepts it for this fork.

The first baseline protocol methods are:

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/update`

Optional auth, model, mode, restore, terminal, file, and tool capabilities are capability-gated in later phases.

## Configuration Apply Behavior

The first slice may require AgentHost restart/reconnect after adding, enabling, disabling, or editing an external ACP agent.

Dynamic apply is not promised for Phase 0. A live reconcile path requires explicit support for unregistering or reconciling AgentHost providers, reconnecting ACP processes, and re-initializing capability state without duplicate provider ids.

Any UI that writes config before dynamic reconcile exists must show pending restart/reconnect state when snapshot config and live AgentHost state can diverge.

## External ACP Agents Management UI

The neutral management surface is `External ACP Agents` or `Agent Providers`; avoid copy that suggests Director owns third-party ACP subscriptions.

Phase 1 owns the first management page. Its scope is manual custom agents:

- add, edit, remove, enable, disable, and trust manual agent configs;
- display command, args, cwd policy, vendor/subscription label, enabled state, and capability flags;
- store secret references or environment variable names only, not raw secrets;
- render from config only;
- do not eager-launch third-party commands just to draw the list;
- write a secret-free snapshot for AgentHost.

Registry browse belongs to Phase 7. Managed install remains deferred design until supply-chain, integrity, policy, and placement rules are accepted.

## Logging And Process Safety

Process launch must be explicit, local, and policy-aware. The first release target is local VS Code desktop with local workspace, local AgentHost process, local config/cache/logs, and locally pre-installed ACP CLIs.

Launch and log rules:

- Do not log prompts, API keys, bearer tokens, OAuth tokens, raw environment secrets, or full ACP payloads by default.
- Redact command environment and any structured auth fields before diagnostics.
- Launch configured commands only after explicit user enable/trust decisions.
- Apply cwd policy explicitly; send absolute workspace cwd to ACP only when allowed.
- Preserve necessary user environment such as PATH and proxy variables without copying secret values into snapshots.
- Enforce initialize/session timeouts and dispose/kill child processes on cancellation, failure, shutdown, or reconnect.
- Do not silently run registry-provided binaries or packages in the first version.

## First Smoke Agents

The first smoke targets are:

- Fake ACP agent fixture for deterministic automated tests.
- Cursor Agent when locally available, using `agent acp` or `cursor-agent acp`.
- CodeBuddy Code when locally available, using `codebuddy --acp`.

Real vendor smoke tests validate AgentHost UI adaptation, subscription/login wording, text streaming, cancellation, and redacted failures. They do not validate Director Provider switching.

## Consequences

This decision keeps ACP integration narrow and AgentHost-shaped. It preserves Copilot, Copilot CLI, GitHub Copilot auth, Director Providers, and external ACP vendor accounts as separate ownership domains.

Later phases should update their own implementation plans if runtime evidence requires a narrower capability gate, but any broader behavior must preserve this Phase 0 contract.
