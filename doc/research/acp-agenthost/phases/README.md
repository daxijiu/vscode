# ACP AgentHost Phase Plans

Updated: 2026-05-27

These documents split the ACP AgentHost roadmap into standalone phase plans. The product anchor is unchanged:

> Supported ACP agents reuse their own subscription, login, billing, and model routing. VS Code adapts their interaction into native AgentHost / Agent Sessions UI.

## Phase Documents

- [Phase 0 - Boundary And UX Contract](./phase-0-boundary-and-ux-contract.md)
- [Phase 1 - Manual ACP Agent Configuration](./phase-1-manual-acp-agent-configuration.md) - owns the first External ACP Agents management page for manual add/edit/remove/enable/trust.
- [Phase 2 - ACP Runtime Skeleton](./phase-2-acp-runtime-skeleton.md)
- [Phase 3 - Agent List And Subscription State](./phase-3-agent-list-and-subscription-state.md)
- [Phase 4 - Basic Text Session](./phase-4-basic-text-session.md)
- [Phase 5 - Vendor Login UX And Smoke Tests](./phase-5-vendor-login-ux-and-smoke-tests.md)
- [Phase 6 - Tools, Permissions, Files, Terminal](./phase-6-tools-permissions-files-terminal.md)
- [Phase 7 - Registry Browse And Managed Enablement](./phase-7-registry-browse-and-managed-enablement.md)
- [Phase 8 - Models, Modes, Config, Restore](./phase-8-models-modes-config-restore.md)
- [Phase 9 - Hardening And Policy](./phase-9-hardening-and-policy.md)

## First Milestone

The recommended first milestone is Phase 0 through Phase 4 only:

```text
Manual ACP command
  -> AgentHost provider appears in UI
  -> pre-authenticated session
  -> send text prompt
  -> stream text
  -> cancel/dispose cleanly
```

If a real vendor agent is not logged in, the first milestone only needs to show a clear vendor-login-required message. Guided login is Phase 5.

Review refinements now captured in the phase docs:

- Phase 0 records internal JSON-RPC/local DTOs as the first-version protocol strategy; SDK adoption is deferred.
- Phase 3/4 require a complete `IAgent` skeleton with explicit unsupported/no-op behavior for later-phase methods.
- Phase 4 handles unexpected tool updates in text-only mode as unsupported capability results and enforces one terminal turn action.
- Phase 5 defers terminal-auth until terminal policy exists in Phase 6 or a Phase 6.5 follow-up.
- Phase 6 owns file/terminal/tool policy hooks and treats capability changes as reconnect/re-initialize events unless a tested dynamic protocol path exists.
- Phase 7A first ships browse/manual-config-only, with no automatic install and no enabled managed-install distribution type; Phase 7B managed install is deferred design.
- Phase 8 keeps restore as a goal, but splits it into feasibility audit and vendor-gated rollout before broad UI exposure; delete/archive is VS Code-local only by default.
- Phase 9 validates policy, local diagnostics with ACP telemetry disabled, and a first-release matrix limited to local desktop plus local pre-installed/pre-authenticated ACP CLI; remote targets are follow-up work.
