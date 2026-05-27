# ACP AgentHost Research Index

Updated: 2026-05-27

This folder captures the staged research for bringing Agent Client Protocol (ACP) agents into this VS Code fork as optional AgentHost agents that reuse each agent's own existing subscription, login, billing, and model routing.

## Research Notes

- [01-acp-protocol-and-registry.md](./01-acp-protocol-and-registry.md): ACP protocol, lifecycle, auth, registry schema, and security implications.
- [02-reference-vscode-acp.md](./02-reference-vscode-acp.md): What the `E:\Projects\sub-projects\vscode-acp` extension does and which pieces are reusable.
- [03-reference-zed.md](./03-reference-zed.md): How Zed implements ACP external agents, registry install, connection lifecycle, auth, and UI.
- [04-vendor-agents-cursor-codebuddy.md](./04-vendor-agents-cursor-codebuddy.md): Cursor Agent and CodeBuddy Code ACP behavior, auth, env, and provider-switching limits.
- [05-vscode-agenthost-integration-plan.md](./05-vscode-agenthost-integration-plan.md): Re-anchored goal, VS Code UI adaptation plan, phase plan, difficulty, and open decisions for this fork.
- [06-acp-agenthost-roadmap.md](./06-acp-agenthost-roadmap.md): Phase-by-phase roadmap from product boundary through shippable hardening.
- [acp-agenthost-adr.md](./acp-agenthost-adr.md): Accepted Phase 0 ADR for ACP as AgentHost runtime adapters, external subscription ownership, first milestone boundaries, protocol strategy, config apply behavior, management UI scope, process/log safety, and smoke agents.
- [phases/README.md](./phases/README.md): Standalone implementation plan documents for each roadmap phase.
- [acp-agenthost-final-report.html](./acp-agenthost-final-report.html): Final readable HTML report.

## One-Line Conclusion

ACP should be integrated as optional AgentHost `IAgent` providers backed by external agent processes. The product goal is to reuse each ACP agent's own subscription and login, while adapting its interactions and display into VS Code's existing AgentHost / Agent Sessions UI. Generic switching between third-party ACP agents and Director-owned Providers is out of scope for this workstream.

Latest plan refinement: Phase 0 now has an accepted ADR and records internal JSON-RPC/local DTOs as the first-version protocol strategy, Phase 3/4 require a full `IAgent` skeleton, Phase 4 handles unexpected tool updates in text-only mode without hanging, Phase 5 defers terminal-auth until terminal policy exists, Phase 6 owns side-effect policy hooks plus reconnect/re-initialize capability changes, Phase 7A is browse/manual-config-only for the first version with no automatic install while Phase 7B managed install stays deferred design, Phase 8 supports restore as a staged feasibility and vendor-gated goal with VS Code-local delete/archive by default, and Phase 9 validates policy, local diagnostics with no ACP telemetry upload, and a first-release matrix limited to local desktop plus local pre-installed/pre-authenticated ACP CLI.
