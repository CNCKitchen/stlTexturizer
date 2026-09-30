from __future__ import annotations

import argparse
import ast
import base64
import csv
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "bumpmesh_plugin.py"
ASSETS = ROOT / "bumpmesh_orca_assets"
DESCRIPTION = ROOT / "description.md"
CHANGELOG = ROOT / "CHANGELOG.md"
PLUGIN_IMAGE = ASSETS / "bumpmesh.png"
LICENSE = ROOT / "LICENSE"


def _wheel_record_digest(payload: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest())
    return "sha256=" + digest.rstrip(b"=").decode("ascii")


def _normalize_wheel_metadata(wheel_path: Path) -> None:
    """Keep OrcaSlicer's Windows wheel parser from retaining CR in fields."""
    with zipfile.ZipFile(wheel_path, "r") as archive:
        entries = archive.infolist()
        payloads = {entry.filename: archive.read(entry.filename) for entry in entries}

    metadata_paths = [
        name for name in payloads if name.endswith(".dist-info/METADATA")
    ]
    if len(metadata_paths) != 1:
        raise ValueError("Wheel must contain exactly one METADATA file")
    metadata_path = metadata_paths[0]
    record_path = metadata_path.removesuffix("METADATA") + "RECORD"
    if record_path not in payloads:
        raise ValueError("Wheel RECORD file is missing")

    metadata = payloads[metadata_path].replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    payloads[metadata_path] = metadata
    rows = list(csv.reader(io.StringIO(
        payloads[record_path].decode("utf-8"),
        newline="",
    )))
    metadata_rows = [row for row in rows if row and row[0] == metadata_path]
    if len(metadata_rows) != 1:
        raise ValueError("Wheel RECORD must contain exactly one METADATA row")
    metadata_rows[0][1:] = [_wheel_record_digest(metadata), str(len(metadata))]
    record_buffer = io.StringIO(newline="")
    csv.writer(record_buffer, lineterminator="\n").writerows(rows)
    payloads[record_path] = record_buffer.getvalue().encode("utf-8")

    temporary = wheel_path.with_suffix(wheel_path.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for entry in entries:
                archive.writestr(entry, payloads[entry.filename])
        temporary.replace(wheel_path)
    finally:
        temporary.unlink(missing_ok=True)


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


def extract_changelog_section(version: str) -> str:
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()
    headings = [
        (index, match.group("version"))
        for index, line in enumerate(lines)
        if (match := re.fullmatch(r"## (?P<version>\d+\.\d+\.\d+)", line.strip()))
    ]
    if not headings:
        raise ValueError("No numeric release sections found in CHANGELOG.md")
    if headings[0][1] != version:
        raise ValueError(
            f"Top CHANGELOG.md section is {headings[0][1]}, expected {version}"
        )
    start = headings[0][0] + 1
    end = headings[1][0] if len(headings) > 1 else len(lines)
    body = "\n".join(lines[start:end]).strip()
    if not body:
        raise ValueError(f"CHANGELOG.md section {version} is empty")
    return body


def render_release_notes(version: str) -> str:
    return (
        f"## BumpMesh {version}\n\n"
        f"{extract_changelog_section(version)}\n\n"
        "Package checksums are available in `SHA256SUMS`.\n"
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_standalone(destination: Path) -> None:
    source = SOURCE.read_text(encoding='utf-8')
    marker = 'EMBEDDED_WEB_UI = ""'
    if source.count(marker) != 1:
        raise ValueError('Standalone web archive marker is missing or ambiguous')
    encoded = base64.b64encode((ASSETS / 'bumpmesh-web.json.gz').read_bytes()).decode('ascii')
    # Adjacent literals make CPython repeatedly copy this large string at import.
    payload = 'EMBEDDED_WEB_UI = (\n' + repr(encoded) + '\n)'
    result = source.replace(marker, payload)
    compile(result, str(destination), 'exec')
    destination.write_text(result, encoding='utf-8', newline='\n')


def validate_wheel(wheel: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        runtime = archive.read('bumpmesh_plugin.py').decode('utf-8')
        embedded = re.search(r"(?ms)^EMBEDDED_WEB_UI = \(\n(.*?)\n\)", runtime)
        if embedded is None:
            raise ValueError('Wheel must contain the matching embedded BumpMesh application')
        encoded = ''.join(line.strip().strip("'") for line in embedded[1].splitlines())
        web = json.loads(gzip.decompress(base64.b64decode(encoded, validate=True)))
        for required in ('html', 'main', 'workers', 'assets'):
            if required not in web:
                raise ValueError(f'Bundled web application is missing {required}')
        top_level_files = [name for name in names if name.endswith(".dist-info/top_level.txt")]
        if len(top_level_files) != 1:
            raise ValueError("Wheel must contain exactly one top_level.txt")
        top_levels = archive.read(top_level_files[0]).decode("utf-8").splitlines()
        if top_levels != ["bumpmesh_plugin"]:
            raise ValueError(
                "OrcaSlicer requires one wheel top-level module; "
                f"found {top_levels!r}"
            )
        if not any(
            name.endswith(".data/data/bumpmesh_orca_assets/bumpmesh.png")
            for name in names
        ):
            raise ValueError("Wheel does not contain the BumpMesh tab icon")


def build_wheel(version: str, output_root: Path, release_dir: Path, runtime: Path) -> Path:
    build_dir = output_root / "wheel-build"
    build_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(runtime, build_dir / SOURCE.name)
    shutil.copy2(ROOT / "pyproject.toml", build_dir / "pyproject.toml")
    shutil.copy2(LICENSE, build_dir / LICENSE.name)
    (build_dir / ASSETS.name).mkdir(exist_ok=True)
    shutil.copy2(PLUGIN_IMAGE, build_dir / ASSETS.name / PLUGIN_IMAGE.name)
    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(release_dir)],
        cwd=build_dir,
        check=True,
    )
    wheel = release_dir / f"bumpmesh-{version}-py3-none-any.whl"
    if not wheel.is_file():
        raise FileNotFoundError(f"Expected wheel was not created: {wheel}")
    _normalize_wheel_metadata(wheel)
    validate_wheel(wheel)
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
    extract_changelog_section(version)

    for required in (PLUGIN_IMAGE, ASSETS / 'bumpmesh-web.json.gz', DESCRIPTION, CHANGELOG, LICENSE):
        if not required.is_file():
            raise FileNotFoundError(f"Required publishing file is missing: {required}")
    if PLUGIN_IMAGE.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Plugin image exceeds the Orca Cloud 2 MB limit")

    release_dir = output_root / f"bumpmesh-{version}"
    release_dir.mkdir(parents=True, exist_ok=True)
    standalone = release_dir / 'bumpmesh_plugin.py'
    build_standalone(standalone)
    wheels = output_root / 'wheels'
    wheels.mkdir(exist_ok=True)
    wheel = build_wheel(version, output_root, wheels, standalone)
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

    checksum_paths = [standalone, image, description, changelog, license_file, metadata_path]
    (release_dir / "SHA256SUMS").write_text(
        "\n".join(f"{sha256(path)}  {path.name}" for path in checksum_paths) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (output_root / 'RELEASE_NOTES.md').write_text(render_release_notes(version), encoding='utf-8', newline='\n')
    (output_root / 'SHA256SUMS').write_text(
        f'{sha256(wheel)}  wheels/{wheel.name}\n', encoding='utf-8', newline='\n')
    return release_dir


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the BumpMesh Orca Cloud Plugin Hub upload kit"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output root (default: plugins/bumpmesh/dist/release-<current-version>)",
    )
    parser.add_argument(
        "--release-notes",
        type=Path,
        help="Write GitHub release notes from the current changelog section",
    )
    args = parser.parse_args()
    version = extract_runtime_version(SOURCE.read_text(encoding='utf-8'))
    output = args.output.resolve() if args.output else ROOT / 'dist' / f'release-{version}'
    release_dir = build(output)
    if args.release_notes is not None:
        source = SOURCE.read_text(encoding="utf-8")
        version = extract_runtime_version(source)
        notes_path = args.release_notes.resolve()
        notes_path.parent.mkdir(parents=True, exist_ok=True)
        notes_path.write_text(
            render_release_notes(version), encoding="utf-8", newline="\n"
        )
    print(release_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
