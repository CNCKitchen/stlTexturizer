# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import base64
import csv
import hashlib
import io
import importlib.util
import pathlib
import struct
import sys
import tempfile
import types
import unittest
import zipfile
from unittest import mock

import numpy as np


PLUGIN_PATH = pathlib.Path(__file__).with_name("bumpmesh_plugin.py")
BUILD_PATH = pathlib.Path(__file__).with_name("build_package.py")


def load_plugin():
    fake_orca = types.ModuleType("orca")
    fake_orca.base = object
    fake_orca.plugin = lambda cls: cls
    fake_orca.register_capability = lambda capability: None
    fake_orca.pages = types.SimpleNamespace(PagesPluginCapabilityBase=object)
    fake_orca.script = types.SimpleNamespace(ScriptPluginCapabilityBase=object)
    fake_orca.host = types.SimpleNamespace(
        app_language=lambda: "en_US",
        model=lambda: types.SimpleNamespace(objects=lambda: []),
        ui=types.SimpleNamespace(),
    )
    fake_orca.ExecutionResult = types.SimpleNamespace(
        success=lambda message: ("success", message),
        skipped=lambda message: ("skipped", message),
    )
    sys.modules["orca"] = fake_orca

    spec = importlib.util.spec_from_file_location("bumpmesh_plugin_under_test", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class BumpMeshPluginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = load_plugin()

    def test_frame_url_uses_orca_language(self):
        with mock.patch.object(self.plugin.orca.host, "app_language", return_value="ru_RU"):
            page = self.plugin.render_page()
        self.assertIn('const hostLanguage = "ru"', page)
        self.assertLess(len(page.encode("utf-8")), 100_000)

    def test_development_url_keeps_embedded_mode_parameters(self):
        with mock.patch.dict(
            self.plugin.os.environ,
            {"BUMPMESH_ORCASLICER_DEV_URL": "http://127.0.0.1:8000/"},
        ):
            url = self.plugin.bumpmesh_frame_url()

        self.assertIn("orcaslicer=1", url)
        self.assertIn("orcaslicerLang=en", url)

    def test_development_url_accepts_loopback_only(self):
        with mock.patch.dict(
            self.plugin.os.environ,
            {"BUMPMESH_ORCASLICER_DEV_URL": "http://127.0.0.1:8000/"},
        ):
            self.assertTrue(self.plugin.bumpmesh_frame_url().startswith("http://127.0.0.1:8000/"))

        with mock.patch.dict(
            self.plugin.os.environ,
            {"BUMPMESH_ORCASLICER_DEV_URL": "https://example.com/"},
        ):
            self.assertEqual(self.plugin.bumpmesh_frame_url(), "")

    def test_page_bootstrap_uses_host_messages_without_writes_or_sockets(self):
        import socket
        payload = 'A' * (self.plugin.TRANSFER_CHUNK_BYTES + 5)
        posted = []
        controller = self.plugin.TransferController(posted.append)
        with mock.patch.object(self.plugin, '_ui_payload', None), \
             mock.patch.object(self.plugin, 'EMBEDDED_WEB_UI', payload), \
             mock.patch('builtins.open', side_effect=AssertionError('No file IO allowed')), \
             mock.patch.object(socket, 'socket', side_effect=AssertionError('No sockets allowed')):
            controller.on_message({'type': 'web-chunk-request', 'index': 0})
            controller.on_message({'type': 'web-chunk-request', 'index': 1})
        self.assertEqual(''.join(message['data'] for message in posted), payload)
        self.assertEqual(posted[0]['totalChunks'], 2)
        self.assertEqual(posted[1]['index'], 1)

    def test_bootstrap_rejects_invalid_chunk_and_stops_after_close(self):
        posted = []
        controller = self.plugin.TransferController(posted.append)
        with mock.patch.object(self.plugin, '_ui_payload', 'AAAA'):
            for index in (-1, 9, True, '0'):
                controller.on_message({'type': 'web-chunk-request', 'index': index})
                self.assertEqual(posted[-1]['type'], 'web-error')
            controller.close()
            posted.clear()
            controller.on_message({'type': 'web-chunk-request', 'index': 0})
            self.assertEqual(posted, [])

    def test_wheel_icon_asset_is_available(self):
        icon = pathlib.Path(self.plugin.plugin_icon())

        self.assertEqual(icon.suffix, ".png")
        self.assertTrue(icon.is_file())

    def test_missing_assets_show_diagnostic_instead_of_blank_page(self):
        with mock.patch.object(self.plugin, '_bumpmesh_base_url',
                               side_effect=FileNotFoundError('Missing <web> archive')):
            page = self.plugin.render_page()
        self.assertIn('BumpMesh could not start', page)
        self.assertIn('Missing &lt;web&gt; archive', page)

    def test_binary_stl_applies_volume_transform(self):
        vertices = np.array(
            [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            dtype=np.float64,
        )
        triangles = np.array([[0, 1, 2]], dtype=np.int64)
        matrix = np.eye(4)
        matrix[:3, 3] = [10, 20, 30]
        snapshot = self.plugin.ObjectSnapshot(
            object_id=1,
            name="triangle",
            volumes=(self.plugin.VolumeSnapshot(vertices, triangles, matrix),),
            triangle_count=1,
        )

        payload = self.plugin.encode_binary_stl(snapshot)

        self.assertEqual(len(payload), 134)
        self.assertEqual(struct.unpack_from("<I", payload, 80), (1,))
        record = struct.unpack_from("<12fH", payload, 84)
        self.assertEqual(record[0:3], (0.0, 0.0, 1.0))
        self.assertEqual(record[3:6], (10.0, 20.0, 30.0))
        self.assertEqual(record[6:9], (11.0, 20.0, 30.0))
        self.assertEqual(record[9:12], (10.0, 21.0, 30.0))
        self.assertEqual(record[12], 0)

    def test_binary_stl_preserves_winding_for_mirrored_volume(self):
        vertices = np.array(
            [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            dtype=np.float64,
        )
        matrix = np.eye(4)
        matrix[0, 0] = -1
        snapshot = self.plugin.ObjectSnapshot(
            object_id=1,
            name="mirrored",
            volumes=(
                self.plugin.VolumeSnapshot(
                    vertices,
                    np.array([[0, 1, 2]], dtype=np.int64),
                    matrix,
                ),
            ),
            triangle_count=1,
        )

        record = struct.unpack_from("<12fH", self.plugin.encode_binary_stl(snapshot), 84)

        self.assertEqual(record[0:3], (0.0, 0.0, 1.0))
        self.assertEqual(record[3:6], (0.0, 0.0, 0.0))
        self.assertEqual(record[6:9], (0.0, 1.0, 0.0))
        self.assertEqual(record[9:12], (-1.0, 0.0, 0.0))

    def test_stl_filename_is_sanitized(self):
        self.assertEqual(self.plugin._safe_stl_name('part/with:*?"slashes', 12), "part_with____slashes")
        self.assertEqual(self.plugin._safe_stl_name("...", 12), "orca-object-12")

    def test_transferable_objects_skips_modifiers(self):
        class Volume:
            def __init__(self, model_part, facets, negative=False):
                self._model_part = model_part
                self._facets = facets
                self._negative = negative

            def is_model_part(self):
                return self._model_part

            def facets_count(self):
                return self._facets

            def is_negative_volume(self):
                return self._negative

        model_object = types.SimpleNamespace(
            id=lambda: 42,
            name="Fixture",
            volumes=lambda: [Volume(True, 12), Volume(False, 99)],
        )
        model = types.SimpleNamespace(objects=lambda: [model_object])
        with mock.patch.object(self.plugin.orca.host, "model", return_value=model):
            objects = self.plugin.transferable_objects()

        self.assertEqual(
            objects,
            [{"id": 42, "name": "Fixture", "triangleCount": 12, "volumeCount": 1}],
        )

    def test_negative_volume_is_marked_unsupported(self):
        class Volume:
            def __init__(self, model_part, negative, facets):
                self._model_part = model_part
                self._negative = negative
                self._facets = facets

            def is_model_part(self):
                return self._model_part

            def is_negative_volume(self):
                return self._negative

            def facets_count(self):
                return self._facets

        model_object = types.SimpleNamespace(
            id=lambda: 9,
            name="Cut object",
            volumes=lambda: [Volume(True, False, 12), Volume(False, True, 4)],
        )
        with mock.patch.object(
            self.plugin.orca.host,
            "model",
            return_value=types.SimpleNamespace(objects=lambda: [model_object]),
        ):
            objects = self.plugin.transferable_objects()

        self.assertEqual(objects[0]["disabledReasonCode"], "negative-volumes")

    def test_page_bridge_is_origin_scoped_and_chunked(self):
        page = self.plugin.render_page()
        self.assertIn("event.origin !== frameOrigin", page)
        self.assertIn("transfer-chunk", page)
        self.assertIn("message.type === 'refresh-objects'", page)
        self.assertIn("data-orca-theme", page)
        self.assertIn("host-theme", page)
        self.assertIn("orcaslicer: '1'", page)

    def test_refresh_objects_resends_current_model_list(self):
        posted = []
        controller = self.plugin.TransferController(posted.append)

        with mock.patch.object(self.plugin, "transferable_objects", return_value=[{"id": 7}]):
            controller.on_message({"type": "refresh-objects"})

        self.assertEqual(
            posted,
            [{"protocol": self.plugin.PROTOCOL_VERSION, "type": "objects", "objects": [{"id": 7}],
              "canReturnModel": sys.platform == 'win32', "maxReturnBytes": self.plugin.MAX_RETURN_BYTES}],
        )

    def test_return_stl_is_validated_and_sent_once(self):
        payload = b'\0' * 80 + struct.pack('<I12fH', 1, *([0.0] * 12), 0)
        posted = []
        controller = self.plugin.TransferController(posted.append)
        with tempfile.TemporaryDirectory() as directory:
            storage = types.SimpleNamespace(storage=lambda: directory)
            with mock.patch.object(self.plugin.orca.host, 'plugin', storage, create=True), \
                 mock.patch.object(self.plugin.sys, 'platform', 'win32'), \
                 mock.patch.object(self.plugin, 'request_windows_import') as send, \
                 mock.patch.object(self.plugin.threading, 'Thread') as thread:
                controller.on_message({'type': 'return-start', 'transferId': 'test',
                                       'name': '../../part.stl', 'totalBytes': len(payload)})
                controller.on_message({'type': 'return-chunk', 'transferId': 'test',
                                       'index': 0, 'data': base64.b64encode(payload).decode()})
                controller.on_message({'type': 'return-done', 'transferId': 'test'})
                kwargs = thread.call_args.kwargs
                kwargs['target'](*kwargs['args'])
                self.assertEqual(posted[-1]['type'], 'return-sent')
                path = send.call_args.args[0]
                self.assertEqual(path.parent, pathlib.Path(directory) / 'bumpmesh-output')
                self.assertEqual(path.read_bytes(), payload)
                controller.on_message({'type': 'return-done', 'transferId': 'test'})
                send.assert_called_once()
                self.assertEqual(posted[-1]['type'], 'return-error')

    def test_return_rejects_incomplete_out_of_order_and_oversized_input(self):
        for message in ({'type': 'return-done'},
                        {'type': 'return-chunk', 'index': 1, 'data': 'AAAA'},
                        {'type': 'return-chunk', 'index': 0, 'data': '!invalid!'}):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                posted = []
                controller = self.plugin.TransferController(posted.append)
                storage = types.SimpleNamespace(storage=lambda: directory)
                with mock.patch.object(self.plugin.orca.host, 'plugin', storage, create=True), \
                     mock.patch.object(self.plugin.sys, 'platform', 'win32'), \
                     mock.patch.object(self.plugin, 'request_windows_import') as send:
                    controller.on_message({'type': 'return-start', 'transferId': 'test', 'totalBytes': 134})
                    controller.on_message({**message, 'transferId': 'test'})
                    self.assertEqual(posted[-1]['type'], 'return-error')
                    self.assertIsNone(controller._return)
                    send.assert_not_called()
                    controller.on_message({'type': 'return-start', 'transferId': 'large',
                                           'totalBytes': self.plugin.MAX_RETURN_BYTES + 1})
                    self.assertEqual(posted[-1]['type'], 'return-error')

    def test_return_rejects_nonfinite_or_truncated_stl(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'invalid.stl'
            for payload in (b'\0' * 84, b'\0' * 80 + struct.pack('<I', 2) + b'\0' * 50,
                            b'\0' * 80 + struct.pack('<I12fH', 1, *([float('nan')] * 12), 0)):
                path.write_bytes(payload)
                with self.assertRaises(ValueError):
                    self.plugin.validate_return_stl(path)

    def test_closed_controller_does_not_write_return_files(self):
        controller = self.plugin.TransferController(lambda _: None)
        controller.close()
        with mock.patch.object(self.plugin.Path, 'mkdir') as mkdir:
            controller.on_message({'type': 'return-start', 'transferId': 'test', 'totalBytes': 134})
            mkdir.assert_not_called()

    def test_release_notes_use_only_current_changelog_section(self):
        spec = importlib.util.spec_from_file_location("bumpmesh_builder_under_test", BUILD_PATH)
        self.assertIsNotNone(spec)
        builder = importlib.util.module_from_spec(spec)
        self.assertIsNotNone(spec.loader)
        spec.loader.exec_module(builder)

        notes = builder.render_release_notes("0.1.2")

        self.assertIn("## BumpMesh 0.1.2", notes)
        self.assertIn("Fixed the long pause", notes)
        self.assertNotIn("## 0.1.1", notes)
        self.assertNotIn("## 0.1.0", notes)
        self.assertNotIn("Added a full-size BumpMesh Plugin Page", notes)

    def test_wheel_metadata_uses_lf_and_updates_record_hash(self):
        spec = importlib.util.spec_from_file_location("bumpmesh_builder_under_test", BUILD_PATH)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)

        with tempfile.TemporaryDirectory() as temp:
            wheel = pathlib.Path(temp) / "bumpmesh-0.1.0-py3-none-any.whl"
            metadata_path = "bumpmesh-0.1.0.dist-info/METADATA"
            record_path = "bumpmesh-0.1.0.dist-info/RECORD"
            metadata = b"Metadata-Version: 2.4\r\nName: bumpmesh\r\nVersion: 0.1.0\r\n\r\n"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(metadata_path, metadata)
                archive.writestr(
                    record_path,
                    f"{metadata_path},old,0\r\n{record_path},,\r\n",
                )

            builder._normalize_wheel_metadata(wheel)

            with zipfile.ZipFile(wheel) as archive:
                normalized = archive.read(metadata_path)
                rows = list(csv.reader(io.StringIO(
                    archive.read(record_path).decode("utf-8"),
                    newline="",
                )))
            self.assertNotIn(b"\r", normalized)
            expected_digest = base64.urlsafe_b64encode(
                hashlib.sha256(normalized).digest()
            ).rstrip(b"=").decode("ascii")
            metadata_row = next(row for row in rows if row[0] == metadata_path)
            self.assertEqual(metadata_row[1], f"sha256={expected_digest}")
            self.assertEqual(metadata_row[2], str(len(normalized)))

if __name__ == "__main__":
    unittest.main()
