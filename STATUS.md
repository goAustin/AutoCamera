# Release status

## Phase 6 — Resume-ready Project Studio release

Status: complete for the Offline fake evidence level (v0.1.0-mvp).

Phase 5's local Project Studio, fake ComfyUI, managed workflow, durable worker,
artifact/evaluation, recovery, and browser acceptance work is preserved and
green. The pinned remote ComfyUI contract was not available in this environment
and is intentionally deferred, together with real MiniMax H3 GPU generation, to
Phase 8. The release makes no H3-generation claim.

### Completed gates

- distributed trace context, stable spans, payload redaction, and exporter
  isolation;
- exact core Prometheus families with centralized bounded label validation;
- optional pinned OTel Collector, Tempo, Prometheus, and Grafana stack;
- deterministic fake seed, guarded reset, five-minute demo, and evidence
  manifest;
- Project Studio architecture/trust-boundary documentation and eight
  secret-reviewed offline screenshots;
- exact source pins, package/runtime record, license status, and truthful
  resume bullets;
- unit, integration, fake-Comfy, workflow, API/SSE/artifact, Pi, bridge, and
  browser verification commands.

### Verification record

| Check | Result |
|---|---|
| Frozen install | PASS |
| Prerequisite audit | PASS — Node 24.20.0, pnpm 9.15.0, Compose, ffmpeg/ffprobe, ports, and PostgreSQL |
| Unit suite | PASS — 25 files / 141 tests |
| PostgreSQL integration/restart suite | PASS — 5 files / 11 tests |
| Fake-Comfy HTTP/WebSocket contract | PASS |
| Browser E2E in fake mode | PASS — 5 tests, including 8 deterministic Project Studio captures |
| Grafana evidence | PASS — provisioned 11-panel dashboard rendered and visually reviewed |
| Live ComfyUI contract | SKIP — no configured pinned remote executor |
| Observability config and local stack | PASS — 4 pinned services, 11 panels; Grafana/Prometheus/Tempo readiness verified |
| Secret scan | PASS — 163 tracked/intentional files inspected |
| Documentation/evidence validation | PASS — 9 evidence screenshots and status language |
| Real H3 GPU smoke | NOT RUN — Phase 8 |

## Next document

docs/90-POST-MVP-ROADMAP.md is the next execution document. It is not part
of this Phase 6 implementation and has not been executed.
