import os
import json
import asyncio
import threading
from uuid import uuid4
from typing import Dict, Any

from aiohttp import web
from server import PromptServer
from huggingface_hub import hf_hub_download

# ============ minimal job store (no progress math) ============
_downloads: Dict[str, Dict[str, Any]] = {}  # gid -> {state, msg, filepath, thread, cancel}

def _set(gid: str, **kw):
    _downloads.setdefault(gid, {})
    _downloads[gid].update(kw)

def _get(gid: str, key: str, default=None):
    return _downloads.get(gid, {}).get(key, default)

# ============ worker ============
def _worker(gid: str, repo_id: str, filename: str, dest_dir: str, token: str | None):
    try:
        # mark started (no size / no chunks)
        _set(gid, state="running", msg="Download started…", filepath=None)

        # Do the download (no polling, no chunk updates)
        # We place the file directly into dest_dir.
        local_path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=dest_dir,
            local_dir_use_symlinks=False,
            token=token,
            force_download=False,
            resume_download=True,
        )

        # Finished
        _set(gid, state="done", msg="File download complete.", filepath=local_path)

    except Exception as e:
        _set(gid, state="error", msg=f"{type(e).__name__}: {e}")

# ============ routes ============
async def start_download(request: web.Request):
    try:
        data = await request.json()
        repo_id = (data.get("repo_id") or "").strip()
        filename = (data.get("filename") or "").strip()
        dest_dir = (data.get("dest_dir") or "").strip()
        token = (data.get("token_input") or "").strip()

        if not repo_id or not filename or not dest_dir:
            return web.json_response({"ok": False, "error": "repo_id, filename, dest_dir are required"}, status=400)

        os.makedirs(dest_dir, exist_ok=True)

        gid = data.get("gid") or uuid4().hex
        

        # create record
        _downloads[gid] = {
            "state": "starting",
            "msg": "Starting…",
            "filepath": None,
            "cancel": False,
            "thread": None,
        }

        # spin the worker thread (no async progress)
        t = threading.Thread(target=_worker, args=(gid, repo_id, filename, dest_dir, token), daemon=True)
        _downloads[gid]["thread"] = t
        t.start()

        return web.json_response({"ok": True, "gid": gid, "state": "running", "msg": "Download started…"})

    except Exception as e:
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

async def status_download(request: web.Request):
    """
    GET /hf/status?gid=...
    Returns only coarse state, no progress fields.
    """
    gid = request.query.get("gid", "")
    if gid not in _downloads:
        return web.json_response({"ok": False, "error": "unknown gid"}, status=404)

    info = _downloads[gid]
    return web.json_response({
        "ok": True,
        "gid": gid,
        "state": info.get("state", "unknown"),
        "msg": info.get("msg", ""),
        "filepath": info.get("filepath"),
    })

async def stop_download(request: web.Request):
    """
    POST /hf/stop { gid }
    (Best effort: we cannot forcibly kill hf_hub_download cleanly; we just mark as stopped if thread is alive.)
    """
    try:
        data = await request.json()
        gid = (data.get("gid") or "").strip()
        if gid not in _downloads:
            return web.json_response({"ok": False, "error": "unknown gid"}, status=404)

        info = _downloads[gid]
        t: threading.Thread | None = info.get("thread")
        # We cannot safely terminate threads in Python.
        # Mark state and let UI reset; user can delete the node or ignore the result.
        if t and t.is_alive():
            _set(gid, state="stopped", msg="Stop requested by user.")
        else:
            _set(gid, state="stopped", msg="Already finished.")

        return web.json_response({"ok": True, "gid": gid, "state": _get(gid, "state"), "msg": _get(gid, "msg")})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

# ============ register with ComfyUI server ============
def _register_routes():
    app = PromptServer.instance.app
    app.router.add_post("/hf/start", start_download)
    app.router.add_get("/hf/status", status_download)
    app.router.add_post("/hf/stop", stop_download)

_register_routes()

# ============ UI node shell (no-op compute) ============
class hf_hub_downloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = []
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()
