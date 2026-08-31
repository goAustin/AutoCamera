"""VideoOps' frontend-only ComfyUI bridge.

This custom-node package deliberately registers no execution nodes.  ComfyUI
uses WEB_DIRECTORY to serve the browser extension from its web directory.
"""

WEB_DIRECTORY = "./web"

__all__ = ["WEB_DIRECTORY"]
