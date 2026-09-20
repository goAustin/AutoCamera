# design-sync notes — @h3/ui

Repo-specific things a future sync should know. Append, don't rewrite.

## Origin

- `packages/ui` did not exist before the first sync (2026-09-20). It was
  extracted from `apps/web/src/App.tsx`, which held all 18 components as
  unexported local functions in one 1890-line file. The app now imports them;
  container logic (react-query, the bearer token, redaction allowlists) stayed
  in `App.tsx` on purpose — nothing in `packages/ui` fetches or authenticates.

## Build and converter invocation

- Build the package with `pnpm --filter @h3/ui build` (tsc + `copy-css.mjs`).
- `--entry` is **cwd-relative, not package-relative**. From the repo root it
  must be `./packages/ui/dist/index.js`; `./dist/index.js` silently resolves to
  the repo root and fails `[NO_DIST]`.
- `--node-modules packages/ui/node_modules` — react, react-dom and
  `@types/react` all resolve there under pnpm.
- `react-dom` is a devDependency of `packages/ui` **only** so the converter can
  bundle the preview runtime. The library itself never imports it; its
  peerDependency is `react` alone.
- The converter's component discovery reads the **top-level** `types` field of
  package.json (`lib/dts.mjs` `projectFor`), not `exports['.'].types`. The
  package carries both. Removing the top-level `types` brings back
  `[ZERO_MATCH] no component exports`.

## Config decisions

- `componentSrcMap` pins four components whose source file is named for a
  sibling: `ErrorNotice` (Notice.tsx), `EmptyState` and `LoadingState`
  (StateBlock.tsx), `RecommendationList` (RecommendationCard.tsx). Without the
  pins they lose src-matching and their JSDoc. Not an enumeration — only the
  four misses.
- `overrides` puts `AppShell`, `TokenGate` and `ArtifactPlayer` in
  `cardMode: single`; all three are full-bleed and escape a grid cell.
- `cssEntry` is `dist/styles.css`, which `copy-css.mjs` emits **flattened**.
  The authored `src/styles.css` is an `@import` graph; shipping that directly
  produced an `@import`-only stub and `[CSS_PLACEHOLDER]`. Keep the flattening
  step if you touch the build.

## Design decisions made during the sync

- **`.videoops-surface` is the mandatory root wrapper.** The tokens were
  originally applied by `apps/web/src/styles.css` (`:root` colour, `body`
  background, the font stack), so the extracted package styled nothing on its
  own — previews rendered black-on-white in a serif face. The ground now lives
  on this class, in the library. `AppShell` and `TokenGate` carry it; every
  authored preview wraps in it; `conventions.md` tells the design agent to.
  It is a class rather than a `body` rule so the library never restyles a host
  page — and the preview harness hardcodes `body{background:#fff}` after the
  stylesheet links, so a `body` rule would lose there anyway.
- **Inter was dropped from the font stack** (user decision, 2026-09-20). The
  repo has never shipped a webfont — no `@font-face`, no font files, no CDN
  link — so VideoOps has always rendered in `system-ui`. Naming a font nothing
  supplies only guaranteed a substitute and a standing `[FONT_MISSING]`. The
  stack now declares what it actually renders. This is *not* an accepted
  substitute to revisit; it is the truth about the system.
- Two defects were fixed in the library during authoring, both caught by the
  calibration pass rather than by tests: `shortId(id, 12, 0)` returned the
  whole string (`slice(-0)` is `slice(0)`), and the timeline connector used a
  fixed `height: 2.7rem` that broke whenever an event carried a detail line.

## Known render warns

None. The final validate exits 0 with no warnings. If a warn appears on a
future sync it is new — look at it.

## Re-sync risks

- **The sample clip in `previews/ArtifactPlayer.tsx` is an inlined base64
  data URI** (~9 KB), generated with `ffmpeg -f lavfi -i gradients`. It is
  committed preview content, not machine output, so it carries forward — but
  regenerating it changes the grade key for that component. Note that this
  ffmpeg build has no `drawtext` (no libfreetype); a command using it fails
  with "Filter not found".
- **Preview data is hand-written, not drawn from fixtures.** Ids, hashes,
  costs and event names imitate real VideoOps records but are invented. If the
  domain shapes in `packages/ui/src/types.ts` change, the previews will still
  compile while being wrong — check them against `@h3/domain` on any re-sync
  that touches those types.
- **Evaluation check keys are assumed snake_case.** `humanize()` splits on `_`
  and `-` only, so a camelCase key from the real evaluator would render as
  `AudioTrack` rather than `Audio Track`. If the API turns out to emit
  camelCase, fix `humanize`, not the previews.
- **Previews were authored inline, not via the subagent fan-out.** At 19
  components the coordination cost outweighed the parallelism. A materially
  larger component set should use the documented fan-out instead.
- `apps/web` still hand-writes `.panel` / `.panel-heading` markup in the
  managed-panel page rather than composing the `Panel` component. That drift is
  known and deliberate for now — the side panel's heading structure differs.
