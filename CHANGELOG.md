# Changelog

## A real clip, through the managed run path

Evidence level moves. Phase 8 step 2 ran on a rented RTX 5090
(`docs/85-PHASE-8-STEP2-RESULT.md`): `POST /v1/runs` accepted the pinned graph
with `validation: validated`, the in-process worker drove the real executor,
media evaluation passed, and the attempt reached `accepted` with a stored
artifact -- h264 960x544, 124 frames, 24 fps, 5.17 s, AAC 32 kHz stereo. That
is the profile default exactly. **This discharges row 2.12**, the only row that
can carry a real-generation claim.

**Phase 8 is still not complete.** Row 2.11 -- the six browser-bridge checks --
needs the section 5 gateway and an authenticated browser session, neither of
which was stood up. It is split into its own pass, which the runbook permits;
the gate is every row, so the gate is open.

- Topology A end to end on the rented host: PostgreSQL 16.15, Node 24.21.0,
  pnpm 9.15.0, migrations applied, ComfyUI bound to `127.0.0.1:8188` and never
  published. All five model files sha256-verified against the publisher's
  bytes, the turbo LoRA included.
- `COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live` **passed on its
  first-ever run** against a pinned remote executor.
- The budget breaker governed a real attempt: `budgetMicrousd` 3000000,
  `spentMicrousd` 0 -> 100000.
- Cost $1.315, of which about $0.80 was the meter running while nobody was
  driving it. The watchdog was armed throughout and the ceiling was never at
  risk, so the waste was bounded -- but bounded waste is still waste. A
  completed background wait is a work item, not a notification.

## The graph we ship, submitted to a real executor for the first time

Evidence level: **Real H3 inference, once, on rented hardware.** Phase 8 step 1
ran on an RTX 5090 (`docs/84-PHASE-8-STEP1-ATTEMPT2-RESULT.md`): the pinned
graph produced a 960x544, 124-frame, 24 fps clip with AAC 32 kHz stereo in 89
seconds, peak VRAM 31.9 GB of 32.6 GB, for $0.175. **This discharges no
acceptance-gate item** -- those clips came from ComfyUI directly over loopback,
not through the VideoOps managed run path, so gate row 2.12 is still open and
`STATUS.md`'s evidence level is unchanged.

- **`workflows/minimax-h3/api.json` could not be submitted to the pinned
  ComfyUI.** `UNETLoader` requires `weight_dtype`; the graph omitted it and the
  real executor answered `400 required_input_missing` on the first POST ever
  made to one. `editor.json` had the field all along, and the pinned
  `object_info` declared it required -- only the hand-maintained API graph
  drifted, because nothing offline could tell.
- **`apps/fake-comfy` accepted a graph the real executor rejects.** Its
  `/prompt` and `/api/prompt` handlers carried byte-identical blocks that
  validated `class_type` and nothing else. Both now call one
  `collectNodeErrors()` enforcing `input.required` from the pinned capture, and
  returning ComfyUI's own `required_input_missing` shape. A test submits the
  shipped `api.json` and expects acceptance, then the same graph with
  `weight_dtype` removed and expects the 400.
- **There were two `object_info` contracts.** `DeterministicFakeComfyService`
  defaulted to a hand-written sixteen-class stand-in, most entries with no
  input spec at all, so the eleven test files constructing their own service
  validated against the weaker one. It is deleted. The pinned capture -- a
  strict superset -- moved to `packages/comfy-client/fixtures/`, the layer that
  owns it, and is now the single default. The separately pinned fingerprints
  `bdc5637c...` and `4da7d975...` collapsed to one value.
- Every other test passed unchanged through the switch from sixteen classes to
  613, which is the evidence that the stricter contract costs nothing.

## Four hours of a rented GPU, in one bounded paragraph

Evidence level: Offline. No provider call was made -- every test runs against
the faux provider or an injected stub, and the faux provider prices its own
usage at zero (`providers/faux.js`: `cost: { total: 0 }`), so **the measured
cost of a digest in this checkpoint is 0 microusd and the token counts are the
faux provider's own estimates, not a real model's**. Closes step 4 of
`docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md`, and with it the last open item
in that checkpoint's acceptance gate.

- **`POST /v1/projects/:projectId/digest`** (`app.ts:3651`) runs one agent over
  a time window instead of one event, and returns a bounded, Zod-validated,
  sanitized struct: severity, title, detail, the run ids it actually read, the
  window, and the id of its own `agent_runs` row. Body is
  `{ sinceIso, untilIso? }`; `untilIso` defaults to now, so "digest the session
  I just finished" is one field. A window that ends before it starts is a 422.
- **The route is scoped, not `POST /v1/digest` as the spec wrote it.**
  `agent_runs.project_id` is `NOT NULL`, so a project-less digest cannot record
  the run row step 4 requires -- and would be invisible to the
  `inferenceCostMicrousd` figure step 5 added. Path scoping is also this API's
  own rule: every project-mandatory surface is nested, and `POST /v1/runs`
  carries a body `projectId` only because there the project is optional. The
  correction is recorded in the phase doc's step 4.
- **The window is applied to the services, not to the tools.**
  `createOperationalReadTools` is called exactly as the per-incident operator
  calls it and still returns six reads; `OperationalDigestService` wraps the
  services those tools read through, so `get_recent_incidents` -- the only
  time-varying one of the six -- sees only the window. Verified by mutation:
  deleting the window filter fails "bounds the evidence to the window rather
  than the project" and nothing else.
- **A run id the window does not contain is denied, not repeated.** The digest
  may cite only attempt ids that appear in the window's own incident rows;
  anything else the model supplies is dropped, on the same rule step 3 applied
  to out-of-scope tool arguments. Verified by mutation: disabling the
  intersection fails "denies a run id the window does not contain" and nothing
  else.
- **Three phases, so a retry cannot buy a second inference call.**
  `executeIdempotentDeferred` (`app.ts:1444`) reserves the `Idempotency-Key`
  and commits, runs the provider round trip with no transaction open and no
  pooled connection held, then commits the response -- step 3's discipline,
  applied to a route rather than to the outbox. A caller racing the same key
  reads the committed reservation and gets `409 IDEMPOTENCY_IN_PROGRESS`
  instead of a second paid run; a replay returns the first digest verbatim. If
  the work throws, the reservation is released, so a failure does not wedge the
  key. Verified by mutation against real PostgreSQL: swapping in the
  single-transaction `executeIdempotent` fails the race test, because the
  reservation is then never visible to another connection while the model runs.
- **Provider failure degrades rather than fails**, as the per-incident operator
  does: the run persists with its failure code and the caller still gets the
  lookup-table digest, which narrates only what the incident rows already say
  -- counts and event types -- because a fallback that guessed would be worse
  than one that summarises.
- **No new metric label.** A digest counts as `run_type: 'operator'` on the
  existing `pi_agent_runs_total`; it is the operator reasoning over a window
  instead of an event, and changing the metric label allowlist is an explicit
  non-goal of this checkpoint.
- **One implementation, two callers**, on the `redact.ts` precedent: the Pi-run
  bookkeeping both paths need -- transcript reading, usage totalling,
  telemetry adaptation, failure naming, and hosted-model resolution -- moved to
  `apps/api/src/pi-run.ts` unchanged, so adding a provider stays one edit.
  `operator.ts` behaviour is untouched; its suite proves it.
- 278 unit (27 files, was 266) and 22 integration (11 files, was 20).

## Monitoring spend cannot deny a generation, and a test that would notice

Evidence level: Offline. No provider call was made -- the new test seeds one
`agent_runs` row through the repository inside a transaction, the same way the
step 5 tests below already do. Closes the second half of the step 5 acceptance
gate in `docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md`, which the entry below
left open.

- **The admission half was asserted nowhere.** The gate reads "Inference spend
  is reported separately from attempt spend, *and budget enforcement still keys
  on attempt spend only*." The three tests in the entry below cover the first
  half only: every one of them reads `GET /cost` and none reaches
  `createAttempt`, and neither existing `BUDGET_EXCEEDED` test
  (`generation.test.ts:494`, `phase7a.test.ts:285`) seeds an `agent_runs` row.
  Denial ignoring inference cost was true by construction and pinned by
  nothing, which is exactly the property a later "total cost" refactor would
  break silently.
- **`phase7a.test.ts:299`** -- "admits an attempt against a project whose
  monitoring cost dwarfs its budget" -- budgets a project at exactly
  `DEFAULT_ESTIMATED_ATTEMPT_COST`, so it can afford one attempt and not one
  microusd more, then seeds an `agent_runs` row worth five times that whole
  budget. `POST /v1/runs` must return 201, no `project.budget_denied` event may
  be appended, and `GET /cost` must afterwards show `spentMicrousd` moved by
  exactly one attempt with `inferenceCostMicrousd` still at five times the
  budget. Any inference microusd reaching `nextSpend` flips the run to 409.
- **Verified by mutation, not by passing.** Folding
  `agentRuns.sumProviderCostMicrousd` into `createAttempt`'s `nextSpend`
  (`generation.ts:660`) fails this test and only this test -- 1 failed, 13
  passed in the file -- which is both the proof that the guard bites and the
  proof that the gap was real. `generation.ts` was restored; the test file is
  the only source change in this entry.
- **Correction to the entry below.** It claimed the zero-runs integration test
  pins the `COALESCE` in `sumProviderCostMicrousd`, "since that particular
  divergence is invisible to a unit test running only the in-memory store".
  It does not. Removing the `COALESCE` leaves all 20 integration tests passing,
  because `databaseNumber(result.rows[0]?.total ?? 0)` swallows the NULL on the
  JS side -- and `Number(null)` is `0` even without the `?? 0`. The `COALESCE`
  stays and the test stays; the sentence describing what guards what has been
  corrected in place.
- 266 unit (26 files, was 265) and 20 integration (10 files, unchanged).

## Two figures where there was one: what monitoring the incident cost

Evidence level: Offline. No provider call was made -- every fixture in the
new tests seeds `agent_runs` rows directly through the repository inside a
transaction, the same way `control-plane.test.ts` and
`domain-api.integration.test.ts` already seed other fixture rows. Closes
step 5 of `docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md`.

- **`GET /v1/projects/:projectId/cost` now reports `inferenceCostMicrousd` /
  `inferenceCostUsd`** alongside the existing budget/spent/remaining triple
  (schema at `app.ts:1738`, route at `:3477`) -- what the per-incident
  operator's own provider calls cost, summed across every `agent_runs` row
  for the project. It is a fourth, independent figure, never folded into
  `spentMicrousd` or a new "total": attempt cost is what the GPU rental
  bought, inference cost is what monitoring it cost, and the budget breaker
  in `infra/gpu-executor/README.md` section 8.5 only ever reads the former.
  `generation.ts`'s three `BUDGET_EXCEEDED` paths (`:676`, `:849`, `:1665`)
  are untouched -- they still read only `project.spentMicrousd` /
  `project.budgetMicrousd`, never `agent_runs`.
- **New repository method, not a reuse of `listByProject`.**
  `AgentRunRepository.sumProviderCostMicrousd(tenantId, projectId)`
  (`packages/db/src/index.ts:285`) is a `SELECT
  COALESCE(SUM(provider_cost_microusd), 0)` in Postgres, scoped by the
  existing `agent_runs_project_started_idx` index, and a `.reduce` over the
  in-memory store's map. `listByProject` returns every column of every row
  -- ids, timestamps, status -- to answer a question that needs one summed
  column, and a project accumulates one `agent_runs` row per operator
  trigger or digest for its whole lifetime, while `GET /cost` is a plain
  read a dashboard can poll. The `COALESCE` is deliberate -- a bare `SUM`
  over zero matching rows is `NULL` in Postgres, and the in-memory store's
  `.reduce` needs the same zero seed -- but it is belt-and-braces rather
  than the load-bearing guard, and this entry originally claimed otherwise:
  see the correction in the entry above. What
  `domain-api.integration.test.ts` pins against a real database is the
  observable contract -- `inferenceCostMicrousd` is the number `0` and never
  `null` -- together with the query's shape over a real BIGINT column.
- **No metric added.** The spec allows reusing
  `video_operator_recommendations_total` if a new counter can be justified;
  `GET /cost` is a pure read and none of its existing three fields emit a
  metric on read, so there was no event here to attach one to.
- Five new tests: three unit (`domain-api.test.ts`) covering zero agent
  runs, several runs summed, and the isolation guarantee -- an inference
  cost five times a project's whole budget must leave `spentMicrousd` and
  `remainingMicrousd` untouched, which a wrong implementation would either
  throw `NEGATIVE_MONEY` out of `subtractMicrousd` or silently corrupt; two
  integration (`domain-api.integration.test.ts`) proving the zero- and
  several-row cases against real PostgreSQL. 265 unit (26 files, was 262)
  and 20 integration (10 files, was 18).

## The evidence arrives with the prompt, and a denial says what to do

Evidence level: Offline fake. No provider call was made. Closes W6 and W7, the
last two slices of `docs/75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md`.

- **W6 — the operator stops re-reading what the adapter already read.**
  `resolveEvidence` loads project, shot, attempt and revision *before* the
  model is called -- it has to, since a missing row means there is no incident
  to reason about -- and then the model spent 2-4 tool calls fetching the same
  rows back. `describeOperationalEvidence` (`@h3/agent-tools`) renders them,
  and `operationalPrompt` appends the block to the run's first message. Rows
  the incident does not have are not rendered, so an `executor.unavailable`
  event is not handed an invented workflow revision.
- **The seeded rows are the tool's rows, not a second rendering of them.** Each
  view's sanitizer -- truncation, fallbacks, field order -- is now one function
  (`operationalProjectView`, `operationalShotView`, `operationalRevisionView`,
  `operationalAttemptView`) called by both the tool that returns it and the
  prompt renderer. A model that distrusts the seed and re-reads a row gets
  byte-identical JSON, which the test asserts literally: for each of the four
  tools, the prompt block contains `- <tool>: ${JSON.stringify(details.data)}`
  taken from that tool's own result. The tools stay available and
  authoritative; nothing is withheld.
- **W7 — a denial the model can act on.** `operationalDenied` returned
  `{"ok":false,"code":"SHOT_SCOPE_DENIED"}` and nothing else, which cannot
  distinguish "you asked about the wrong shot" from "this incident has no
  shot" -- so the model told them apart by guessing, at a turn each. Every
  denial now carries a `message` beside the code:

  | Denial | What the model now reads |
  |---|---|
  | scope denied, resource in scope | `get_shot_status is scoped to this incident: call it with shotId=<id>.` |
  | scope denied, none in scope | `... names no shot, so there is no other one to try -- conclude from the evidence you do have.` |
  | not found / unavailable | `The executor readiness for this incident is not readable. Retrying ... will not change that ...` |
  | invalid arguments | `get_attempt_status was not accepted. Fix these and call it again:` + a line per field + `It takes attemptId, and optionally projectId.` |

- **No scope rule changed.** The codes are the same codes, the
  `policy.denial` span event is unchanged, and `createOperationalReadTools`
  is still six reads. W7 adds a sentence to a result the model was already
  getting; the operator test asserts that sentence reaches the next request's
  transcript, which is the only place it matters.
- Three incidental dedupes, each one a place this change would otherwise have
  had to edit twice: `ToolDetails` and `OperationalToolDetails` were identical
  declarations of the same shape (the new `message` field would have gone into
  both), `operator.ts`'s `ResolvedOperationalViews` is now an alias of the
  exported `OperationalEvidenceViews` the renderer takes, and `runPi`'s
  evidence parameter is `ResolvedOperationalEvidence` rather than a fifth
  inline copy of the same five fields.
- **Review, two findings, both fixed here.** The scope denial named the
  *context key* rather than the tool's parameter, which diverge in exactly one
  place: the revision is `workflowRevisionId` in the event payload and
  `revisionId` on `get_workflow_revision_validation`. So a denial could send
  the model back with a parameter no tool takes -- W7 inverted. The two names
  now live in one table (`OPERATIONAL_SCOPED_PARAMETERS`) that the message
  reads, and the ad-hoc two-identifier branch is gone. `operationalPrompt`'s
  scope line had the same mismatch, pre-existing since step 3 and made likelier
  to be copied by putting the evidence block directly under it; it now says
  `revisionId=` too, asserted in both the tool test and the adapter test.
- **The W6 shape test now type-checks the shape it asserts.** It cast each
  resolved row `as never` to strip `| null`, which also erased the type: a
  service returning something else would still have compiled and still passed,
  in the one test whose whole point is that the seeded row and the tool result
  are the same shape. A typed `required()` helper keeps the runtime check and
  restores the static one -- swapping the shot row into the project slot is now
  a compile error.
- **Fixture identifiers are `as Uuid`, not `as never`.** The same blind spot
  as the shape test above, in the seven constants at the top of
  `operational.test.ts` -- `never` is assignable to every parameter, so they
  type-checked against any signature the tools might grow. This was the only
  file in the repo casting an identifier that way; every other `as never` is a
  deliberate wrong-type injection for an error path, and the rest of the suite
  builds a fixture id with `createUuidV7` or `as Uuid`.
- **A denial now reports the rule that failed, not the tool it failed in.**
  `get_shot_status` collapsed its project check and its shot check into
  `SHOT_SCOPE_DENIED`, so a model that got `projectId` wrong and `shotId`
  right was told to "call it with `shotId=<the id it just sent>`" -- no
  corrective information, and it resends the same call until the run's budget
  bound stops it. The three multi-check tools report each check separately.
  This also settles a double-count: `operationalProject` and
  `operationalResource` each emitted a `policy.denial` of their own before the
  caller emitted the code it actually returned, putting two events on the span
  for one denial and inflating any denial-rate metric. Both are pure now and
  `operationalDenied` is the only emitter.
- **Argument guidance now reaches the model at all.** W7's sentence naming
  what a tool takes was delivered on the one occasion it did not fit and never
  on the occasions it did. pi validates a call against the advertised TypeBox
  parameters *before* `execute` (`agent-loop.js:401-402`), so a wrong, missing
  or extra parameter was rejected by pi with its own generic `Validation
  failed for tool ...` and the guidance inside `execute` was unreachable. The
  single input that did reach `execute` was the reverse case -- TypeBox's
  `format: "uuid"` is laxer than zod's, so a UUID-shaped value with a bad
  version or variant nibble got through -- and it was answered with a sentence
  about parameter names the model had already got right, so the model resent
  the same call. The read tools now carry `prepareArguments`, for the same
  reason `submit_recommendation` does (N2): it runs ahead of pi's check, its
  throw becomes the call's error result with our wording, and returning parsed
  values makes pi's check a no-op. The six now-dead `safeParse` guards inside
  `execute` are gone, and a UUID bounce says to copy a scoped identifier
  rather than to compose a better-formed one.
- 5 new tests, unit suite 254 to 259, files unchanged at 26, then 3 more for
  the three findings above, 259 to 262; integration unchanged at 18 across 10
  files. Each of the 3 fails against the source it fixes and passes after,
  with every pre-existing test still passing.

## One redactor, two callers

Evidence level: Offline fake. No provider call was made. Removes the divergent
second copy of the redaction rules that the `51ee0c4` fix left behind.

- `safeRecommendationText` (`operator.ts`) and `redactFailureMessage`
  (`generation.ts`) were near-identical copies of the same rules, and had
  already drifted: the first gained a credential rule and a URL rule the
  second never got, and `51ee0c4` fixed the shared path pattern in one of
  them. Both now call `redactText` in the new `apps/api/src/redact.ts`,
  parameterised by cap and fallback -- 2,000 with a fallback for a
  recommendation, 500 with none for a failure message. The two old homes lose
  50 lines between them.
- What that changes for `redactFailureMessage`, whose inputs include two the
  codebase does not author -- ComfyUI's `exception_message`
  (`generation.ts:427`) and a human reviewer's rejection reason
  (`generation.ts:1240`):

  | Input | Before | After |
  |---|---|---|
  | `malformed in frames 3/5 and 4/5` | `frames 3[path redacted] and 4[path redacted]` | unchanged |
  | `Bad output and/or wrong ratio` | `and[path redacted] wrong ratio` | unchanged |
  | `the prompt was fine, the checkpoint was wrong` | `the prompt [redacted], the checkpoint…` | unchanged |
  | `collapsed at 1.2it/s` | `1.2it[path redacted]` | unchanged |
  | `api_key: sk-live-abc123` | **passed through** | `[credential redacted]` |

- Redaction strength is unchanged, and asserted as such: an absolute path from
  the GPU host, a `Bearer` token, and the API's own fixed sentences all
  produce byte-identical output before and after. The pre-existing assertion
  in `generation.test.ts` pins that and needed no edit.
- The sanitizer tests move to `apps/api/src/redact.test.ts` and gain the
  failure-message side: executor and reviewer text stays readable, a pasted
  credential is caught, a GPU-host path and a model URL still go, the 500-cap
  holds, and the two wrappers are shown to differ only in cap and fallback.
- Not a security fix. `attempt.failed` is not in `NOTIFIABLE_EVENT_TYPES`, so
  none of this leaves the machine, and the credential case requires a person
  to type a key into a rejection reason. The reason to do it is that two
  copies of one rule is how the next fix goes to only one of them again.
- 9 new tests, unit suite 245 to 254, across 25 files to 26 (the new
  `redact.test.ts`); integration unchanged at 18 across 10 files.

## Phase 7E step 3 follow-up — Review findings 2-4

Evidence level: Offline fake. No provider call was made. Closes the three
remaining review findings against `ad93d57`.

- **One normalization, everywhere (finding 2).** `prepareArguments`
  normalized its candidate before parsing; `validateOperationalRecommendation`
  and `describeOperationalRecommendationIssues` parsed the raw one. So a
  lower-case `recommendationCode` was accepted through the tool and reported
  as a violation by the exported helper, whose own doc called itself "the text
  handed back to the model on a bounce" for a bounce that never happened.
  `normalizeOperationalSubmission` moved inside
  `parseOperationalRecommendation`, which all three already shared, so the
  behaviour is now defined once. This also removes a tier-1/tier-2 asymmetry:
  a lower-case code recovered from the model's prose is now accepted the same
  way the tool accepts it.
- **The tier family's total is the operator's run count (finding 3).**
  `video_operator_output_tier_total` was incremented only in `persistOutcome`,
  while `pi_agent_runs_total` is also incremented in `recordDeferredOutcome`
  when a deferred run fails. The "Operator output tier" panel therefore
  under-reported against "Pi planning and operator runs" by exactly the number
  of findings lost to a persistence failure -- the case the code comment
  claimed the two stayed reconcilable for. `recordDeferredOutcome` now mirrors
  the increment with `tier: "error"`: whatever the model reached, no finding
  arrived.
- **Neither counter double-counts a lost COMMIT.** `withDatabaseTransaction`
  runs its callback and then commits, so `persistOutcome` can count a run and
  the transaction still fail afterwards -- which counted that run twice, once
  succeeded and once failed. `runDeferred` now records whether
  `persistOutcome` ran, and `recordDeferredOutcome` counts only when it did
  not. Pre-existing, and fixed here because the tier counter would otherwise
  have inherited it.
- **`OPERATIONAL_SUBMISSION_MAX_REJECTIONS` says what it counts (finding 4).**
  Its doc said "Consecutive"; the counter is cumulative across the run and is
  never reset by an accepted submission, which matches how Claude Code counts
  its structured-output retries. The distinction is unreachable in practice --
  a lone accepted submission terminates the batch -- and the comment now says
  so rather than describing a reset that does not exist.
- 2 new tests, unit suite 244 to 245 across 25 files (the tier assertion joins
  an existing case); integration unchanged at 18 across 10 files. Both were
  confirmed to fail against `51ee0c4`.

## Phase 7E step 3 follow-up — Stop the sanitizer garbling the model's own prose

Evidence level: Offline fake. No provider call was made. Fixes review finding
1 against `ad93d57`: a defect in `safeRecommendationText` that W1/W2 made
reachable rather than introduced.

- `safeRecommendationText` (`operator.ts`) matched **any** `/` as a filesystem
  path and the **bare word** "prompt" as prompt content. That was harmless for
  as long as tier 1 rarely worked, because every finding came from
  `defaultOutput()`'s fixed strings, which contain no slashes and never say
  "prompt". Once W1/W2 made the model's own conclusion the normal path, real
  prose started arriving here and being mangled in place:

  | Written by the model | Persisted before this change |
  |---|---|
  | `failed 3/5 times` | `failed 3[path redacted] times` |
  | `Retry and/or escalate` | `Retry and[path redacted] escalate` |
  | `Queue depth was N/A` | `Queue depth was N[path redacted]` |
  | `at 12/05 14:03 UTC` | `at 12[path redacted] 14:03 UTC` |
  | `2 frames/second` | `2 frames[path redacted]` |
  | `The prompt was rejected by the validator.` | `The [prompt redacted].` |

- Each rule now demands evidence it is looking at the real thing. A path has
  to start at a token boundary (`/var/lib/x`, `~/.config`, `C:\Users\x`), so a
  slash *inside* a token stays prose; a relative path is no longer redacted,
  which is the deliberate trade for those false positives. Prompt content has
  to sit behind an assignment (`prompt: …`, `raw prompt = …`, `"prompt": …`)
  rather than following the bare word. A URL rule was added ahead of the path
  rule so a signed URL goes whole instead of surrendering its query string to
  a rule that only understood slashes.
- Redaction strength is unchanged, and asserted in both directions: absolute,
  home and Windows paths, signed and non-http URLs, prompt assignments,
  `api_key:`/`Bearer` credentials all still go, and the fallback still applies
  when nothing survives. The five redaction cases pass against `ad93d57` too;
  only the seven prose cases fail there.
- This function also sanitizes the webhook body (`notify.ts:50`), so the same
  fix reaches an operator reading alerts rather than the panel.
- `redactFailureMessage` (`generation.ts:234`) carries the same path pattern
  and an even broader prompt rule. Left alone: it sanitizes executor failure
  messages, not model prose, and was not part of this finding.
- 14 new tests, unit suite 230 to 244 across 25 files; integration unchanged
  at 18 across 10 files. The seven prose cases were confirmed to fail against
  `ad93d57`.

## Phase 7E step 3 follow-up — Never discard a captured conclusion; measure the tier (W4, W5)

Evidence level: Offline fake. No provider call was made; every test runs
against `faux` or an injected `streamFnOverride` stub. Completes
`docs/75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md` except W6 and W7, which stay
recorded there.

- **W4 — a bound no longer throws away a finding the model already
  reached.** `runPi` consulted `submission.accepted()` only after the timeout
  and provider-error throws, so a run that captured a conclusion and *then*
  hit its wall clock, or whose next turn came back an error, persisted
  `defaultOutput()` and recorded `failed` — from the outside, identical to a
  model that never answered. Those throws are now conditional on there being
  nothing captured; when there is, the run succeeds with the model's own
  finding and the bound becomes `outcome` on the run span (`timed_out`,
  `budget_exhausted`, `provider_error`). The budget bound already survived
  W1's capture change; it is covered here as a regression guard rather than a
  fix. A bound that arrives before any submission still fails exactly as
  before — the rescue is conditional on a real capture, not a blanket
  downgrade.
- **W5 — degradation is measured, not assumed.**
  `video_operator_output_tier_total{tier}` joins `CORE_METRIC_NAMES` with the
  same vocabulary the run span's `result` attribute already used —
  `submitted`, `text`, `rejected_cap`, `none` — plus `error` for a run that
  failed before it could look and `faux` for the scripted provider, so the
  family's total is the operator's run count and `submitted / total` is the
  tier-1 capture rate the follow-up doc wants before revisiting the two-phase
  design. The counter is incremented beside `pi_agent_runs_total` in
  `persistOutcome`, so the two stay reconcilable when persistence itself
  fails; the tier travels out of `runPi` on the result, and on the thrown
  error the way `code` already does, because the failure codes cannot
  distinguish `rejected_cap` from `none`.
- An "Operator output tier" Grafana panel renders the new family, and the
  panel name is pinned in `scripts/validate-observability.ts` like the other
  eleven — a metric nothing displays is not visible.
- Metric labels are validated against the metric family's own allowlist, not
  `sanitizeTelemetryAttributes`, so `tier` needed no allowlist change. The
  span attribute still reports through the generic allowlisted `result` and
  `outcome` keys.
- 4 new tests, unit suite 226 to 230 across 25 files; integration unchanged at
  18 across 10 files, unmodified. The two W4 rescue tests were confirmed to
  fail against `9c4d8c5`; the negative control passes there, as it should.

## Phase 7E step 3 follow-up — Tool-use redesign for the operator (W1, W2, W8)

Evidence level: Offline fake. No provider call was made; every test runs
against `faux` or an injected `streamFnOverride` stub. Delivers W1, W2 and W8
of `docs/75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md`; W4, W5's remaining half,
W6 and W7 stay recorded there, not built.

Step 3's output path only worked when the model emitted its conclusion alone,
in the last assistant message. On either of two ordinary behaviours the
model's finding was discarded, silently replaced by the `faux` lookup table,
and the run recorded as `failed` — indistinguishable from the state before a
provider was wired in at all.

- **The conclusion is captured where the tool runs, not by message position
  (W1/N1).** `submissionArguments` inspected only the last assistant message,
  which was sound only if `terminate: true` reliably stopped the loop. It does
  not: pi terminates a batch only when *every* finalized call in it terminates
  (`agent-loop.js:376`), so a model that emitted `get_project_status` and
  `submit_recommendation` in one message — ordinary parallel tool calling —
  took another turn and left its submission behind. `createOperationalSubmissionTool()`
  now returns an `OperationalSubmission` handle whose `execute` records the
  validated params; `operator.ts` reads `submission.accepted()` as tier 1 and
  `submissionArguments` is gone. `terminate: true` stays, as a turn-saving
  optimisation nothing depends on.
- **`prepareArguments` is the sole validator, and a rejection is a retryable
  bounce (W2/N2/N3).** A schema-perfect conclusion was being thrown away over
  a repairable detail: one volunteered extra key, or a `detail` past the 2,000
  cap that `completeRun` was about to truncate anyway. Pi runs
  `prepareArguments` before its own argument check (`agent-loop.js:401-402`)
  and turns a throw there into the call's error result with our wording
  (`:446`), so the tool now normalizes what is cosmetic — unknown keys
  stripped, whitespace trimmed, `recommendationCode` upper-cased — and hands
  anything that would change what the finding *says* back to the model as a
  field-by-field list naming the received value and the actual overage
  (`describeOperationalRecommendationIssues`). Lengths bounce rather than
  clamp: a `detail` cut mid-sentence reads as authoritative and is worse to
  hand an operator than a canned one. The advertised TypeBox schema stays
  maximally precise — it is what steers the model, and it now costs nothing.
- **Bounded retries with a distinct outcome (W2/N4).**
  `OPERATIONAL_SUBMISSION_MAX_REJECTIONS` (5, Claude Code's
  `MAX_STRUCTURED_OUTPUT_RETRIES` default) stops the run through the same
  `shouldStopAfterTurn` hook the budget bound uses — `AgentOptions` takes one.
  The run span now records which tier produced the finding on the allowlisted
  `result` key (`submitted`, `rejected_cap`, `text`, absent when the run
  failed before looking), so "the model never submitted" and "we kept bouncing
  it" are no longer the same observation. `outcome` still carries how the run
  *ended*.
- `operationalRecommendationSchema` drops `.strict()`; unknown keys are
  stripped before it, which also makes tier 2 consistent with tier 1. The
  system prompt no longer says "exactly once" — a model told that will not
  take the corrective retry the bounce is asking for — and the field limits
  now sit in the tool `description` as well as the schema.
- **Behaviour matrix (W8).** The five tier-1/tier-2 tests in
  `operator.test.ts` are replaced by one table over 11 model behaviours, each
  asserting the persisted finding, the run status, the failure code and the
  span's tier. Rows 2, 3 and 4 are the regression tests for the two defects
  and were confirmed to fail against `9e94d0d` with every pre-existing test
  still passing there (6 rows fail at baseline: 2, 3, 4, and 5, 7, 8 — the
  same two defects in other shapes). The fixture the model "authors" now
  differs from `defaultOutput()` in severity, title and action, so a row can
  tell them apart; step 3's fixture was identical to the fallback.
- 9 new tests, unit suite 217 to 226 across 25 files (no new file);
  integration unchanged at 18 across 10 files, unmodified.

## Phase 7E step 3 review follow-up — deferred-run isolation, bounds, and signal

Evidence level: Offline fake. No provider call was made; every test runs
against `faux` or an injected `streamFnOverride` stub. Fixes the review
findings on step 3 that are not about tool design; the two tool-design defects
are planned separately in
`docs/75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md` (W1/W2/W8) and are untouched
here.

- **The model call now runs with no transaction open at all.** Step 3 moved it
  out of the outbox *claim* transaction but still wrapped it in one of its own,
  so `withDatabaseTransaction` held a pooled client with `BEGIN` open across
  the whole provider round trip — only the first half of the
  `OutboxConsumer.afterCommit` contract in `packages/db/src/index.ts`, which
  names the claimed row's lock *and* the pooled connection.
  `completeRun` split into `runModel` (no repositories) and `persistOutcome`;
  `runDeferred` now runs three phases — a short transaction for the guards and
  evidence, the model call with nothing held, then a short transaction to
  persist. `faux` is unchanged: `completeRun` still composes both halves inside
  the caller's transaction.
- **The read tools each get their own short transaction** on the deferred path
  (`storeBackedServices`), so the agent loop holds no connection *between* tool
  calls either. `getExecutorReadiness` is the one remaining case that spans a
  network call, documented in place; it reaches ComfyUI rather than PostgreSQL
  and is bounded by `COMFY_REQUEST_TIMEOUT_MS`.
- **A failed deferred run is no longer silent.** The design deliberately leaves
  the run visibly `'running'` with nothing to retry, so that signal was the
  only one — and it reached nowhere: no logger on the adapter, no metric
  (`pi_agent_runs_total` is incremented inside `completeRun`, which never runs
  on that path), `BufferedSpan.setStatus` drops the error object, and with no
  OTLP endpoint no span is exported at all. `completeDeferredRun` now
  increments `pi_agent_runs_total{status="failure"}` and records `failureCode`
  as a span attribute.
- **`completeDeferredRun` cannot throw.** Its telemetry calls sat outside its
  own try/catch; a throw would have reached `pollOnce` and from there the
  outbox worker's unawaited `run()`. Span creation and the outcome record are
  both isolated now, and the span continues the trigger event's `traceId` like
  every other operator span instead of starting a detached trace.
- **The webhook no longer queues behind the model call.**
  `NotifyingOutboxConsumer.afterCommit` forwarded to the inner consumer first,
  so an `executor.unavailable` alert waited for an unrelated DeepSeek round
  trip. The two side effects are independent and now run concurrently under
  `Promise.allSettled`, with the forward wrapped so a throwing inner consumer
  is recorded on an `operator.notify.inner` span rather than escaping — the
  class doc claimed sole ownership of the "never throw" rule, which the
  unguarded forward had made false.
- **A run that keeps calling tools is now bounded by spend, not the wall
  clock.** Pi's loop already ends when the model stops calling tools
  (`dist/agent-loop.js:132`), the same condition Claude Code uses, so no turn
  cap is wanted; what it lacks is a bound on a model that does not stop.
  `maxRunCostMicrousd` (default 50,000 = $0.05, ~100x the recorded spike) and
  `maxRunTokens` (default 200,000) stop the run at the next turn boundary
  through Pi's `shouldStopAfterTurn` hook. The token limit is not redundant:
  a provider that reports no cost would disable the cost ceiling silently.
  Neither is wired to an environment variable yet.
- `processEvent` now documents that it is only the first half of a non-faux
  run — it returns no `recommendation` and leaves a `'running'` row that only
  `completeDeferredRun` finishes. Two integration tests call it directly and
  pass only because the default provider is `faux`.
- Telemetry note: `sanitizeTelemetryAttributes` silently drops keys outside its
  allowlist, and `SENSITIVE_ATTRIBUTE_KEY` rejects anything containing "token"
  as credential-shaped. The budget event therefore reports through the generic
  allowlisted `outcome`/`value`/`max` keys rather than extending the allowlist.
- 7 new tests, unit suite 210 to 217 across 25 files (no new file); integration
  unchanged at 18 across 10 files. Each of the 6 behavioural tests was checked
  against a simulated pre-fix build and fails there; the 7th is the negative
  control for the budget bound.

## Phase 7E step 3 — A real provider behind the per-incident operator

Evidence level: Offline fake for automated verification — every test in this
checkpoint runs against `faux` or an injected `streamFnOverride` stub, never
a paid call. No real DeepSeek request was made during this work; the
`deepseek-v4-flash` tool-calling spike recorded earlier in
`75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` (3 runs, 13,488 tokens, $0.00135
total) is the only real-provider evidence this checkpoint relies on, and it
predates this change. `.env` on this workstation already carries
`PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-v4-flash`, and a `DEEPSEEK_API_KEY`
— set by that earlier spike, not by this session — so `pnpm dev` will now
route real operator findings through DeepSeek the next time an operational
trigger fires; a real call was neither made nor required to finish this
checkpoint.

- Replaced the `PROVIDER_ERROR` throw for any non-faux provider
  (`operator.ts`, old `runPi:873-878`) with a real path: `runPi` now branches
  on `this.provider === 'faux'` (`operator.ts:643`) and, for anything else,
  resolves a model via `resolveHostedModel` (`operator.ts:1235`) — DeepSeek
  through `@earendil-works/pi-ai/providers/deepseek`'s `deepseekProvider()`
  registered into a fresh `createModels()`, or a test-only
  `streamFnOverride` when one is supplied, regardless of `this.provider`'s
  value. Unsupported provider strings still throw `PROVIDER_ERROR`.
- `PI_API_KEY` resolution moved into `packages/config` (`index.ts:120`):
  when `PI_PROVIDER=deepseek` and `PI_API_KEY` is unset, `DEEPSEEK_API_KEY`
  is the fallback, checked in both the "non-faux requires a key" validation
  and the resolved `ApiConfig.piApiKey`. The key is threaded through
  explicitly, on every stream call (`operator.ts`'s `streamFn` wrapper merges
  `apiKey: this.apiKey` into stream options), not read from `process.env` by
  the adapter or left to Pi's own ambient env lookup — so a `PI_API_KEY`
  without a matching `DEEPSEEK_API_KEY` still works, which ambient
  resolution alone would not have caught. `app.ts` now constructs the
  operational adapter from `config.piProvider` / `config.piModel` /
  `config.piApiKey` instead of a hardcoded `'faux'`. Fixed the stale
  `PI_MODEL` default (`h3-videoops-storyboard-v1`, a Phase 4 planner label
  meaningless after 7D) to `h3-videoops-operator-v1`; `.env.example` now
  documents the DeepSeek variables next to it.
- Output handling (`operator.ts:1271-1420`), settled by what Pi can actually
  do: `openai-completions` never sends `response_format`, and `ToolChoice`
  has no `"required"`, so neither API-level structured output nor a forced
  tool call is reachable. Added a terminal `submit_recommendation` tool
  (`createOperationalSubmissionTool`, `packages/agent-tools/src/index.ts`)
  whose TypeBox parameters are the recommendation schema and which returns
  `terminate: true`, in a **separate factory** from
  `createOperationalReadTools` so "the read tools are reads only" stays a
  property a test asserts, not a judgement call. Three-tier degradation: (1)
  `submit_recommendation` arguments, read straight off the tool-call content
  block (`submissionArguments`, `operator.ts:1301`) — no text parsing; (2)
  else tolerant extraction — strip fenced code blocks, scan for the last
  brace-balanced JSON object ignoring braces inside string literals
  (`stripFencedCodeBlocks` / `lastBalancedJsonObject`) — then the same
  strict `validateOperationalRecommendation`; (3) else throw
  `INVALID_STRUCTURED_OUTPUT`, which the existing `defaultOutput()` fallback
  in `completeRun` (old `processEventInTransaction`) already covers.
  `validateOperationalRecommendation` stays the sole authority at every
  tier — the tool schema steers the model, it never approves the result.
- Fixed the other three defects a real spike run surfaced against the old
  code, none of them DeepSeek's fault: the system prompt now states the
  five required fields and instructs a single `submit_recommendation` call
  (`OPERATIONAL_SYSTEM_PROMPT`, `operator.ts:1271`); the user prompt seeds
  the scoped `projectId`/`shotId`/`attemptId`/`workflowRevisionId` the
  adapter already holds instead of the old bare `Review durable event
  {id}.` (`operationalPrompt`, `operator.ts:1284`) — the tools still deny an
  out-of-scope identifier the model supplies regardless, so this narrows
  guessing, not scope.
- Moved the model call out of the outbox claim transaction, the prerequisite
  step 2 follow-up recorded and deferred here. `processEventInTransaction`
  now only resolves evidence and commits an `agent_runs` row with status
  `'running'` before returning (`operator.ts:576`, non-faux branch at
  `:643`); the model call, recommendation, `recommendation.created` event,
  and outbox enqueue all move into `completeDeferredRun`
  (`operator.ts:675`), which `OperationalOutboxConsumer.afterCommit` calls
  once the claim transaction has committed — never inside it. `faux` is
  exempt and keeps running synchronously in the claim transaction unchanged,
  since every existing test and the whole faux contract depends on that.
  `completeDeferredRun` re-checks the `existing` recommendation and the
  run's `'running'` status before proceeding, and — matching the
  `afterCommit` contract `NotifyingOutboxConsumer` established in step
  2 — never throws; a failure here leaves the run visibly `'running'`
  rather than losing it silently, deliberately preferring a visible stuck
  run over a duplicated paid model call. `NotifyingOutboxConsumer.afterCommit`
  (`notify.ts`) now forwards to `inner.afterCommit` first: without this fix,
  composing the webhook with a non-faux operator would have silently
  dropped the deferred model call.
- Verified against PostgreSQL
  (`apps/api/src/operator.deferred.integration.test.ts`, modeled on the
  step-2-follow-up webhook test): across two separate trigger events, a
  second connection's count of `'running'` `agent_runs` rows was `1` at the
  moment each model call started — proving the claim transaction had
  already committed by then, for both calls, not just the first.
- `agent_runs.provider` / `.model` were already persisted on `create()`
  (`packages/db/src/index.ts:2654`, columns `$7`/`$8`); this checkpoint
  exercises that path for a non-faux provider for the first time and adds
  the assertion.
- 20 new tests: 1 unit (`config.test.ts`, the four `PI_API_KEY` /
  `DEEPSEEK_API_KEY` combinations), 2 unit
  (`packages/agent-tools/src/operational.test.ts`, the submission tool and
  the read-tools-stay-read-only assertion), 8 unit (`operator.test.ts`, the
  non-faux paths above), 1 unit (`notify.test.ts`, the `afterCommit`
  forwarding fix), 1 PostgreSQL integration
  (`operator.deferred.integration.test.ts`). Unit suite 198 to 210 across 25
  files (no new unit file); integration 17 to 18 across 9 to 10 files.
- Not built here, staying step 4/5: `POST /v1/digest` and separating
  inference spend from attempt spend on `GET
  /v1/projects/:projectId/cost`.
- Recorded, not a defect: `.env`'s `DEEPSEEK_API_KEY` reaches the API server
  process for `pnpm dev` (`scripts/dev.ts` loads `.env` into `process.env`
  before spawning it) but not for `node dist/main.js` directly, which has no
  such loader. `~/.zshenv` (not `~/.zshrc`, which does not source for
  non-interactive shells) is the alternative for that path; nothing in this
  checkpoint changes server startup.

## Phase 7E step 2 follow-up — delivery leaves the outbox transaction

Evidence level: Offline fake. No provider call was made. Resolves the
"Recorded, not fixed" item in the step 2 entry below. No change to the
operator, the trigger set, the isolation rule, leases, retries,
reconciliation, evaluation, SSE transport, or the metric allowlist.

- `OutboxConsumer` gains an optional `afterCommit(message)`
  (`packages/db/src/index.ts:5091`), which `OutboxDispatcher.pollOnce` calls
  after `withTransaction` resolves and only for a message that committed as
  delivered. `NotifyingOutboxConsumer.consume` is now a pass-through to the
  operator and the webhook POST moved to `afterCommit`, so the round trip
  holds no open transaction, no pooled connection, and no lock on the
  claimed outbox row. The finding's title and detail are read back through a
  short transaction of the consumer's own — a `store`, newly passed from
  `app.ts` — instead of borrowing the claim transaction.
- Two properties come free with the reordering. A notification can no longer
  announce a finding that rolled back: `afterCommit` runs only on the
  delivered path, where the pre-fix code delivered from inside a transaction
  that might still fail to commit. And `OperationalOutboxWorker.run`, which
  polls serially, no longer queues every operational message behind one slow
  webhook.
- Contract, normative: `afterCommit` must not throw. The message is already
  delivered, so there is nothing for the outbox to retry, and
  `NotifyingOutboxConsumer` stays the single owner of swallowing — the same
  rule step 2 established for delivery failures, applied one step later.
- Verified against PostgreSQL (`apps/api/src/notify.integration.test.ts`):
  while the webhook is being called, a second connection already counts the
  finding as committed, for both the `executor.unavailable` and the
  `recommendation.created` message. The same measurement read zero before
  this change. The test records every delivery rather than only the last,
  which is what makes it fail under the old ordering — proven by mutation:
  restoring the in-transaction call yields `[0, 1]` against an expected
  `[1]`.
- Not fixed, and now step 3's: the operator's own provider call still runs
  inside the claim transaction. `agentRuns.create` commits before `runPi`
  (`operator.ts:679` and `operator.ts:696`), so moving the model call out is
  a multi-transaction run state machine — the in-flight run row committed
  before the call, updated after — not a reordering. Against `faux` that
  buys nothing measurable, so it is specified in step 3 rather than designed
  here.
- Three new tests: 2 unit (`notify.test.ts`), 1 PostgreSQL integration.
  Unit suite 196 to 198 across 25 files; integration 16 to 17 across 8 to 9
  files.

## Phase 7E step 2 — A finding reaches a webhook without the panel

Evidence level: Offline fake. No provider call was made; the operator still
runs against `faux`. Additive only, composed alongside the existing outbox
consumer only when configured — no code change to the worker, leases,
retries, reconciliation, evaluation, SSE transport, or the metric
allowlist. A configured webhook does change the worker's timing; that is
recorded below, not fixed here.

- Added `NotifyingOutboxConsumer` (`apps/api/src/notify.ts`), wrapping the
  existing `OperationalOutboxConsumer` behind the single `OutboxDispatcher`
  when `NOTIFY_WEBHOOK_URL` is configured. Isolation rule, normative: the
  operator's `consume()` runs first and is authoritative — its errors still
  propagate so the outbox retries the message — and the notifier's errors
  are caught, recorded on an `operator.notify` telemetry span, and
  swallowed. A failed webhook call therefore never fails the outbox message
  and never re-runs the operator (a second paid inference call, once a real
  provider lands) for the same event. Verified with a permanently
  unreachable webhook: the finding still commits, the operator runs exactly
  once, and the outbox still drains.
- Notifies on `recommendation.created`, `project.budget_denied`, and
  `executor.unavailable`; no success event is notified.
  `project.budget_denied` is not in `OPERATIONAL_TRIGGER_EVENT_TYPES`, so a
  webhook is the only way it reaches an operator who is not polling.
  `executor.unavailable` is notified twice by design — once as the raw
  trigger, again once its `recommendation.created` finding exists.
- `WebhookNotificationDelivery` POSTs one bounded JSON body with a
  configurable timeout: `NOTIFY_WEBHOOK_URL` (unset disables notification
  entirely), `NOTIFY_TIMEOUT_MS` (default 5000). Unset leaves the dispatcher
  byte-for-byte the pre-step-2 consumer, not merely a no-op wrapper. Works
  with ntfy, Slack, Discord, or a local listener; no SMTP dependency.
- Redaction: every text field in the notification body is run through the
  existing `safeRecommendationText` (now exported from `operator.ts`, the
  same sanitizer already relied on for persisted recommendation
  title/detail), and a `recommendation.created` body looks up the finding's
  title and detail so the notification reads as something other than a bare
  identifier dump. Verified with a seeded recommendation whose detail
  contains a bearer token, a `token=` credential, and a filesystem path:
  none of the three raw values reach the delivered body.
- Recorded, not a hostname filter: `safeRecommendationText` has no
  hostname-matching rule — its bearer, credential, path, and prompt patterns
  do not cover a bare private hostname embedded in free text. Nothing in
  this codebase writes a hostname into recommendation title/detail today, so
  this is a latent gap for whatever step 3's real model produces, not a
  regression.
- Recorded, not fixed — delivery runs inside the outbox transaction.
  `OutboxDispatcher.pollOnce` (`packages/db/src/index.ts:5100`) wraps
  `consume()` in `store.withTransaction`, so the webhook POST executes
  between `BEGIN` and `COMMIT`. Measured against the live database with a
  600ms stub webhook: a second connection counted zero
  `operational_recommendations` rows mid-delivery and one after, and
  `pollOnce()` took 680ms. A pooled connection therefore sits
  idle-in-transaction holding the claimed outbox row for the whole round
  trip, and because `OperationalOutboxWorker.run` polls serially, a slow
  webhook is head-of-line blocking for the whole operational outbox — up
  to `NOTIFY_TIMEOUT_MS` per notifiable message, two messages per
  finding, and the config admits 120_000. `stop()` awaits `currentWork`,
  so shutdown inherits the same delay. Delivery also fires before the
  commit, so a transaction that then fails to commit has already sent a
  notification for a finding that rolled back, and the retry sends a
  second one. None of this violates the isolation rule, which fixed
  whether a notifier failure propagates, not when delivery runs. Deferred
  to step 3 rather than fixed here: the fix is a post-commit hand-off,
  and step 3 forces that work anyway — `runPi` (`operator.ts:696`) is
  called from inside the same transaction, so a real provider puts a
  multi-second inference call between the same `BEGIN` and `COMMIT`,
  against which the notifier's 5s is the smaller half.
- Prerequisite finding from step 1, resolved: deleted the `UNIQUE_VIOLATION`
  recovery branch (old `operator.ts:776-798`), dead code on PostgreSQL
  because `PostgresOperationalRecommendationRepository.create` does not
  translate `23505` and `withDatabaseTransaction` has no `SAVEPOINT` to
  survive it. A genuine collision now aborts the transaction and relies on
  retry, which the code already did correctly by falling through to the
  `existing` check. Added the PostgreSQL-side test step 1 could not write
  (`apps/api/src/operator.integration.test.ts`): it forces a real `create()`
  call to collide with an already-committed row, asserts the raw error
  carries Postgres code `23505`, and asserts a subsequent retry resolves to
  the committed winner without a second event or a second model run.
  Rewrote the corresponding unit test in `operator.test.ts`, which exercised
  the now-deleted branch, to the same shape against `InMemoryStore`.
- Fifteen new tests: 13 unit (`notify.test.ts`), 1 unit (`config.test.ts`,
  the `NOTIFY_WEBHOOK_URL`/`NOTIFY_TIMEOUT_MS` config surface), 1 PostgreSQL
  integration. The `operator.test.ts` UNIQUE_VIOLATION test was rewritten in
  place, not added. Unit suite 182 to 196 across 24 to 25 files; integration
  suite 15 to 16 across 7 to 8 files.

## Phase 7E step 1 — A finding enters the timeline

Evidence level: Offline fake. No provider call was made; the operator still
runs against `faux`. Additive only — no change to the worker, leases, retries,
reconciliation, evaluation, SSE transport, or the metric allowlist.

- The operator now emits `recommendation.created` when it persists a finding,
  carrying `{ recommendationId, severity, recommendationCode,
  proposedActionType, triggeringEventType }`. Until now a finding was written
  to `operational_recommendations` and announced nowhere: it never reached
  `domain_events`, never reached `outbox_events`, and was visible only to a
  client polling the recommendations route. On a rented GPU running
  asynchronously, nobody is polling.
- The event is emitted once per persisted finding, inside the same transaction,
  and only after the insert succeeds — neither duplicate path announces a
  finding twice. `domain_events` is append-only, so an emit on the duplicate
  path would append another announcement on every outbox retry of the same
  message.
- `recommendation.created` is deliberately absent from
  `OPERATIONAL_TRIGGER_EVENT_TYPES`; a test proves the operator returns
  `not_trigger` for its own output rather than looping on it. This is free
  today under `faux` and will not be once a paid provider is wired in.
- Five unit tests and one PostgreSQL integration test. Each was verified by
  mutation — breaking the implementation fails them — including the SSE test,
  which guards an allowlist (`SSE_PAYLOAD_KEYS`) that drops unregistered
  payload keys silently. Unit suite 177 to 182; integration suite 14 to 15.
- Recorded, not fixed: the `UNIQUE_VIOLATION` recovery branch at
  `operator.ts:776-798` is unreachable under PostgreSQL. The repository does
  not translate `23505` into a `RepositoryError`, and the transaction is
  aborted by the violation regardless, so the recovery query inside the catch
  would fail with `25P02`. A collision still resolves correctly by retry, and
  the branch predates this checkpoint. The test covering it is meaningful only
  as a guard on the emit's placement, not as proof the branch works.

## Unreleased — correctness and documentation

Evidence level: Offline fake. No behaviour change to the durable core beyond
the evaluator fix below.

- Fixed the media evaluator's motion check, which could not fail.
  `blackdetect` and `freezedetect` report at info level while the probe ran at
  `-v error`, so their output never reached the parser and any artifact that
  decoded was recorded as having motion. An all-black clip passed. The probe
  now runs at info, and a `freeze_start` with no duration — what a clip frozen
  through to end-of-file produces — counts as evidence on its own.
- Fixed the browser suite overwriting published evidence. Three specs wrote
  captures straight into the tracked `assets/screenshots/`, so an ordinary
  `pnpm test:e2e` rewrote 12 published images, including the README's. Captures
  now go to the ignored `test-results/` tree unless `CAPTURE_EVIDENCE=1`.
- Fixed `01-editor-loaded.png` capturing the ComfyUI splash screen instead of
  the editor. `#splash-loader` covers the canvas until the Vue app mounts, and
  `app.rootGraph` is populated before it clears, so waiting on the JS objects
  alone photographed the splash. The failure was order-dependent and appeared
  only in the full suite. Every capture is now size-checked.
- Removed `comfy-frontend/03-graph-to-prompt.png`. `app.graphToPrompt()` is a
  pure read with no visual effect, so its capture was the same image as
  `02-h3-template-open.png` by construction. The export assertion remains;
  only the duplicate image is gone. Published captures: 13 to 12.
- Fixed a Phase 7A integration assertion that expected `acceptedAttemptId`
  after a run was reviewed `rejected` and pinned. Pin sets `pinnedAttemptId`;
  only human acceptance sets `acceptedAttemptId`. The test contradicted the
  design it was testing.
- Rewrote `README.md` for users rather than reviewers, moved `RESUME.md` out of
  the tracked tree, reframed `EVIDENCE-MANIFEST.md` as release provenance, and
  brought `STATUS.md` up to date. `validate-docs.ts` no longer requires
  completed-phase phrases that went stale as soon as the next checkpoint
  landed, and now requires every capture to be accounted for in the provenance
  manifest rather than enumerated in the README.
- Cleared the `format:check` baseline, which had been failing on five files and
  taking `pnpm check` and `pnpm release:verify` down with it.

## Phase 7D — Remove the brief-first product

Evidence level: Offline fake. The creative-brief workflow is gone. What remains
is a durable execution and monitoring record for a ComfyUI executor running on
a separate GPU host. Net -5,561 lines, with no change to the durable core.

**Breaking — removed API routes.** Ten registrations:

- `POST   /v1/projects/:projectId/plan`
- `GET    /v1/projects/:projectId/storyboard`
- `POST   /v1/projects/:projectId/storyboard/approve`
- `GET    /v1/projects/:projectId/shots`
- `GET    /v1/projects/:projectId/shots/:shotId/workflow-draft`
- `PUT    /v1/projects/:projectId/shots/:shotId/workflow-draft`
- `GET    /v1/projects/:projectId/shots/:shotId/workflow-revisions`
- `POST   /v1/projects/:projectId/shots/:shotId/workflow-revisions`
- `POST   /v1/projects/:projectId/shots/:shotId/managed-attempts`
- `POST   /v1/attempts/:attemptId/regenerate`

`POST /v1/shots/:shotId/attempts` is unaffected, as are the revision-scoped
`GET /v1/workflow-revisions/:revisionId` and its `/validate`.

- Extracted `RunView` as a single implementation used by both the ComfyUI
  sidebar panel and the standalone route, carrying playback, retry, findings,
  and the recovery path.
- Deleted the Pi planning agent, the `PlanningAgent` interface,
  `StaticStoryboardPlanner`, the storyboard domain and repository types, and
  nine web components.
- Added migration `0009`, which drops the `0006` CHECK constraint first —
  it references the column being dropped — then converts non-implicit shots to
  implicit rather than dropping them, preserving each row with its attempts and
  events.
- Kept deliberately: `POST /v1/projects` with `budgetUsd` and its `/cost`
  route, the only way to arm cost enforcement against a metered GPU;
  `apps/fake-comfy` and `COMFY_MODE=fake`, which is the entire local loop on a
  workstation with no GPU; the evaluator; the operator adapter; telemetry; the
  three audit invariants; and `agent_runs`.
- The five planner-era strings remain in `DOMAIN_EVENT_TYPES`. `domain_events`
  is append-only and `parseDomainEventType` throws on an unknown value, so
  removing them would not delete old rows — it would make them unreadable,
  taking the event timeline and SSE replay with them. The emitters are gone;
  the strings are a retention schema, not an API surface.

## Phase 7C — ComfyUI-first plugin inversion

Evidence level: Offline fake. ComfyUI is the graph-shell entry point and the
VideoOps panel is an exact-origin Studio iframe. The integration now exposes a
managed Run action, run history/detail, pin/review, findings, revision restore,
and read-only status surfaces while keeping the bearer token in Studio.

- Added the inverted child/parent bridge contract with origin, nonce, replay,
  payload-size, and credential-field validation.
- Added the pinned-frontend plugin surfaces and native queue refusal without
  monkey-patching unsupported frontend internals.
- Added the ComfyUI-first browser acceptance test and screenshots.
- Kept the standalone Studio fallback and Phase 5 routes available.

Known limitation: the pinned frontend exposes no supported queue interception
hook and its topbar badge metadata is static. Native queue controls are
disabled; live status values are carried through the Studio-fed bottom-panel
bridge. Remote ComfyUI compatibility and real H3 GPU generation remain
deferred to Phase 8.

## v0.1.0-mvp — Phase 6 Offline fake release

Evidence level: Offline fake. The release demonstrates the deterministic fake
ComfyUI path through Project Studio, VideoOps durable orchestration, immutable
workflow revisions, queue leases, recovery, artifact evaluation, human review,
Pi recommendations, tracing, bounded metrics, and browser E2E.

- Added a deterministic seed/reset workflow and a five-minute demo.
- Added redacted distributed telemetry, Prometheus metrics, and an optional
  pinned local observability stack.
- Added architecture, dependency/pin, evidence, status, and resume records.
- Added eight deterministic offline screenshots and a manifest.
- Preserved explicit fake and remote executor modes and the private worker-only
  execution boundary.

### Known limitations

- The pinned live ComfyUI backend/frontend contract was SKIP in this
  environment because no remote executor was configured.
- No real MiniMax H3 clip was generated; model weights and GPU runtime are not
  bundled. Both remote contract validation and real H3 smoke are deferred to
  Phase 8.
- Fake output is not a quality, latency, throughput, VRAM, or cost benchmark.
- Billing, production multitenancy, autoscaling, SLOs, Kubernetes, and public
  production readiness are out of scope.
- The project is private and no project license has been selected yet.

### Migration and upgrade notes

This release uses the existing forward-only database migrations, including the
Phase 5 workflow/revision and operational-state migrations. Run pnpm db:migrate
against the intended development database before starting the API. Do not
delete PostgreSQL volumes or artifact roots during a routine observability
shutdown. Use pnpm demo:reset -- --force only after reviewing its printed
demo-only target.

### Verification

The exact command matrix and pass/fail/skip counts are recorded in the final
handoff and STATUS.md. The live contract remains a skip rather than a pass; no
H3 evidence is inferred from fake execution.
