# Release status

## Phase 7C — ComfyUI-first plugin inversion

Status: complete for the **Offline fake** evidence level (`v0.1.0-mvp`).
Phase 7A and Phase 7B are complete and preserved. ComfyUI now opens as the
graph shell, the VideoOps sidebar is a Studio-origin iframe, native browser
queueing is refused, and the managed panel records runs through the 7A API.
The VideoOps bearer token never enters the ComfyUI origin.

### Completed gates

- pinned frontend ref `3697a1bc3ba7f6b98a1ead888721f7676b536eb5` verified for
  the public extension APIs used by the plugin;
- shared reversed bridge contract with exact origin/source/nonce/replay/size
  validation and credential-field rejection;
- ComfyUI entry canvas, VideoOps left sidebar iframe, bottom status tab, and
  topbar managed badge;
- Studio-only token storage and authenticated API calls;
- native queue and queue-mode controls disabled; public `Managed Run` action
  exported through `app.graphToPrompt()`;
- empty-state H3 template load, brief on-ramp, run history/detail, revision
  restore, pin, review, findings, progress, and trace display;
- standalone Studio fallback retained, with Phase 5 routes left available for
  legacy callers;
- updated ComfyUI-first screenshots and evidence manifest.

### Verification record

| Check | Result |
|---|---|
| Frozen install | PASS |
| Unit suite | PASS — 26 files, 152 tests |
| Typecheck and production build | PASS |
| Formatting | PASS — one expected large fixture warning |
| Full browser gate | PASS — 9/9 tests; includes the ComfyUI inversion flow, token isolation, 405 queue refusal, one managed run, pin/review, and revision restore |
| Token isolation output | PASS — `storageHasCredential: false`, `globalsHaveCredential: false`, `crossOriginProtected: true` |
| Live ComfyUI contract | SKIP — no configured pinned remote executor |
| Real H3 GPU smoke | NOT RUN — Phase 8 |

The pinned frontend exposes no supported queue interception hook. This release
does not monkey-patch frontend internals; it disables the native control and
surfaces the managed action, as required by the checkpoint. Its topbar badge
metadata is static in the pinned ref, so live readiness/count/budget details
are carried by the postMessage status feed and bottom panel.

## Historical Phase 6 record

Phase 6's local Project Studio, fake ComfyUI, durable worker,
artifact/evaluation, recovery, observability, and browser release remain green.
The remote pinned ComfyUI contract and real MiniMax H3 GPU generation were not
available in this environment and remain deferred to **Phase 8**. No real H3
generation claim is made.

## Next document

`docs/90-POST-MVP-ROADMAP.md` remains the next long-term document. It is not part
of this Phase 7C implementation, and Phase 8 was not started.
