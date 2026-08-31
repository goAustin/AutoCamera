# H3 VideoOps MVP — Luna Max Execution Index

This directory converts the full `LUNA_MAX_AI_VIDEO_AGENT_EXECUTION.md` brief into an MVP-first sequence that can be executed one phase at a time.

The immediate objective is a credible, locally runnable, resume-ready vertical slice. Real GPU generation and the broader production platform follow after the local MVP is stable.

## Instruction priority

When instructions disagree, use this order:

1. The latest user instruction.
2. This execution index.
3. `01-MVP-SCOPE.md`.
4. `02-TECHNOLOGY-CHOICES.md` and `03-ARCHITECTURE.md`.
5. The currently active phase document.
6. `../LUNA_MAX_AI_VIDEO_AGENT_EXECUTION.md` as the long-term reference.

The original specification remains authoritative for post-MVP work. The documents in this directory deliberately narrow its first release.

## Luna Max execution contract

Before executing a phase:

1. Read this file completely.
2. Read `01-MVP-SCOPE.md`, `02-TECHNOLOGY-CHOICES.md`, and `03-ARCHITECTURE.md` completely.
3. Read only the active phase file and any repository files it directly references.
4. Inspect the existing repository before editing. Preserve correct work from earlier phases.
5. Verify current package names and public APIs against official documentation before installing them. Pin exact versions in the lockfile.

While executing:

- Complete phases in order and do not begin the next phase until the current acceptance gate passes.
- Keep the repository runnable after every meaningful change.
- Prefer the smallest implementation that satisfies the current gate.
- Do not implement deferred features opportunistically.
- Do not require an LLM key, cloud account, GPU, or paid service for the MVP.
- Keep PostgreSQL authoritative for business state.
- Keep prompts, media, secrets, signed URLs, and raw model responses out of telemetry.
- Every mutation that can be repeated must have an idempotency key.
- Update the active phase checklist as tasks pass. Update the status table below only after its full gate passes.
- Do not mark the original nine-phase checklist complete for partial MVP work; track MVP status only in this file until the corresponding long-term gate is genuinely satisfied.
- If a phase is blocked solely by a missing local prerequisite, finish all unaffected work and document the exact prerequisite and retry command.

At the end of every phase, report:

- files created or changed;
- features completed;
- commands run and their results;
- acceptance criteria that passed;
- any remaining blocker or documented deviation;
- the exact next phase file, without executing it.

## Execution order and status

| Order | File | Outcome | Status |
|---|---|---|---|
| 1 | `10-PHASE-1-BOOTSTRAP.md` | Runnable monorepo, configuration, PostgreSQL, CI baseline | Complete |
| 2 | `20-PHASE-2-DOMAIN-API.md` | Durable project/storyboard/shot model and idempotent API | Complete |
| 3 | `30-PHASE-3-FAKE-GENERATION.md` | Durable generation queue, fake ComfyUI, evaluator, recovery | Complete |
| 4 | `40-PHASE-4-AGENT.md` | Deterministic Pi planning agent with scoped tools and budgets | Complete |
| 5 | `../PHASE-5-PROJECT-STUDIO-COMFYUI.md` | Project Studio, integrated ComfyUI, managed H3 workflows, durable operations, and E2E tests | Complete — offline gate green; remote live contract deferred to Phase 8 |
| 6 | `60-PHASE-6-RESUME-RELEASE.md` | Polished README, telemetry, demo evidence, tagged MVP | Complete — offline MVP release green; remote/H3 evidence deferred to Phase 8 |

Phase 1 bootstrap, Phase 2 domain/API, Phase 3 fake-generation, and Phase 4 Pi-agent
implementation and their ordered acceptance gates are complete. Phase 5's offline
implementation and verification gate are complete. The remote pinned ComfyUI contract
and real MiniMax H3 evidence were unavailable in this environment and, per the latest
execution instruction, are deferred to Phase 8. Phase 6's offline release gate is green.

After Phase 6, continue only when requested using `90-POST-MVP-ROADMAP.md`.

## Global MVP gate

The MVP is complete only when all of the following are true:

- `pnpm dev` launches PostgreSQL, the API/worker, fake ComfyUI, and web UI.
- A user can create a project, generate a deterministic three-shot storyboard, approve it, generate three placeholder clips, review them, accept them, and complete the project.
- Business state survives API and worker restarts.
- Repeated API requests and repeated fake ComfyUI events do not create duplicate attempts or decisions.
- Every generated artifact passes deterministic media checks before acceptance.
- The browser shows project status, shots, attempts, technical evaluation, estimated cost, and an event timeline.
- Unit, integration, and browser E2E tests pass without external credentials or a GPU.
- The README clearly distinguishes simulated generation from real H3 integration.
- The repository contains an architecture diagram, screenshots, a short demo script, and honest resume bullets.

## Suggested Luna Max invocation

Use a fresh execution request for each phase:

```text
Read docs/00-EXECUTION-INDEX.md and all documents it requires.
Execute docs/10-PHASE-1-BOOTSTRAP.md only.
Continue until its acceptance gate passes, then stop and report the handoff.
```

Replace the phase filename only after the prior phase is marked complete.
