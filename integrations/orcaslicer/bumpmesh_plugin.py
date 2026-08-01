# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy~=2.0"]
#
# [tool.orcaslicer.plugin]
# id = "bumpmesh"
# name = "BumpMesh"
# description = "Open BumpMesh inside OrcaSlicer and transfer printable model geometry into the texturing workspace."
# author = "CNC Kitchen"
# version = "0.1.0"
# network = ["bumpmesh.com", "cdn.jsdelivr.net"]
# ///
"""BumpMesh integration for OrcaSlicer's Python plugin system."""

from __future__ import annotations

import base64
import json
import math
import os
import re
import sys
import threading
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
import orca


PLUGIN_VERSION = "0.1.0"
BUMPMESH_URL = "https://bumpmesh.com/"
TRANSFER_CHUNK_BYTES = 256 * 1024
MAX_TRANSFER_TRIANGLES = 1_000_000
PROTOCOL_VERSION = 1
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

ORCA_TO_BUMPMESH_LANGUAGE = {
    "da": "da",
    "de": "de",
    "en": "en",
    "es": "es",
    "fr": "fr",
    "it": "it",
    "ja": "ja",
    "ko": "ko",
    "pl": "pl",
    "pt_BR": "pt",
    "ru": "ru",
    "tr": "tr",
    "uk": "uk",
    "zh_CN": "zh",
    "zh_TW": "zh",
}

PAGE_TEMPLATE = r"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body, iframe {
      width: 100%;
      height: 100%;
      margin: 0;
      border: 0;
      overflow: hidden;
      background: #111114;
    }
  </style>
</head>
<body>
  <iframe id="bumpmesh" title="BumpMesh" allow="fullscreen"></iframe>
  <script>
    (() => {
      'use strict';
      const protocol = 1;
      const pluginSource = 'orcaslicer-bumpmesh-plugin';
      const appSource = 'bumpmesh';
      const frameUrl = new URL(__FRAME_URL__);
      const initialHostTheme = document.documentElement.getAttribute('data-orca-theme');
      if (initialHostTheme === 'light' || initialHostTheme === 'dark') {
        frameUrl.searchParams.set('orcaslicerTheme', initialHostTheme);
      }
      const debug = frameUrl.searchParams.get('orcaslicerDebug') === '1';
      const frameOrigin = frameUrl.origin;
      const frame = document.getElementById('bumpmesh');
      let activeTransfer = null;

      function sendToBumpMesh(message, transfer) {
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({
          source: pluginSource,
          protocol,
          ...message,
        }, frameOrigin, transfer || []);
      }

      function sendToPlugin(message) {
        if (!window.orca) return;
        window.orca.postMessage(message);
      }

      function diagnostic(event, details) {
        if (!debug) return;
        sendToPlugin({ type: 'diagnostic', event, details: details || {} });
      }

      function sendHostTheme() {
        const theme = document.documentElement.getAttribute('data-orca-theme');
        if (theme === 'light' || theme === 'dark') {
          sendToBumpMesh({ type: 'host-theme', theme });
        }
      }

      function decodeChunk(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function finishTransfer(message) {
        const transfer = activeTransfer;
        if (!transfer || transfer.id !== message.transferId) return;
        if (transfer.received !== transfer.chunks.length || transfer.chunks.some((item) => !item)) {
          sendToBumpMesh({ type: 'transfer-error', message: 'The model transfer was incomplete.' });
          activeTransfer = null;
          return;
        }

        const result = new Uint8Array(transfer.totalBytes);
        let offset = 0;
        for (const chunk of transfer.chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (offset !== transfer.totalBytes) {
          sendToBumpMesh({ type: 'transfer-error', message: 'The transferred model size did not match.' });
          activeTransfer = null;
          return;
        }

        activeTransfer = null;
        sendToBumpMesh({
          type: 'load-model',
          objectId: transfer.objectId,
          name: transfer.name,
          buffer: result.buffer,
        }, [result.buffer]);
      }

      window.addEventListener('message', (event) => {
        const message = event.data;
        diagnostic('wrapper-message-observed', {
          origin: event.origin || '',
          frameMatches: event.source === frame.contentWindow,
          source: message && typeof message === 'object' ? String(message.source || '') : '',
          type: message && typeof message === 'object' ? String(message.type || '') : '',
          protocol: message && typeof message === 'object' ? message.protocol : null,
        });
      });

      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
        const message = event.data;
        if (!message || message.source !== appSource || message.protocol !== protocol) return;
        if (message.type === 'ready') sendHostTheme();
        if (message.type === 'ready' || message.type === 'refresh-objects' ||
            message.type === 'request-model' ||
            message.type === 'model-loaded' || message.type === 'model-load-error' ||
            message.type === 'diagnostic') {
          sendToPlugin(message);
        }
      });

      window.addEventListener('error', (event) => {
        diagnostic('wrapper-error', {
          message: event.message || 'Unknown wrapper error',
          line: event.lineno || 0,
          column: event.colno || 0,
        });
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        diagnostic('wrapper-unhandled-rejection', {
          message: reason && reason.message ? reason.message : String(reason),
        });
      });
      frame.addEventListener('load', () => {
        diagnostic('iframe-load', { origin: frameOrigin, src: frame.src });
        sendHostTheme();
      });

      new MutationObserver(sendHostTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-orca-theme'],
      });

      if (window.orca) {
        window.orca.onMessage((message) => {
          if (!message || message.protocol !== protocol) return;
          if (message.type === 'objects' || message.type === 'transfer-error') {
            sendToBumpMesh(message);
            return;
          }
          if (message.type === 'transfer-start') {
            activeTransfer = {
              id: message.transferId,
              objectId: message.objectId,
              name: message.name,
              totalBytes: message.totalBytes,
              chunks: new Array(message.totalChunks),
              received: 0,
            };
            sendToBumpMesh(message);
            return;
          }
          if (message.type === 'transfer-chunk') {
            const transfer = activeTransfer;
            if (!transfer || transfer.id !== message.transferId ||
                message.index < 0 || message.index >= transfer.chunks.length ||
                transfer.chunks[message.index]) return;
            transfer.chunks[message.index] = decodeChunk(message.data);
            transfer.received += 1;
            return;
          }
          if (message.type === 'transfer-done') finishTransfer(message);
        });
      }

      frame.src = frameUrl.toString();
    })();
  </script>
</body>
</html>
"""


@dataclass(frozen=True)
class VolumeSnapshot:
    vertices: np.ndarray
    triangles: np.ndarray
    matrix: np.ndarray


@dataclass(frozen=True)
class ObjectSnapshot:
    object_id: int
    name: str
    volumes: tuple[VolumeSnapshot, ...]
    triangle_count: int


def _host_language() -> str:
    try:
        value = orca.host.app_language()
    except (AttributeError, RuntimeError):
        return "en"
    if not isinstance(value, str):
        return "en"
    normalized = value.replace("-", "_")
    if normalized in ORCA_TO_BUMPMESH_LANGUAGE:
        return ORCA_TO_BUMPMESH_LANGUAGE[normalized]
    return ORCA_TO_BUMPMESH_LANGUAGE.get(normalized.split("_", 1)[0], "en")


def _bumpmesh_base_url() -> str:
    """Allow contributors to point the plugin at a loopback checkout only."""
    candidate = os.environ.get("BUMPMESH_ORCASLICER_DEV_URL", "").strip()
    if not candidate:
        return BUMPMESH_URL
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        return BUMPMESH_URL
    if parsed.username or parsed.password:
        return BUMPMESH_URL
    return candidate


def bumpmesh_frame_url() -> str:
    base_url = _bumpmesh_base_url()
    parsed = urllib.parse.urlsplit(base_url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.update({"orcaslicer": "1", "orcaslicerLang": _host_language()})
    if base_url != BUMPMESH_URL:
        query["orcaslicerDebug"] = "1"
        query["orcaslicerBridge"] = "6"
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def render_page() -> str:
    return PAGE_TEMPLATE.replace("__FRAME_URL__", json.dumps(bumpmesh_frame_url()))


def plugin_icon() -> str:
    try:
        import bumpmesh_orca_assets

        return str(Path(bumpmesh_orca_assets.__file__).with_name("bumpmesh.png"))
    except (ImportError, TypeError):
        return ""


def _object_id(model_object: Any) -> int:
    return int(model_object.id())


def _safe_stl_name(name: str, object_id: int) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    return cleaned or f"orca-object-{object_id}"


def transferable_objects() -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for model_object in orca.host.model().objects():
        volumes = [volume for volume in model_object.volumes() if volume.is_model_part()]
        triangle_count = sum(int(volume.facets_count()) for volume in volumes)
        if not volumes or triangle_count <= 0:
            continue
        item = {
            "id": _object_id(model_object),
            "name": str(model_object.name or f"Object {_object_id(model_object)}"),
            "triangleCount": triangle_count,
            "volumeCount": len(volumes),
        }
        if any(volume.is_negative_volume() for volume in model_object.volumes()):
            item["disabledReasonCode"] = "negative-volumes"
        objects.append(item)
    return objects


def capture_object(object_id: int) -> ObjectSnapshot:
    selected = None
    for model_object in orca.host.model().objects():
        if _object_id(model_object) == object_id:
            selected = model_object
            break
    if selected is None:
        raise ValueError("The selected OrcaSlicer object no longer exists.")
    if any(volume.is_negative_volume() for volume in selected.volumes()):
        raise ValueError(
            "The selected object contains negative volumes, which cannot be resolved through "
            "the current read-only OrcaSlicer mesh API. Export the object from OrcaSlicer and "
            "load the exported file in BumpMesh instead."
        )

    snapshots: list[VolumeSnapshot] = []
    triangle_count = 0
    for volume in selected.volumes():
        if not volume.is_model_part():
            continue
        mesh = volume.mesh()
        vertices = np.array(mesh.vertices(), dtype=np.float64, copy=True)
        triangles = np.array(mesh.triangles(), dtype=np.int64, copy=True)
        matrix = np.array(volume.matrix(), dtype=np.float64, copy=True)
        if vertices.ndim != 2 or vertices.shape[1] != 3:
            raise ValueError("OrcaSlicer returned an invalid vertex array.")
        if triangles.ndim != 2 or triangles.shape[1] != 3:
            raise ValueError("OrcaSlicer returned an invalid triangle array.")
        if matrix.shape != (4, 4):
            raise ValueError("OrcaSlicer returned an invalid volume transform.")
        if triangles.size and (triangles.min() < 0 or triangles.max() >= len(vertices)):
            raise ValueError("OrcaSlicer returned triangle indices outside the vertex array.")
        snapshots.append(VolumeSnapshot(vertices, triangles, matrix))
        triangle_count += len(triangles)

    if not snapshots or triangle_count == 0:
        raise ValueError("The selected object has no transferable model-part geometry.")
    if triangle_count > MAX_TRANSFER_TRIANGLES:
        raise ValueError(
            f"The selected object has {triangle_count:,} triangles; the current OrcaSlicer "
            f"page bridge is limited to {MAX_TRANSFER_TRIANGLES:,}. Export the model from "
            "OrcaSlicer and load the file in BumpMesh instead."
        )

    return ObjectSnapshot(
        object_id=object_id,
        name=_safe_stl_name(str(selected.name or ""), object_id),
        volumes=tuple(snapshots),
        triangle_count=triangle_count,
    )


def encode_binary_stl(snapshot: ObjectSnapshot) -> bytes:
    record_dtype = np.dtype(
        [
            ("normal", "<f4", (3,)),
            ("vertices", "<f4", (3, 3)),
            ("attribute", "<u2"),
        ],
        align=False,
    )
    if record_dtype.itemsize != 50:
        raise RuntimeError("Unexpected binary STL record size.")

    records = np.empty(snapshot.triangle_count, dtype=record_dtype)
    offset = 0
    for volume in snapshot.volumes:
        count = len(volume.triangles)
        if count == 0:
            continue
        homogeneous = np.concatenate(
            (volume.vertices, np.ones((len(volume.vertices), 1), dtype=np.float64)),
            axis=1,
        )
        transformed = (volume.matrix @ homogeneous.T).T[:, :3]
        faces = transformed[volume.triangles]
        if np.linalg.det(volume.matrix[:3, :3]) < 0:
            faces = faces[:, [0, 2, 1]]
        edge_a = faces[:, 1] - faces[:, 0]
        edge_b = faces[:, 2] - faces[:, 0]
        normals = np.cross(edge_a, edge_b)
        lengths = np.linalg.norm(normals, axis=1)
        safe = lengths > 1e-20
        normals[safe] /= lengths[safe, None]
        normals[~safe] = 0

        target = records[offset : offset + count]
        target["normal"] = normals.astype(np.float32, copy=False)
        target["vertices"] = faces.astype(np.float32, copy=False)
        target["attribute"] = 0
        offset += count

    header = bytearray(84)
    label = b"BumpMesh OrcaSlicer plugin"
    header[: len(label)] = label
    header[80:84] = int(snapshot.triangle_count).to_bytes(4, "little", signed=False)
    return bytes(header) + records.tobytes()


class TransferController:
    def __init__(self, post: Callable[[dict[str, Any]], None]):
        self._post = post
        self._lock = threading.Lock()
        self._active = False
        self._closed = False

    def close(self) -> None:
        with self._lock:
            self._closed = True

    def _safe_post(self, payload: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return
        self._post({"protocol": PROTOCOL_VERSION, **payload})

    def send_objects(self) -> None:
        try:
            self._safe_post({"type": "objects", "objects": transferable_objects()})
        except Exception as error:
            self._safe_post({"type": "transfer-error", "message": str(error)})

    def on_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "diagnostic":
            event = str(message.get("event") or "unknown")[:80]
            details = message.get("details")
            if not isinstance(details, dict):
                details = {"value": str(details)[:200]}
            print(
                f"[BumpMesh WebView] {event} "
                f"{json.dumps(details, ensure_ascii=True, separators=(',', ':'))}",
                file=sys.stderr,
                flush=True,
            )
            return
        if kind in {"ready", "refresh-objects"}:
            self.send_objects()
            return
        if kind != "request-model":
            return

        try:
            object_id = int(message.get("objectId"))
        except (TypeError, ValueError):
            self._safe_post({"type": "transfer-error", "message": "Invalid OrcaSlicer object id."})
            return

        with self._lock:
            if self._closed:
                return
            already_active = self._active
            if not already_active:
                self._active = True
        if already_active:
            self._safe_post(
                {"type": "transfer-error", "message": "Another model transfer is already running."}
            )
            return

        try:
            snapshot = capture_object(object_id)
        except Exception as error:
            with self._lock:
                self._active = False
            self._safe_post({"type": "transfer-error", "message": str(error)})
            self.send_objects()
            return

        transfer_id = uuid.uuid4().hex
        total_bytes = 84 + 50 * snapshot.triangle_count
        total_chunks = math.ceil(total_bytes / TRANSFER_CHUNK_BYTES)
        self._safe_post(
            {
                "type": "transfer-start",
                "transferId": transfer_id,
                "objectId": snapshot.object_id,
                "name": f"{snapshot.name}.stl",
                "totalBytes": total_bytes,
                "totalChunks": total_chunks,
            }
        )
        threading.Thread(
            target=self._encode_and_send,
            args=(transfer_id, snapshot),
            name="bumpmesh-model-transfer",
            daemon=True,
        ).start()

    def _encode_and_send(self, transfer_id: str, snapshot: ObjectSnapshot) -> None:
        try:
            payload = encode_binary_stl(snapshot)
            for index, start in enumerate(range(0, len(payload), TRANSFER_CHUNK_BYTES)):
                encoded = base64.b64encode(payload[start : start + TRANSFER_CHUNK_BYTES]).decode("ascii")
                self._safe_post(
                    {
                        "type": "transfer-chunk",
                        "transferId": transfer_id,
                        "index": index,
                        "data": encoded,
                    }
                )
            self._safe_post({"type": "transfer-done", "transferId": transfer_id})
        except Exception as error:
            self._safe_post(
                {"type": "transfer-error", "transferId": transfer_id, "message": str(error)}
            )
        finally:
            with self._lock:
                self._active = False


_pages_module = getattr(orca, "pages", None)
_pages_base = getattr(_pages_module, "PagesPluginCapabilityBase", None)
_script_module = getattr(orca, "script", None)
_script_base = getattr(_script_module, "ScriptPluginCapabilityBase", None)


class BumpMeshPage(_pages_base or object):
    def __init__(self):
        if _pages_base is not None:
            super().__init__()
        self._controller = TransferController(self.post_message)

    def get_name(self):
        return "BumpMesh"

    def get_ui(self):
        return render_page()

    def get_icon(self):
        return plugin_icon()

    def on_message(self, message):
        self._controller.on_message(message)

    def on_unload(self):
        self._controller.close()


class BumpMeshWindowAction(_script_base or object):
    def __init__(self):
        if _script_base is not None:
            super().__init__()
        self._window = None
        self._controller = None

    def get_name(self):
        return "Open BumpMesh"

    def execute(self):
        if self._window is not None and self._window.is_open():
            return orca.ExecutionResult.skipped("BumpMesh is already open.")

        holder: dict[str, Any] = {}

        def post(payload):
            window = holder.get("window")
            if window is not None and window.is_open():
                window.post(payload)

        controller = TransferController(post)
        window = orca.host.ui.create_window(
            render_page(),
            title="BumpMesh",
            width=1280,
            height=820,
            on_message=controller.on_message,
            on_close=controller.close,
        )
        holder["window"] = window
        self._window = window
        self._controller = controller
        return orca.ExecutionResult.success("BumpMesh opened.")

    def on_unload(self):
        if self._controller is not None:
            self._controller.close()


@orca.plugin
class BumpMeshPlugin(orca.base):
    def register_capabilities(self):
        if _pages_base is not None:
            orca.register_capability(BumpMeshPage)
        elif _script_base is not None:
            orca.register_capability(BumpMeshWindowAction)
