## Building with VideoOps

VideoOps is the control-plane UI for a durable video-operations system: runs,
attempts, evaluations, and the human review that accepts or rejects generated
clips. It is a **dark-only** system. There is no light theme.

### The root wrapper is mandatory

Every screen must sit inside an element with `className="videoops-surface"`.
That class is where the ground lives — canvas colour, ink colour,
`color-scheme: dark`, and the Inter-led font stack. The design tokens are
defined on `:root` and always resolve, but **nothing applies them without this
wrapper**: omit it and the screen renders as browser-default black text in a
serif face on white, with every translucent panel compositing to grey. It is a
class rather than a `body` rule so the library never restyles a host page.

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
| `--faint` | tertiary text, timestamps, uppercase eyebrows |
| `--canvas` | the page ground |
| `--panel` | raised panel background |
| `--panel-soft` | a recessed variant of the same |
| `--line` / `--line-strong` | hairline borders; `-strong` for interactive edges |
| `--mint` / `--mint-deep` | the accent: primary actions, links, positive status |
| `--coral` | negative status, destructive actions, failure copy |
| `--gold` | in-flight status, confirmation gates, focus rings |
| `--shadow` | the single elevation |

Layout helpers you may reuse directly: `button-row` (a wrapping flex row of
actions), `muted` (small tertiary text), `eyebrow` / `section-kicker`
(uppercase tracked labels — use at most one per screen), `lede` (intro
paragraph).

### Composition rules that matter here

- **One border level.** `Panel`, `AttemptSummary`, `RecommendationCard` and
  `EvaluationPanel` each already draw a frame. Group content inside them with
  spacing and a label, never another bordered box.
- **One `primary` Button per surface.** Use `variant="danger"` for destructive
  actions and `variant="quiet"` for everything else.
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
