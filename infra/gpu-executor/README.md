# Separate GPU ComfyUI executor runbook

This runbook installs a complete pinned ComfyUI executor outside the
VideoOps monorepo. VideoOps owns projects, revisions, queue policy, monitoring,
artifacts, and review; ComfyUI and MiniMax H3 own inference only. Do not clone
ComfyUI, MiniMax H3, or model weights into this repository.

The exact source and model pins are in [`pin-manifest.json`](./pin-manifest.json).
The frontend pin is intentionally an exact commit, not the repository's moving
`HEAD`. Verify that the requested commit exists before deployment.

## 1. Fetch the pinned executor outside this repository

Choose a persistent path on the GPU host, for example `/srv/comfyui-h3`, and
keep it outside the VideoOps checkout:

```sh
export COMFY_ROOT=/srv/comfyui-h3
git clone https://github.com/Comfy-Org/ComfyUI.git "$COMFY_ROOT"
git -C "$COMFY_ROOT" checkout 8a33128f2f8c5585c57486c07de481241e70a39c
git -C "$COMFY_ROOT" rev-parse HEAD
```

Install the Python and CUDA dependencies using the GPU vendor's supported
Python/CUDA combination. The pinned ComfyUI checkout is the source of truth
for its dependency file; do not install an unpinned `main` checkout over it:

```sh
python3 -m venv "$COMFY_ROOT/.venv"
"$COMFY_ROOT/.venv/bin/python" -m pip install --upgrade pip
"$COMFY_ROOT/.venv/bin/pip" install -r "$COMFY_ROOT/requirements.txt"
```

Use the appropriate vendor-supported PyTorch wheel when the requirements file
does not select it for the host CUDA version. Record the Python, CUDA, GPU,
PyTorch, and ComfyUI commit in the deployment evidence.

## 2. Install the VideoOps browser bridge

Copy only the frontend-only integration package from the checked-out VideoOps
source tree into ComfyUI's custom-node directory. This package has no Python
execution nodes and no runtime dependency:

```sh
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

Restart ComfyUI after installing the bridge. The browser-facing route must
load the pinned frontend and the extension from this custom-node directory.
Open it only as a Project Studio iframe with a fresh nonce and an exact
`parentOrigin`; do not append a bearer token, private executor URL, or model
path to the iframe URL.

## 3. Place models and persist executor data

Obtain the model files through the publisher's approved distribution and
record publisher-provided checksums when available. Never invent checksums and
never commit weights:

```sh
mkdir -p \
  "$COMFY_ROOT/models/diffusion_models" \
  "$COMFY_ROOT/models/text_encoders" \
  "$COMFY_ROOT/models/vae" \
  "$COMFY_ROOT/models/loras" \
  "$COMFY_ROOT/input" \
  "$COMFY_ROOT/output"
```

Required H3 filenames:

```text
models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
models/vae/minimax_h3_video_vae_fp16.safetensors
models/vae/minimax_h3_audio_vae_fp32.safetensors
models/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors  # optional retained turbo branch
```

Back up or volume-mount `models`, `input`, and `output` independently. The
VideoOps worker later downloads output through the private executor API and
stores a separate artifact; it does not treat a ComfyUI filesystem path as a
client resource ID.

## 4. Run ComfyUI on a private network

Bind the executor to a private interface or localhost behind a gateway. Allow
only the VideoOps worker (and the authenticated editor gateway where required)
to reach port `8188`. Configure the worker with private values such as:

```dotenv
COMFY_MODE=remote
COMFY_BASE_URL=http://comfy-private.internal:8189
COMFY_WS_URL=ws://comfy-private.internal:8189/ws
COMFY_FRONTEND_URL=https://studio.example.com/comfy/
COMFY_AUTH_TOKEN=<secret-manager-reference>
COMFY_REQUEST_TIMEOUT_MS=15000
```

The `COMFY_AUTH_TOKEN` value belongs only to the VideoOps worker and gateway.
Do not put it in an iframe URL, browser JavaScript, logs, traces, or the
public `/v1/executor` response. The browser receives only the safe
`COMFY_FRONTEND_URL` route from that response.

Run the pinned executor using the host's approved CUDA launch options, for
example:

```sh
"$COMFY_ROOT/.venv/bin/python" "$COMFY_ROOT/main.py" \
  --listen 0.0.0.0 \
  --port 8188 \
  --disable-auto-launch
```

Do not expose this listener directly to the public Internet.

## 5. Split the private API route from the browser editor route

Use an authenticated reverse proxy or service mesh. The private worker route
may reach the full ComfyUI protocol, including `POST /prompt`; the browser
route must not. A minimal Nginx policy shape is:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

upstream comfy_gpu {
    server comfy-gpu.internal:8188;
}

# A separate private vhost is reachable only by the VideoOps worker. The
# gateway obtains this secret from its secret manager; it is never a browser
# header or URL value.
server {
    listen 8189;
    server_name comfy-private.internal;
    allow 10.20.0.0/16; # replace with the worker network
    deny all;
    location / {
        proxy_pass http://comfy_gpu;
        proxy_set_header Authorization $comfy_upstream_authorization;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}

# Project Studio's SSO/VPN route serves the editor but no queue mutation.
location /comfy/ {
    auth_request /_studio_auth;
    proxy_pass http://comfy_gpu/;
    proxy_set_header Authorization $comfy_upstream_authorization;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    add_header Content-Security-Policy "frame-ancestors https://studio.example.com" always;
    add_header X-Content-Type-Options nosniff always;
    limit_except GET HEAD OPTIONS { deny all; }
}

# Keep explicit denies beside the broad method policy so a future route change
# cannot accidentally make these mutation endpoints browser-accessible.
location = /comfy/prompt { return 405; }
location = /comfy/interrupt { return 405; }
location = /comfy/free { return 405; }
location = /comfy/queue {
    limit_except GET { deny all; }
    proxy_pass http://comfy_gpu/queue;
}
```

The exact gateway syntax varies by deployment. The invariant is that browser
requests can reach the authenticated editor/static/read surface and its
WebSocket upgrade, while browser `POST /prompt`, queue mutation, interrupt,
and other execution-control methods are denied by the gateway. The gateway
may add the upstream bearer header server-side; it must never forward that
secret to the browser. Set an exact `frame-ancestors` policy for the Project
Studio origin and do not use `*`.

Prefer a same-site `/comfy/` route. If a separate origin is unavoidable,
configure an exact origin allowlist for CORS and bridge messages, preserve the
authenticated WebSocket gateway, and keep the private worker route on the
internal network.

## 6. Verify readiness, bridge loading, and the live protocol

From the private worker network, verify the safe readiness surface and record
the results without recording tokens, raw model paths, prompts, or output
bytes:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $COMFY_AUTH_TOKEN" \
  http://comfy-gpu.internal:8188/system_stats
curl --fail --silent --show-error \
  -H "Authorization: Bearer $COMFY_AUTH_TOKEN" \
  http://comfy-gpu.internal:8188/object_info
curl --fail --silent --show-error \
  -H "Authorization: Bearer $COMFY_AUTH_TOKEN" \
  http://comfy-gpu.internal:8188/queue
```

Check that `/object_info` contains the required H3 node classes and exact
loader choices from `pin-manifest.json`. In an authenticated browser session,
open the `/comfy/` route inside Project Studio with a fresh nonce and verify:

1. the pinned frontend loads without a direct private hostname;
2. the bridge sends `bridge.ready` to the exact Project Studio origin;
3. **Generate managed** produces one `workflow.exported` message containing
   both `workflow`-derived editor data and `output`-derived API data;
4. no bearer token, private URL, raw filesystem path, or graph payload appears
   in the browser console or network URL;
5. browser `POST /comfy/prompt`, queue mutation, and interrupt requests return
   the gateway's denial response.

From the VideoOps checkout, run the opt-in live contract check only when this
private pinned executor is available:

```sh
COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live
```

This verifies readiness, capability evidence, safe invalid-prompt handling,
queue normalization, and WebSocket parsing. It does not claim that H3 was
generated. Record a real clip, its exact pins, and its media evaluation
separately before making any real-generation claim.

## 7. Evidence and rollback

Record:

- the exact commits in `pin-manifest.json` and `git rev-parse` output;
- GPU/CUDA/Python/PyTorch versions;
- capability fingerprint and live contract result;
- gateway route/method policy and `frame-ancestors` origin;
- bridge readiness and dual-graph export result;
- publisher-supplied model checksums, if supplied;
- whether a real clip was generated and evaluated.

To roll back, stop the executor, restore the previous complete ComfyUI
checkout and compatible model volume, reinstall the matching bridge files,
and rerun the readiness plus bridge checks. Do not change a pin silently or
claim a live H3 generation from fake ComfyUI evidence.
