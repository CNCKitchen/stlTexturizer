# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import importlib.util
import io
import pathlib
import struct
import sys
import types
import unittest
from unittest import mock

import numpy as np


PLUGIN_PATH = pathlib.Path(__file__).with_name("bumpmesh_plugin.py")


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
            url = self.plugin.bumpmesh_frame_url()
        self.assertIn("orcaslicer=1", url)
        self.assertIn("orcaslicerLang=ru", url)

    def test_development_url_enables_webview_diagnostics(self):
        with mock.patch.dict(
            self.plugin.os.environ,
            {"BUMPMESH_ORCASLICER_DEV_URL": "http://127.0.0.1:8000/"},
        ):
            url = self.plugin.bumpmesh_frame_url()

        self.assertIn("orcaslicerDebug=1", url)
        self.assertIn("orcaslicerBridge=6", url)

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
            self.assertTrue(self.plugin.bumpmesh_frame_url().startswith("https://bumpmesh.com/"))

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
        self.assertIn("wrapper-message-observed", page)
        self.assertIn("if (!debug) return", page)
        self.assertIn("data-orca-theme", page)
        self.assertIn("host-theme", page)
        self.assertIn("orcaslicer=1", page)

    def test_refresh_objects_resends_current_model_list(self):
        posted = []
        controller = self.plugin.TransferController(posted.append)

        with mock.patch.object(self.plugin, "transferable_objects", return_value=[{"id": 7}]):
            controller.on_message({"type": "refresh-objects"})

        self.assertEqual(
            posted,
            [{"protocol": self.plugin.PROTOCOL_VERSION, "type": "objects", "objects": [{"id": 7}]}],
        )

    def test_webview_diagnostic_is_written_to_python_stderr(self):
        controller = self.plugin.TransferController(lambda payload: None)
        stderr = io.StringIO()

        with mock.patch.object(self.plugin.sys, "stderr", stderr):
            controller.on_message(
                {"type": "diagnostic", "event": "control-click", "details": {"id": "load"}}
            )

        self.assertIn('[BumpMesh WebView] control-click {"id":"load"}', stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
