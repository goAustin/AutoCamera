## Building with VideoOps

VideoOps is the control-plane UI for a durable video-operations system: runs,
attempts, evaluations, and the human review that accepts or rejects generated
clips. It is a **dark-only** system. There is no light theme. The palette is
graphite + amber — mint was retired as the accent (2026-09-21) and now means
one thing only: passed / accepted / validated.

### The root wrapper is mandatory

Every screen must sit inside an element with `className="videoops-surface"`.
That class is where the ground lives — canvas colour, ink colour,
`color-scheme: dark`, and the font stack (system-ui; the repo has never
shipped a webfont, so the stack names only what it actually renders). The
design tokens are defined on `:root` and always resolve, but **nothing
applies them without this wrapper**: omit it and the screen renders as
browser-default black text in a serif face on white, with every translucent
panel compositing to grey. It is a class rather than a `body` rule so the
library never restyles a host page.

`AppShell` and `TokenGate` carry `videoops-surface` themselves — a screen built
from either is already wrapped. Anything else needs it explicitly:

```jsx
<div className="videoops-surface" style={{ padding: '1rem' }}>
  <Panel title="Durable runs" count={2}>…</Panel>
</div>
```

### The styling idiom: tokens + a fixed class vocabulary

No utility classes, no CSS-in-JS, no `sx`/style props. Components carry their
own class names; your own layout glue is written with the same CSS custom
properties the components use, so it stays on-palette.

Colour and surface tokens, all on `:root`:

| Token | Use |
|---|---|
| `--ink` | primary text |
| `--muted` | secondary text, labels, body copy |
| `--faint` | tertiary text, timestamps, uppercase eyebrows, mono meta |
| `--canvas` | the page ground |
| `--panel` | raised panel background (cards) |
| `--panel-rail` | the rail's own, slightly darker surface |
| `--line` / `--line-strong` | hairline borders; `-strong` for interactive edges |
| `--acc` / `--acc-soft` / `--acc-mid` | amber — the single action + in-flight colour |
| `--ink-acc` | text colour on an amber fill |
| `--pass` / `--pass-soft` / `--pass-mid` | passed / accepted / validated. Nothing else. |
| `--fail` / `--fail-soft` / `--fail-mid` | negative status, destructive actions, failure copy |
| `--done` | completed stepper nodes — done, not the live edge |
| `--panel2` / `--panel2-bd` | a nested tint replacing a second border level |
| `--sep` | the hairline that separates a heading from its body, or one row from the next |
| `--mono` | `ui-monospace` stack — every id, hash, seed, timestamp, byte count and code string |
| `--shadow` | the single elevation |

Layout helpers you may reuse directly: `button-row` (a wrapping flex row of
actions), `muted` (small tertiary text), `eyebrow` / `section-kicker`
(uppercase tracked labels — use at most one per screen), `lede` (intro
paragraph).

### Composition rules that matter here

- **One border level.** `Panel` draws the frame. Anything nested inside it
  (`AttemptSummary`, `EvaluationPanel`, `RevisionHistory` rows,
  `RecommendationCard`) separates by a `--panel2` tint, not another border.
  Borders that remain are affordances (inputs, chips, the video frame) or
  semantic (`Notice`, `ConfirmPanel`).
- **One `primary` Button per surface.** It is filled amber. `variant="quiet"`
  is transparent with a hairline for everything else. `variant="danger"` is
  **outlined, never filled** — a filled destructive action reads as the
  primary action at a glance, which defeats the point.
- **Never headline a raw identifier.** Run, attempt and artifact ids are
  opaque; pass them through `shortId()` and title surfaces with something a
  human recognises.
- **`FactList` puts labels above values.** Prefer it over a hand-built
  definition list justified to opposite edges.
- Components are presentational only — they never fetch, authenticate or
  route. Data wiring belongs in the app that composes them.

### Where the truth lives

`styles.css` and its import closure is the complete stylesheet; `_ds_bundle.css`
carries the component rules and the token definitions. Read
`components/<group>/<Name>/<Name>.prompt.md` for a component's own props and
usage, and `<Name>.d.ts` for the exact contract.
