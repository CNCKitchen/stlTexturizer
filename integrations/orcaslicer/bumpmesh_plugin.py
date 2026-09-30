# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy~=2.0"]
#
# [tool.orcaslicer.plugin]
# id = "bumpmesh"
# name = "BumpMesh"
# description = "Add physical surface textures to 3D models inside OrcaSlicer with BumpMesh by CNC Kitchen."
# author = "CNC Kitchen"
# version = "0.1.2"
# network = ["cdn.jsdelivr.net"]
# ///
"""BumpMesh integration for OrcaSlicer's Python plugin system."""

from __future__ import annotations

import base64
import html
import json
import math
import os
import re
import sys
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
import orca


PLUGIN_VERSION = "0.1.2"
EMBEDDED_WEB_UI = ""
TRANSFER_CHUNK_BYTES = 256 * 1024
MAX_TRANSFER_TRIANGLES = 1_000_000
MAX_RETURN_BYTES = 500_000_084
PROTOCOL_VERSION = 1
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

ORCA_TO_BUMPMESH_LANGUAGE = {
    "da": "da",
    "de": "de",
    "en": "en",
    "es": "es",
    "fi": "fi",
    "fr": "fr",
    "it": "it",
    "ja": "ja",
    "ko": "ko",
    "nl": "nl",
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
  <div id="startup-status" role="status" style="position:absolute;top:40%;left:20%;color:#eee;font:16px sans-serif"></div>
  <iframe id="bumpmesh" title="BumpMesh" allow="fullscreen"></iframe>
  <script>
    (() => {
      'use strict';
      const protocol = 1;
      const pluginSource = 'orcaslicer-bumpmesh-plugin';
      const appSource = 'bumpmesh';
      const devUrl = __FRAME_URL__;
      const frameUrl = devUrl ? new URL(devUrl) : null;
      const hostLanguage = __HOST_LANGUAGE__;
      const progress = document.getElementById('startup-status');
      const startupLabel = hostLanguage === 'ru' ? 'Загрузка BumpMesh' :
        hostLanguage === 'zh' ? '正在加载 BumpMesh' : 'Loading BumpMesh';
      progress.textContent = startupLabel;
      const webChunks = [];
      let webTotal = null;
      const initialHostTheme = document.documentElement.getAttribute('data-orca-theme');
      if (frameUrl && (initialHostTheme === 'light' || initialHostTheme === 'dark')) {
        frameUrl.searchParams.set('orcaslicerTheme', initialHostTheme);
      }
      const frameOrigin = frameUrl ? frameUrl.origin : window.location.origin;
      const frame = document.getElementById('bumpmesh');
      let activeTransfer = null;

      function sendToBumpMesh(message, transfer) {
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({
          source: pluginSource,
          protocol,
          ...message,
        }, !frameUrl || frameOrigin === 'null' ? '*' : frameOrigin, transfer || []);
      }

      function sendToPlugin(message) {
        if (!window.orca) return;
        window.orca.postMessage(message);
      }

      function sendHostTheme() {
        const theme = document.documentElement.getAttribute('data-orca-theme');
        if (theme === 'light' || theme === 'dark') {
          sendToBumpMesh({ type: 'host-theme', theme });
        }
      }

      async function receiveWebChunk(message) {
        try {
          if (message.index !== webChunks.length || typeof message.data !== 'string' ||
              !Number.isInteger(message.totalChunks) || message.totalChunks < 1 ||
              message.totalChunks > 1024 || (webTotal !== null && webTotal !== message.totalChunks)) {
            throw new Error('Invalid BumpMesh page transfer.');
          }
          webTotal = message.totalChunks;
          webChunks.push(message.data);
          progress.textContent = startupLabel + ' ' + Math.floor(webChunks.length / webTotal * 100) + '%';
          if (webChunks.length < webTotal) {
            sendToPlugin({type: 'web-chunk-request', index: webChunks.length});
            return;
          }
          const compressed = decodeChunk(webChunks.join(''));
          webChunks.length = 0;
          const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
          const app = await new Response(stream).json();
          const assets = {};
          for (const [name, asset] of Object.entries(app.assets)) {
            assets[name] = URL.createObjectURL(new Blob([decodeChunk(asset.data)], {type: asset.mime}));
          }
          // Module workers need an origin-independent URL on the host HTML page.
          const workers = Object.fromEntries(Object.entries(app.workers).map(([name, script]) =>
            [name, 'data:text/javascript;charset=utf-8,' + encodeURIComponent(script)]));
          const mainUrl = URL.createObjectURL(new Blob([app.main], {type: 'text/javascript'}));
          const query = new URLSearchParams({orcaslicer: '1', orcaslicerLang: hostLanguage,
            orcaslicerTheme: initialHostTheme || 'dark'}).toString();
          const config = 'globalThis.__ORCA_QUERY=' + JSON.stringify(query) +
            ';globalThis.__BUMPMESH_ASSETS=' + JSON.stringify(assets) +
            ';globalThis.__BUMPMESH_WORKERS=' + JSON.stringify(workers) + ';';
          let markup = app.html.replace('<head>', '<head><script>' + config + '<' + '/script>');
          markup = markup.replaceAll('src="logo.png"', 'src="' + assets['logo.png'] + '"')
            .replaceAll('href="logo.png"', 'href="' + assets['logo.png'] + '"');
          frame.srcdoc = markup.replace('</body>', '<script type="module" src="' + mainUrl + '"><' + '/script></body>');
        } catch (error) {
          progress.textContent = startupLabel + ': ' + error.message;
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
        if (event.source !== frame.contentWindow) return;
        if (frameUrl ? event.origin !== frameOrigin :
            (event.origin !== 'null' && event.origin !== window.location.origin)) return;
        const message = event.data;
        if (!message || message.source !== appSource || message.protocol !== protocol) return;
        if (message.type === 'ready') { sendHostTheme(); progress.remove(); }
        if (message.type === 'ready' || message.type === 'refresh-objects' ||
            message.type === 'request-model' ||
            message.type === 'model-loaded' || message.type === 'model-load-error' ||
            ['return-start', 'return-chunk', 'return-done', 'return-cancel'].includes(message.type)) {
          sendToPlugin(message);
        }
      });

      frame.addEventListener('load', () => {
        sendHostTheme();
      });

      new MutationObserver(sendHostTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-orca-theme'],
      });

      if (window.orca) {
        window.orca.onMessage((message) => {
          if (!message || message.protocol !== protocol) return;
          if (message.type === 'web-chunk') { receiveWebChunk(message); return; }
          if (message.type === 'web-error') { progress.textContent = startupLabel + ': ' + message.message; return; }
          if (message.type === 'objects' || message.type === 'transfer-error' ||
              message.type.startsWith('return-')) {
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

      if (frameUrl) frame.src = frameUrl.toString();
      else sendToPlugin({type: 'web-chunk-request', index: 0});
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


def _asset_path(name: str) -> Path:
    module_dir = Path(__file__).resolve().parent
    paths = [module_dir / 'bumpmesh_orca_assets' / name]
    paths.extend(module_dir.glob(f'bumpmesh-*.data/data/bumpmesh_orca_assets/{name}'))
    for path in paths:
        if path.is_file():
            return path
    raise FileNotFoundError(f'Missing BumpMesh asset: {name}. Install the complete BumpMesh wheel.')


_ui_payload = None


def _web_payload() -> str:
    global _ui_payload
    if _ui_payload is None:
        _ui_payload = (EMBEDDED_WEB_UI or base64.b64encode(
            _asset_path('bumpmesh-web.json.gz').read_bytes()).decode('ascii'))
    return _ui_payload


def _bumpmesh_base_url() -> str:
    """Allow contributors to point the plugin at a loopback checkout only."""
    candidate = os.environ.get("BUMPMESH_ORCASLICER_DEV_URL", "").strip()
    if not candidate:
        return ""
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        return ""
    if parsed.username or parsed.password:
        return ""
    return candidate


def bumpmesh_frame_url() -> str:
    base_url = _bumpmesh_base_url()
    if not base_url:
        return ""
    parsed = urllib.parse.urlsplit(base_url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.update({"orcaslicer": "1", "orcaslicerLang": _host_language()})
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def render_page() -> str:
    try:
        return (PAGE_TEMPLATE.replace("__FRAME_URL__", json.dumps(bumpmesh_frame_url()))
                .replace("__HOST_LANGUAGE__", json.dumps(_host_language())))
    except Exception as error:
        message = {
            'ru': 'Не удалось запустить BumpMesh. Установите полный пакет или автономный файл плагина.',
            'zh': '无法启动 BumpMesh。请安装完整软件包或独立插件文件。',
        }.get(_host_language(), 'BumpMesh could not start. Install the complete package or standalone plugin file.')
        return ('<!doctype html><html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">'
                f'<h1>BumpMesh</h1><p>{message}</p><pre>{html.escape(str(error))}</pre></body></html>')


def plugin_icon() -> str:
    module_dir = Path(__file__).resolve().parent
    source_icon = module_dir / "bumpmesh_orca_assets" / "bumpmesh.png"
    if source_icon.is_file():
        return str(source_icon)

    for wheel_icon in module_dir.glob(
        "bumpmesh-*.data/data/bumpmesh_orca_assets/bumpmesh.png"
    ):
        if wheel_icon.is_file():
            return str(wheel_icon)
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
        self._lock = threading.RLock()
        self._active = False
        self._closed = False
        self._return = None
        self._return_pending = False

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._close_return()

    def _close_return(self) -> None:
        if self._return is not None:
            self._return['file'].close()
            self._return = None

    def _safe_post(self, payload: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return
        self._post({"protocol": PROTOCOL_VERSION, **payload})

    def send_objects(self) -> None:
        try:
            self._safe_post({
                "type": "objects", "objects": transferable_objects(),
                "canReturnModel": sys.platform == "win32",
                "maxReturnBytes": MAX_RETURN_BYTES,
            })
        except Exception as error:
            self._safe_post({"type": "transfer-error", "message": str(error)})

    def on_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        with self._lock:
            if self._closed:
                return
        kind = message.get("type")
        if kind == 'web-chunk-request':
            try:
                index = message.get('index')
                if type(index) is not int or index < 0:
                    raise ValueError('Invalid page chunk index.')
                payload = _web_payload()
                count = math.ceil(len(payload) / TRANSFER_CHUNK_BYTES)
                if index >= count:
                    raise ValueError('Page chunk index is out of bounds.')
                start = index * TRANSFER_CHUNK_BYTES
                self._safe_post({'type': 'web-chunk', 'index': index, 'totalChunks': count,
                                 'data': payload[start:start + TRANSFER_CHUNK_BYTES]})
            except Exception as error:
                self._safe_post({'type': 'web-error', 'message': str(error)})
            return
        if kind in {"return-start", "return-chunk", "return-done", "return-cancel"}:
            self._receive_return(message)
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

    def _receive_return(self, message: dict[str, Any]) -> None:
        transfer_id = message.get('transferId')
        if not isinstance(transfer_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', transfer_id):
            return
        with self._lock:
            if self._closed:
                return
            try:
                kind = message['type']
                if self._return and time.monotonic() - self._return['updated'] > 60:
                    self._close_return()
                if kind == 'return-start':
                    if self._return or self._return_pending:
                        raise ValueError('Another model return is already running.')
                    if sys.platform != 'win32':
                        raise ValueError('Automatic return is currently supported on Windows only.')
                    size = message.get('totalBytes')
                    if type(size) is not int or not 134 <= size <= MAX_RETURN_BYTES:
                        raise ValueError('The returned model exceeds the size limit or is empty.')
                    name = _safe_stl_name(str(message.get('name', 'textured'))[:120], 0)
                    if not name.lower().endswith('.stl'):
                        name += '.stl'
                    folder = Path(orca.host.plugin.storage()) / 'bumpmesh-output'
                    folder.mkdir(parents=True, exist_ok=True)
                    path = folder / f'{uuid.uuid4().hex}-{name}'
                    partial = path.with_suffix('.stl.part')
                    self._return = {
                        'id': transfer_id, 'file': partial.open('xb'), 'partial': partial,
                        'path': path, 'size': size, 'received': 0, 'index': 0,
                        'updated': time.monotonic(),
                    }
                    self._safe_post({'type': 'return-ack', 'transferId': transfer_id, 'index': -1})
                    return
                state = self._return
                if not state or state['id'] != transfer_id:
                    raise ValueError('The model return has expired. Please send it again.')
                if kind == 'return-cancel':
                    self._close_return()
                    return
                if kind == 'return-chunk':
                    encoded = message.get('data')
                    index = message.get('index')
                    if type(index) is not int or index != state['index']:
                        raise ValueError('The model return contains an out-of-order chunk.')
                    if not isinstance(encoded, str) or len(encoded) > 4 * ((TRANSFER_CHUNK_BYTES + 2) // 3):
                        raise ValueError('Invalid model chunk size.')
                    chunk = base64.b64decode(encoded, validate=True)
                    expected = min(TRANSFER_CHUNK_BYTES, state['size'] - state['received'])
                    if not chunk or len(chunk) != expected:
                        raise ValueError('The returned model chunk has the wrong size.')
                    state['file'].write(chunk)
                    state['received'] += len(chunk)
                    state['index'] += 1
                    state['updated'] = time.monotonic()
                    self._safe_post({'type': 'return-ack', 'transferId': transfer_id, 'index': index})
                    return
                if state['received'] != state['size']:
                    raise ValueError('The model return was incomplete.')
                self._close_return()
                self._return_pending = True
                threading.Thread(target=self._import_return, args=(transfer_id, state),
                                 name='bumpmesh-model-return', daemon=True).start()
            except Exception as error:
                if self._return and self._return['id'] == transfer_id:
                    self._close_return()
                self._safe_post({'type': 'return-error', 'transferId': transfer_id, 'message': str(error)})

    def _import_return(self, transfer_id: str, state: dict[str, Any]) -> None:
        try:
            validate_return_stl(state['partial'])
            state['partial'].rename(state['path'])
            with self._lock:
                if self._closed:
                    return
            request_windows_import(state['path'])
            self._safe_post({'type': 'return-sent', 'transferId': transfer_id})
        except Exception as error:
            self._safe_post({'type': 'return-error', 'transferId': transfer_id,
                             'message': str(error), 'path': str(state['path'])})
        finally:
            with self._lock:
                self._return_pending = False


def validate_return_stl(path: Path) -> None:
    """Reject truncated and non-finite geometry before the native file loader sees it."""
    with path.open('rb') as stream:
        header = stream.read(84)
        count = int.from_bytes(header[80:84], 'little')
        if len(header) != 84 or count == 0 or path.stat().st_size != 84 + 50 * count:
            raise ValueError('The returned file is not a complete binary STL.')
        record = np.dtype([('values', '<f4', (12,)), ('attribute', '<u2')])
        while data := stream.read(50 * 8192):
            if not np.isfinite(np.frombuffer(data, dtype=record)['values']).all():
                raise ValueError('The returned STL contains invalid coordinates.')


def request_windows_import(path: Path) -> None:
    """Send one file-open request to this process, never another slicer instance."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    user32.GetPropW.argtypes = (wintypes.HWND, wintypes.LPCWSTR)
    user32.GetPropW.restype = wintypes.HANDLE
    user32.SendMessageTimeoutW.argtypes = (
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t),
    )
    user32.SendMessageTimeoutW.restype = ctypes.c_ssize_t
    windows = []

    @callback_type
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid() and (
            user32.GetPropW(hwnd, 'Instance_Hash_Minor') or
            user32.GetPropW(hwnd, 'Instance_Hash_Major')
        ):
            windows.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    if len(windows) != 1:
        raise RuntimeError('Could not identify the current OrcaSlicer window.')

    class CopyData(ctypes.Structure):
        _fields_ = [('dwData', ctypes.c_size_t), ('cbData', wintypes.DWORD),
                    ('lpData', ctypes.c_void_p)]

    # Orca uses escape_strings_cstyle, not command-line quoting.
    filename = str(path.resolve()).replace('\\', '\\\\').replace('"', '\\"')
    payload = ctypes.create_unicode_buffer(f'orca-slicer;"{filename}"')
    data = CopyData(1, ctypes.sizeof(payload), ctypes.cast(payload, ctypes.c_void_p))
    result = ctypes.c_size_t()
    if not user32.SendMessageTimeoutW(windows[0], 0x004A, 0, ctypes.addressof(data),
                                     0x0002, 5000, ctypes.byref(result)):
        raise RuntimeError('OrcaSlicer did not confirm the open request. Check the plate before retrying.')


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
