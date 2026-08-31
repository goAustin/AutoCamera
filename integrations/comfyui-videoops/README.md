# H3 VideoOps ComfyUI bridge

This directory is a frontend-only ComfyUI custom-node package. It registers no
execution nodes and never calls the VideoOps API. The authenticated Project
Studio shell owns all API calls, including draft/revision creation and managed
generation.

The package is installed under `ComfyUI/custom_nodes/` and exports only
`WEB_DIRECTORY`. ComfyUI loads `web/videoops.js`, which uses the supported
`app.registerExtension()` and topbar command APIs. **Generate managed** calls
the public `app.graphToPrompt()` method and exports both values:

- `workflow` as `editorGraph` for round-trip editing;
- `output` as `apiGraph` for VideoOps validation and immutable revision storage.

## Managed iframe contract

Project Studio creates the browser-facing editor URL with these query
parameters:

```text
videoopsManaged=1
projectId=<opaque scoped resource id>
shotId=<opaque scoped resource id>
nonce=<fresh session nonce>
parentOrigin=https%3A%2F%2Fstudio.example.com
frontendVersion=<pinned frontend identifier>
```

The bridge fails closed unless it is embedded, the managed flag and nonce are
present, and `parentOrigin` is an exact `http` or `https` origin. It sends
structured-clone messages to that origin only; it never uses `*`.

Every message contains `source: "videoops-comfy-bridge"`, schema `version: 1`,
`requestId`, and the session `nonce`. The bridge validates the exact origin,
the parent `Window` object, schema version, message type, nonce, JSON shape,
and a 2 MiB UTF-8 payload limit. Repeated `(type, requestId)` pairs are
discarded. Graphs must be JSON objects; functions, cyclic values, non-finite
numbers, and class instances are rejected.

Child-to-parent messages:

```json
{
  "source": "videoops-comfy-bridge",
  "version": 1,
  "type": "bridge.ready",
  "requestId": "session-nonce",
  "nonce": "session-nonce",
  "frontendVersion": "pinned-frontend"
}
```

```json
{
  "source": "videoops-comfy-bridge",
  "version": 1,
  "type": "workflow.exported",
  "requestId": "export-unique-id",
  "nonce": "session-nonce",
  "editorGraph": {},
  "apiGraph": {},
  "frontendVersion": "pinned-frontend"
}
```

The parent may send `studio.context`, `workflow.load`, and `workflow.result`.
Those messages carry no credential fields. A bridge error contains only a
stable safe error code; raw graph data and exception text are not forwarded.

The extension does not intercept or replace ComfyUI queue behavior. Direct
browser submission is prevented by the authenticated reverse proxy described
in [`infra/gpu-executor/README.md`](../../infra/gpu-executor/README.md).
