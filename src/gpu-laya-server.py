"""Approved helper only. No system Python, remote model code, task data, or CPU fallback."""
import asyncio
import contextlib
import importlib.metadata
import io
import json
import logging
import os
import socket
import sys
from pathlib import Path


class _SilentOutput(io.TextIOBase):
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def main():
    protocol = sys.stdout
    # Third-party model loaders may print progress. Discard it without a growing buffer/file.
    sys.stdout = _SilentOutput()
    try:
        data = json.loads(sys.stdin.readline(16384))
    except (ValueError, OSError):
        raise ValueError("Invalid helper input") from None
    if set(data) != {"mode", "root", "nonce"} or data["mode"] not in {"probe", "serve"}:
        raise ValueError("Invalid helper input")
    root = Path(data["root"])
    if not root.is_absolute() or len(data["nonce"]) != 64 or any(c not in "0123456789abcdef" for c in data["nonce"]):
        raise ValueError("Invalid helper scope")
    if sys.version_info[:3] != (3, 12, 11) or Path(sys.prefix).resolve() != (root / "venv").resolve():
        raise ValueError("Not the approved uv venv")
    import torch
    if torch.__version__ != "2.8.0+cu128" or torch.version.cuda != "12.8" or not torch.cuda.is_available():
        raise ValueError("GPU runtime unavailable")
    torch.cuda.set_device(0)
    major, minor = torch.cuda.get_device_capability(0)
    # Verify the exact architecture, then actually execute kernels; device discovery alone is insufficient.
    arches = torch.cuda.get_arch_list()
    if f"sm_{major}{minor}" not in arches:
        raise ValueError("GPU architecture absent from wheel")
    with torch.inference_mode():
        x = torch.ones((8, 8), device="cuda:0", dtype=torch.bfloat16)
        y = x @ x + x
        torch.cuda.synchronize()
        if y.device.type != "cuda" or float(y[0, 0].item()) != 9.0:
            raise ValueError("GPU kernel check failed")
    if data["mode"] == "probe":
        print('{"type":"gpu_ok"}', file=protocol, flush=True)
        return
    pins = {"laya": "0.3.6", "transformers": "4.57.1", "tokenizers": "0.22.1", "huggingface-hub": "0.35.3",
            "safetensors": "0.5.3", "numpy": "2.2.6", "fastapi": "0.115.12", "uvicorn": "0.34.3", "httpx": "0.28.1", "openjev": "0.6.0"}
    if any(importlib.metadata.version(name) != version for name, version in pins.items()):
        raise ValueError("Changed installed versions")
    os.environ.update({"OPENJEV_BACKEND": "laya", "OPENJEV_DEVICE": "cuda:0", "OPENJEV_LAYA_MODEL": str(root / "model"),
                       "OPENJEV_MODEL_ROUTES": "", "OPENJEV_WARMUP": "1", "OPENJEV_ENCODER_BATCH": "1",
                       "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"})
    logging.disable(logging.CRITICAL)
    import uvicorn
    from openjev.api import create_app
    app = create_app()
    lifespan = app.router.lifespan_context
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Own the port before announcing it; never adopt an unrelated already-running listener.
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

        @contextlib.asynccontextmanager
        async def owned_lifespan(application):
            async with lifespan(application):
                # Upstream loads Laya and performs its synthetic warmup before yielding.
                # Its pinned GPU engine exits if Laya moves to CPU after a GPU failure.
                print(json.dumps({"type": "ready", "port": port, "owner": data["nonce"]}), file=protocol, flush=True)
                yield
        app.router.lifespan_context = owned_lifespan

        @app.get("/__jev_owned", include_in_schema=False)
        async def owned_health():
            return {"owner": data["nonce"], "model": "laya-1.0", "device": "cuda:0"}

        config = uvicorn.Config(app, log_level="critical", access_log=False, lifespan="on", limit_concurrency=4)
        asyncio.run(uvicorn.Server(config).serve(sockets=[sock]))
    finally:
        sock.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No tracebacks, environment values, source text or credentials leave this helper.
        print('{"type":"failed"}', file=sys.__stdout__, flush=True)
        sys.exit(1)
