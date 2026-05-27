# Phase 7 - Registry Browse And Managed Enablement

Updated: 2026-05-27

## Goal

Move from manual ACP configuration to trust-gated registry discovery and managed enablement.

This phase should be split internally into browse-only and managed install work.

## Entry Criteria

- Phase 3 can show enabled ACP agents in the agent list.
- Phase 1 config model can represent registry-backed agents.
- Security posture for registry trust is defined.
- Local desktop process placement is decided for registry-backed manual config drafts:
  - the ACP process runs locally;
  - workspace cwd is local;
  - no install/cache placement is needed for the first version because there is no managed install.
- Enterprise policy skeleton exists for disabling registry access and managed install.

## Scope

### Phase 7A - Browse Only

- Fetch ACP registry metadata.
- Display agents, descriptions, versions, authors, icons, auth method hints, and distribution type.
- Do not execute or install anything.
- Allow users to create a disabled manual config draft from registry metadata if safe.
- Do not write enabled config from browse-only UI.
- Do not create a config that Phase 3 can auto-register.
- If the user wants to enable a registry-derived draft in the first version, it must go through the Phase 1 manual review/edit/enable/trust path and become an ordinary manual config.

### Phase 7B - Managed Enablement / Install

Managed install is not part of the first version. The first Phase 7 delivery is browse/manual-config-only. Keep the 7B design in the plan so the security and supply-chain boundary is ready when managed install is reconsidered later.

- Enable registry agents through the same config model.
- Handle binary, NPX, and UVX distributions.
- Add explicit trust prompts.
- Add version pinning.
- Add cache cleanup.
- Add enterprise disable controls.
- Add a hard supply-chain strategy:
  - binary install requires a pinned version and verifiable checksum/signature or a local allowlist;
  - NPX/UVX install requires an exact package/version/pin plus recorded resolved metadata/integrity where available;
  - if integrity cannot be established, keep the entry browse/manual-config-only rather than managed-installable.
- Add a user-visible install summary before execution:
  - command/binary/package;
  - version/pin;
  - install/cache location;
  - process location for local/remote windows;
  - capabilities requested by the agent.
- First-version policy:
  - no automatic install;
  - no managed install distribution type is enabled;
  - unverifiable registry entries remain disabled draft/manual-config-only.

## Non-Goals

- No silent install.
- No silent execution of downloaded binaries or package-manager commands.
- No registry metadata treated as trusted executable content.
- No auto-update before version/trust policy exists.
- No managed install for entries without the minimum supply-chain proof accepted for this fork.
- No browse-only path that writes enabled config.
- No automatic install in the first version.

## Implementation Tasks

### Phase 7A Required - First Version

1. Add registry client with cache and error states.
2. Add browse UI with no execution side effects.
3. Map registry entries to disabled manual config drafts only.
4. Route any enable action through the existing Phase 1 manual review/edit/enable/trust path.
5. Add policy controls for registry browse.
6. Add managed-install policy key/schema/copy, but keep the implementation path disabled.
7. Add audit/debug logs with redaction.

### Phase 7B Deferred Design - Managed Install

1. Add trust gate for enabling/installing.
2. Add supply-chain verifier:
   - checksum/signature/local allowlist for binary;
   - exact version and resolved metadata/integrity for NPX/UVX where available;
   - managed-install rejection/fallback for unverifiable entries.
3. Add distribution handlers:
   - binary;
   - NPX;
   - UVX.
4. Add install cache and version pin tracking.
5. Add remote/local install placement rules.
6. Add managed-install enforcement for the policy key/schema from Phase 7A.

## Likely Files

- Workbench external agents settings/registry UI.
- `src/vs/platform/agentHost/common/acpRegistry.ts`
- `src/vs/workbench/contrib/agentProviders/**`
- Install/cache service under Workbench or platform depending on architecture.

## Acceptance Criteria

- Users can browse registry entries without executing anything.
- First-version enablement of a registry-derived draft goes through Phase 1 manual review/edit/enable/trust.
- Browse-only can produce only disabled drafts and cannot auto-register an ACP agent.
- Version pins are visible.
- First version has no managed install path.
- Registry fetch failure is visible and non-fatal.
- No silent execution of remote binary/package metadata.
- Enterprise policy can disable registry use.
- Managed-install policy key/schema/copy exists and does not affect browse/manual-config-only behavior.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
```

Required focused tests:

- registry fetch success/failure;
- malformed registry entry ignored;
- browse does not execute command;
- browse draft remains disabled;
- registry-derived draft can only be enabled through Phase 1 manual review/edit/enable/trust;
- policy disables registry;
- managed-install policy key/schema/copy exists while install path remains unavailable;
- version pin survives reload.

## Risks

- Registry install is a supply-chain surface.
- NPX/UVX execution can change behavior over time without pinning.
- Icons/metadata can still be misleading even if schema-valid.
- Enterprise environments may need complete disablement.
- Local vs remote process placement can install or execute the agent in the wrong environment if not decided before managed install.

## Handoff Output

- Browse-only registry UI.
- Managed enable/install deferred design with trust gates.
- Policy and supply-chain notes.
- Local desktop process placement for registry-derived manual drafts.

## Recorded Decisions

- Phase 7 initially ships browse/manual-config-only.
- The first version does not automatically install ACP agents.
- No managed install distribution type is enabled in the first version.
- Unverifiable registry entries cannot be managed-installed in the first version; they can only become disabled drafts/manual configs.
