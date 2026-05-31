# Director Agent Provider Phase 10 Plan

Status: minimal implementation slice completed locally on 2026-05-31. Full external preview readiness remains deferred.

## Goal

Phase 10 hardens the Director provider/backend path with focused telemetry, stress-style coverage, and a manual dogfood checklist while reusing the existing AgentHost telemetry service.

This slice deliberately does not add a new telemetry pipeline.

## Implemented Slice

- Added `DirectorTelemetryReporter` under `src/vs/platform/agentHost/node/director/`.
- Recorded low-cardinality Director session telemetry for create/list/metadata/restore/send/changeModel/dispose/truncate outcomes.
- Recorded provider resolution telemetry for success, missing auth, disabled provider, model unavailable, and generic resolution failure.
- Recorded model-call telemetry for success, cancellation, bounded-loop result, auth-like failure, resolution-like failure, and transport-like failure.
- Telemetry payloads avoid prompts, responses, file paths, provider instance ids, model ids, API keys, OAuth access tokens, and OAuth refresh tokens.
- Added focused tests around:
  - restore after AgentHost restart and continued conversation history in the provider request;
  - saved model removal after restore;
  - telemetry redaction from prompts, responses, and runtime credentials.

## Boundaries

- No Director-specific telemetry service or pipeline.
- No Copilot telemetry/auth/backend usage.
- No token refresh implementation beyond the Phase 8 deterministic local flow.
- No endpoint/subprocess leak framework added in this slice.

## Dogfood Checklist

- Enable `chat.agentHost.directorAgent.enabled`.
- Configure one API-key provider in Director Settings and confirm registry/snapshot files stay secret-free.
- Create a Director AgentHost session with a working directory.
- Send a provider-backed prompt and confirm streamed response rendering still works.
- Close/restart the AgentHost process and confirm the session appears in the Agent Sessions list.
- Open the restored session and confirm the previous turn renders.
- Send a follow-up and confirm the provider sees prior conversation history.
- Remove or hide the selected model, reopen the restored session, and confirm it still lists but the next send shows a recoverable model-unavailable error.
- Abort one slow provider-backed turn and confirm the session remains usable afterward.
- Inspect logs/telemetry output and confirm no prompts, responses, file paths, API keys, OAuth access tokens, or refresh tokens appear.

## Deferred

- Full external preview readiness.
- Broad abort-storm and long-running provider soak tests.
- Local/custom runtime adapter leak checks.
- Director-backed Claude SDK transcript partition hardening.
- Old Chat Agent full migration and old transcript import.
