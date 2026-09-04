# H3 VideoOps ComfyUI plugin

This directory is a frontend-only ComfyUI custom-node package. It registers no
Python execution nodes and never calls the VideoOps API. The Studio-origin
iframe owns the VideoOps bearer token and authenticated API calls; the ComfyUI
origin owns only the graph shell and a nonce-scoped postMessage bridge.

The package is installed under `ComfyUI/custom_nodes/` and exports only
`WEB_DIRECTORY`. ComfyUI loads `web/videoops.js`, which uses the public APIs in
the pinned frontend ref `3697a1bc3ba7f6b98a1ead888721f7676b536eb5`:

- `app.registerExtension()` for the topbar badge, action-bar button, and bottom
  panel tab;
- `app.extensionManager.registerSidebarTab()` for the VideoOps sidebar;
- `app.graphToPrompt()` to export the current editor and API graph; and
- `app.loadGraphData()` to restore an editor graph from a stored revision.

## Inverted containment

ComfyUI is the top-level shell. The plugin creates an iframe to the Studio
origin and appends only these safe context values to its URL:

```text
videoopsManaged=1
nonce=<fresh session nonce>
parentOrigin=<exact ComfyUI origin>
frontendVersion=<pinned frontend ref>
```

The URL never contains a bearer token, private executor URL, model path, or
raw credential. The Studio child reads its token from Studio session storage,
not from the ComfyUI window. The plugin/runtime contains no authenticated
`fetch`, API client, or `Authorization` header.

## Bridge contract

`bridge-contract.js` is the single shared definition used by the ComfyUI
parent, the Studio child, and `bridge-contract.test.ts`. Every message has
`source: "videoops-comfy-bridge"`, schema `version: 1`, a request ID, and the
session nonce. Both sides validate the exact origin and source window, message
direction, JSON shape, credential fields, replay identity, and a 2 MiB UTF-8
payload limit. `bridge.error` carries only a stable safe code.

Studio child to ComfyUI parent:

```text
panel.ready       { }
workflow.load     { editorGraph, revisionId? }
run.status        { runId, status, evaluation? }
```

ComfyUI parent to Studio child:

```text
comfy.context     { frontendVersion }
workflow.exported { editorGraph, apiGraph }
bridge.error      { code }
```

The parent posts only to the exact Studio origin. The child posts only to the
exact ComfyUI parent origin. Neither side uses `*`.

## Managed Run and queue limitation

The pinned frontend was inspected before implementation. It provides no public
queue-command override or interception callback. The plugin therefore does not
monkey-patch queue internals. It disables the native queue button and queue-mode
menu with a mutation-observer gate and exposes a clearly labelled public
`Managed Run` action-bar button.

`Managed Run` awaits public `app.graphToPrompt()`, sends `workflow.exported` to
the Studio iframe, and lets Studio make the single authenticated `POST /v1/runs`
request. Studio sends `run.status` back for the read-only topbar/bottom-panel
status feed. The local H3 profile adapter resolves the pinned frontend's safe
helper-node values in Studio before the 7A canonical execution graph is sent;
ComfyUI still sends both public graph forms across the bridge.

The topbar badge is a static managed-mode marker because the pinned
`topbarBadges` metadata is static. Live executor readiness, active-run count,
open findings, budget headroom, progress, and failure/trace details are carried
by `run.status` and rendered by the Studio panel and bottom panel. Node-level
durations are explicitly reported as not recorded in the durable Phase 7 feed.

## Installation

Copy only the frontend package into the separate pinned ComfyUI checkout:

```sh
export COMFY_ROOT=/srv/comfyui-h3
export VIDEOOPS_ROOT=/path/to/deploy_Mh3
install -d "$COMFY_ROOT/custom_nodes/comfyui-videoops/web"
install -m 0644 "$VIDEOOPS_ROOT/integrations/comfyui-videoops/__init__.py" \
  "$COMFY_ROOT/custom_nodes/comfyui-videoops/__init__.py"
install -m 0644 "$VIDEOOPS_ROOT/integrations/comfyui-videoops/web/bridge-contract.js" \
  "$COMFY_ROOT/custom_nodes/comfyui-videoops/web/bridge-contract.js"
install -m 0644 "$VIDEOOPS_ROOT/integrations/comfyui-videoops/web/bridge-runtime.js" \
  "$COMFY_ROOT/custom_nodes/comfyui-videoops/web/bridge-runtime.js"
install -m 0644 "$VIDEOOPS_ROOT/integrations/comfyui-videoops/web/videoops.js" \
  "$COMFY_ROOT/custom_nodes/comfyui-videoops/web/videoops.js"
```

Restart ComfyUI after installing the plugin. Serve the pinned editor route
behind an exact-origin Studio embedding policy. Browser `POST /prompt`, queue
mutation, interrupt, and other execution-control methods must be denied by the
gateway; only the private VideoOps worker may submit to the executor.

## Verification

From this checkout, the offline inversion gate is:

```sh
pnpm comfy:frontend
pnpm test:e2e e2e/comfy-inversion.spec.ts
```

The test proves the graph canvas opens first, the three VideoOps surfaces are
present, the Studio iframe is genuinely cross-origin, no credential is
reachable from the ComfyUI origin or iframe URL, browser `POST /prompt` returns
405, and exactly one managed run is created. The full release remains
**Offline fake** evidence; no GPU or real H3 generation is implied.
