# Phase 8 - Models, Modes, Config, Restore

Updated: 2026-05-28

## Goal

Surface optional ACP capabilities only when supported by the active agent.

No UI should imply model, mode, config, or session restore support unless the active ACP agent advertises and passes that capability.

## Entry Criteria

- Phase 5 has real vendor smoke coverage.
- Basic text sessions are stable.
- Capability negotiation is stored per connection/session.
- For Phase 8A models/config only, Phase 6 is not required.
- Restore, session identity mapping, and capability-reconnect behavior require Phase 6 reconnect/re-initialize support.

## Scope

- Map agent-reported models into AgentHost models when available.
- Surface modes only when ACP capabilities support them.
- Surface session config options only when advertised.
- Gate unstable set-model behavior.
- Implement session list/load/resume only when capability-proven; delete/archive remains VS Code-local only.
- Support restore as an eventual goal, but split it into staged work:
  - Phase 8A: models/modes/config plus restore feasibility audit per vendor/protocol path;
  - Phase 8B: hidden or experiment-gated restore after Phase 6 and after transcript/identity mapping tests pass;
  - Phase 8C: visible restore UI after compatibility notes and failure states are stable.
- Define restore transcript ownership:
  - whether ACP returns historical messages;
  - whether VS Code reconstructs turns from local logs;
  - how missing or partial history is represented;
  - when restore UI stays hidden.
- Define delete/archive semantics before exposing destructive session actions:
  - VS Code-local only by default;
  - vendor-side delete only as a later separately approved capability;
  - unsupported/no-op when the active agent cannot prove safe behavior.
- Record per-vendor compatibility notes.

## Non-Goals

- No generic model switching for agents that do not expose it.
- No restore UI for agents that cannot reliably load sessions.
- No broad restore UI before the feasibility audit identifies at least one supported vendor/protocol path.
- No use of Director Provider model list for third-party ACP agents.
- No fallback guessing based on vendor name.
- No transcript reconstruction from lossy event summaries.
- No destructive vendor-side delete in this phase.

## Implementation Tasks

1. Store negotiated capabilities from `initialize`. **8A implemented.**
2. Map ACP models to `IAgentModelInfo` only when present. **8A implemented.**
3. Add UI state for vendor-managed/default model when no model list exists. **8A keeps the existing `external-acp-runtime` placeholder.**
4. Implement mode/config APIs with capability gates. **8A implemented for explicit initialize schema/completions only.**
5. Implement set-model only if stable/supported by the active protocol path. **Deferred; 8A leaves `changeModel` unsupported and does not call ACP set-model methods.**
6. Add session list/load/resume adapters where advertised. **Deferred; 8A records indicators only.**
   - delete/archive remains VS Code-local only in this phase;
   - vendor-side delete is a future separately approved capability.
7. Add restore feasibility audit: **8A initial audit recorded below.**
   - which ACP methods are available;
   - whether historical messages can be loaded;
   - whether restore ids are stable across reconnect;
   - whether restore works after process restart;
   - how VS Code `AgentSession.uri`, ACP session id, and vendor restore/list id map.
8. Add restore transcript adapter:
   - historical message source;
   - local metadata source;
   - partial-history warning;
   - failure downgrade path.
9. Add session identity mapping:
   - VS Code `AgentSession.uri`;
   - ACP session id;
   - vendor restore/list id;
   - stale/deleted session behavior.
10. Add vendor compatibility matrix.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpAgent.ts`
- `src/vs/platform/agentHost/node/acp/acpAgentSession.ts`
- `src/vs/platform/agentHost/node/acp/acpCapabilities.ts`
- AgentHost model/session config UI paths.
- Documentation under `doc/research/acp-agenthost/**`.

## Acceptance Criteria

- Unsupported capabilities are hidden or explicitly marked unavailable.
- Model/mode changes never call unsupported ACP methods.
- Vendor-managed model state is understandable.
- Session restore is tested per vendor before being exposed as reliable.
- Restore feasibility is documented before restore UI is exposed.
- Capability changes across reconnects are handled cleanly.
- Restored sessions either produce trustworthy `getSessionMessages` output or clearly show that history is unavailable/partial.
- Delete/archive actions cannot affect vendor-side sessions in this phase.
- Default delete/archive behavior is VS Code-local only.
- Stale vendor session ids fail with an actionable state and do not leave broken sessions in the list.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
npm run test-node -- --grep agentHost
```

Required focused tests:

- no model list -> vendor-managed label;
- model list -> AgentHost model picker entry;
- unsupported set-model not called;
- unsupported restore hidden;
- stale capability state cleared on reconnect.
- restore with full transcript;
- restore with missing/partial transcript;
- stale/deleted vendor session id;
- restore id stable across reconnect/process restart;
- delete/archive does not call vendor-side destructive APIs.

## Risks

- ACP v2/unstable APIs may drift.
- Vendor agents may advertise partial capability support.
- Session restore can produce misleading transcripts if update replay differs.
- Session id mapping can drift across reconnects, especially if a vendor agent rotates ids or hides historical state.

## Handoff Output

- Capability-gated models/modes/config/restore behavior.
- Vendor compatibility matrix.
- Tests for unsupported capability hiding.
- Restore transcript and identity mapping rules.

## Phase 8A Implementation Notes

Implemented on 2026-05-28:

- Added `src/vs/platform/agentHost/node/acp/acpCapabilities.ts` to normalize optional ACP `initialize` metadata/capabilities with an allowlist.
- `AcpProcess.initialize()` stores negotiated capability state in addition to redacted auth methods.
- `AcpAgent` keeps the placeholder `external-acp-runtime` model by default and updates AgentHost model entries only after a successful explicit `createSession` negotiates a trustworthy model list.
- Model entries and config schemas ignore unknown fields and drop/redact secret-like model/config fields.
- `resolveSessionConfig()` and `sessionConfigCompletions()` expose only explicitly negotiated schema/completion capability state; empty capabilities return an empty schema and no completions.
- `changeModel()` remains unsupported and does not send an ACP method.
- `listSessions()` remains VS Code-local/in-memory only even when restore/list/load indicators are advertised.
- Failed replacement initialize attempts do not replace previously negotiated capability state.

## Phase 8A Restore Feasibility Audit

Current status: not ready for visible restore UI.

| Capability area | 8A behavior | Feasibility result |
| --- | --- | --- |
| `session/list` / vendor list | Indicators can be normalized from `initialize`; no ACP method is called. | Deferred until at least one vendor proves stable list IDs after restart/reconnect. |
| `session/load` / vendor load | Indicators can be normalized from `initialize`; no ACP method is called. | Deferred until transcript ownership and partial-history states are defined. |
| Visible restore/list/load/resume UI | Hidden. | Deferred to Phase 8C after a vendor/protocol path passes identity and transcript tests. |
| VS Code URI to ACP/vendor session mapping | Current sessions map only in memory. | Deferred; needs stable ACP session id plus vendor restore id mapping. |
| Delete/archive | VS Code-local disposal only. | Vendor-side destructive API remains out of scope and separately approval-gated. |

## Recorded Direction

- Restore should be supported as a goal, but split into feasibility and vendor-gated stages.
- The first Phase 8 slice should evaluate implementation difficulty and compatibility before exposing broad restore UI.
- Delete/archive defaults to VS Code-local only.
- Vendor-side delete is out of scope for this phase and can only be added later as a separately approved capability.
