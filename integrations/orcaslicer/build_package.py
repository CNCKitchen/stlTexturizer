from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "bumpmesh_plugin.py"
ASSETS = ROOT / "bumpmesh_orca_assets"
DESCRIPTION = ROOT / "description.md"
CHANGELOG = ROOT / "CHANGELOG.md"
PLUGIN_IMAGE = ASSETS / "bumpmesh.png"
LICENSE = ROOT / "LICENSE"


def extract_metadata(source: str) -> dict[str, object]:
    lines = source.splitlines()
    try:
        start = lines.index("# /// script")
        end = lines.index("# ///", start + 1)
    except ValueError as exc:
        raise ValueError("PEP 723 metadata block is missing") from exc

    metadata_lines: list[str] = []
    for line in lines[start + 1 : end]:
        if not line.startswith("#"):
            raise ValueError("Every PEP 723 metadata line must be a comment")
        metadata_lines.append(line[2:] if line.startswith("# ") else line[1:])

    metadata = tomllib.loads("\n".join(metadata_lines))
    plugin = metadata.get("tool", {}).get("orcaslicer", {}).get("plugin", {})
    if not isinstance(plugin, dict):
        raise ValueError("[tool.orcaslicer.plugin] metadata is missing")
    if plugin.get("id") != "bumpmesh":
        raise ValueError("Plugin id must remain 'bumpmesh'")
    version = plugin.get("version")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise ValueError("Plugin Hub version must use numeric X.Y.Z format")
    if metadata.get("dependencies") != ["numpy~=2.0"]:
        raise ValueError("The declared NumPy dependency changed unexpectedly")
    return metadata


def extract_runtime_version(source: str) -> str:
    module = ast.parse(source, filename=str(SOURCE))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "PLUGIN_VERSION"
            for target in node.targets
        ):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                return node.value.value
    raise ValueError("PLUGIN_VERSION constant is missing")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_wheel(version: str, output_root: Path, release_dir: Path) -> Path:
    build_dir = output_root / "wheel-build"
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True)
    shutil.copy2(SOURCE, build_dir / SOURCE.name)
    shutil.copy2(ROOT / "pyproject.toml", build_dir / "pyproject.toml")
    shutil.copy2(LICENSE, build_dir / LICENSE.name)
    shutil.copytree(ASSETS, build_dir / ASSETS.name)
    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(release_dir)],
        cwd=build_dir,
        check=True,
    )
    wheel = release_dir / f"bumpmesh-{version}-py3-none-any.whl"
    if not wheel.is_file():
        raise FileNotFoundError(f"Expected wheel was not created: {wheel}")
    return wheel


def build(output_root: Path) -> Path:
    source = SOURCE.read_text(encoding="utf-8")
    ast.parse(source, filename=str(SOURCE))
    metadata = extract_metadata(source)
    plugin = metadata["tool"]["orcaslicer"]["plugin"]
    version = plugin["version"]
    runtime_version = extract_runtime_version(source)
    if runtime_version != version:
        raise ValueError(
            f"Metadata version {version!r} does not match PLUGIN_VERSION {runtime_version!r}"
        )

    for required in (PLUGIN_IMAGE, DESCRIPTION, CHANGELOG, LICENSE):
        if not required.is_file():
            raise FileNotFoundError(f"Required publishing file is missing: {required}")
    if PLUGIN_IMAGE.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Plugin image exceeds the Orca Cloud 2 MB limit")

    release_dir = output_root / f"plugin-hub-{version}"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True)

    wheel = build_wheel(version, output_root, release_dir)
    image = release_dir / "BumpMesh.png"
    description = release_dir / DESCRIPTION.name
    changelog = release_dir / CHANGELOG.name
    license_file = release_dir / LICENSE.name
    shutil.copy2(PLUGIN_IMAGE, image)
    shutil.copy2(DESCRIPTION, description)
    shutil.copy2(CHANGELOG, changelog)
    shutil.copy2(LICENSE, license_file)

    metadata_path = release_dir / "package-metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "id": plugin["id"],
                "name": plugin["name"],
                "description": plugin["description"],
                "author": plugin["author"],
                "version": version,
                "network": plugin.get("network", []),
                "requires_python": metadata.get("requires-python"),
                "dependencies": metadata.get("dependencies"),
                "plugin_file": wheel.name,
                "plugin_image": image.name,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )

    checksum_paths = [wheel, image, description, changelog, license_file, metadata_path]
    (release_dir / "SHA256SUMS").write_text(
        "\n".join(f"{sha256(path)}  {path.name}" for path in checksum_paths) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return release_dir


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the BumpMesh Orca Cloud Plugin Hub upload kit"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "dist",
        help="Output root (default: plugins/bumpmesh/dist)",
    )
    args = parser.parse_args()
    release_dir = build(args.output.resolve())
    print(release_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
