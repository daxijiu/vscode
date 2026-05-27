# Phase 0 - Boundary And UX Contract

Updated: 2026-05-27

## Goal

Lock the product and architecture contract before implementation starts.

ACP agents are external runtimes that reuse their own subscription/login/model routing. VS Code hosts their UI and lifecycle. Director Providers remain separate and are not injected into third-party ACP agents.

## Entry Criteria

- ACP research notes exist under `doc/research/acp-agenthost/`.
- Roadmap decision is accepted: no generic Director Provider switching for ACP agents.
- The target branch/worktree is clean enough to add planning docs and future implementation tasks.

## Scope

- Write an ADR or design note confirming ACP as an AgentHost runtime adapter.
- Define user-facing language for external subscription ownership.
- Define non-goals:
  - no Copilot CAPI use for ACP agents;
  - no Director Provider credentials passed to third-party ACP agents;
  - no custom ACP chat webview;
  - no file/terminal capabilities in the first text milestone.
- Decide the settings location:
  - preferred: neutral "External ACP Agents" / "Agent Providers";
  - fallback: reuse Director Settings shell only if it does not imply Director owns ACP subscriptions.
- Pick first smoke-test agents.
- Decide the protocol implementation strategy:
  - recorded first-version default: internal JSON-RPC framing plus local ACP DTOs;
  - future alternative: adopt `@agentclientprotocol/sdk` only if dependency/bundling policy accepts it.
- Decide config apply behavior:
  - first slice may require AgentHost restart/reconnect after enable/disable;
  - dynamic provider reconcile requires explicit provider unregister/reconcile support.

## Non-Goals

- No code implementation.
- No registry install.
- No auth flow implementation.
- No provider switching design beyond explicitly marking it out of scope.

## Implementation Tasks

1. Create an ADR in `doc/research/acp-agenthost/` or the repo's accepted ADR location.
2. Add exact UI copy examples:
   - `Cursor Agent - uses your Cursor subscription`
   - `CodeBuddy Code - uses your CodeBuddy account`
   - `Claude ACP - uses your Claude Code / Anthropic-side auth`
3. Define first milestone capability policy:
   - text prompt only;
   - pre-authenticated agents only;
   - login-required message for missing auth;
   - no file/write/terminal capabilities.
4. Decide first real smoke-test target:
   - Cursor Agent if available locally;
   - CodeBuddy Code if installed;
   - fake ACP agent for automation.
5. Record the default protocol implementation decision:
   - first version uses internal JSON-RPC/local DTOs;
   - SDK adoption is deferred until dependency/bundling policy accepts it.
6. Add a short security boundary note for logs and process launch.
7. Add a Zed-inspired management UI decision:
   - manage custom/manual agents first;
   - registry browse/install later;
   - no eager launch from the management list.

## Likely Files

- `doc/research/acp-agenthost/06-acp-agenthost-roadmap.md`
- `doc/research/acp-agenthost/phases/**`
- Optional future ADR file, for example `doc/research/acp-agenthost/acp-agenthost-adr.md`

## Acceptance Criteria

- A reader can answer: "Who owns the subscription?" without ambiguity.
- Roadmap and ADR agree that ACP is not a Director Provider Backend.
- UI copy avoids confusing external ACP agents with Director Providers.
- First milestone explicitly assumes pre-authenticated real agents.
- Missing login behavior is defined as a clear prompt, not full login orchestration.
- Protocol implementation strategy is recorded as internal JSON-RPC/local DTOs for the first version.
- Agent config apply behavior is recorded: restart/reconnect required or dynamic reconcile.
- Management UI scope is accepted: custom/manual agents first, registry later.

## Validation

```powershell
git diff --check -- doc/research/acp-agenthost
```

## Risks

- If wording says "Provider" too broadly, users may expect Director Provider settings to affect ACP agents.
- If Phase 0 does not lock file/terminal as disabled, later phases may accidentally expose high-risk capabilities too early.
- If config apply behavior is not decided, Phase 3 may attempt duplicate provider registration or leave disabled agents visible.

## Handoff Output

- Accepted ADR/design note.
- Finalized first milestone boundary.
- UI copy examples for external subscription ownership.
- ACP protocol dependency decision.
- Management UI boundary decision.

## Recorded Decisions

- The first version uses internal ACP JSON-RPC framing and local DTOs.
- `@agentclientprotocol/sdk` remains a possible later replacement only after dependency/bundling review.
