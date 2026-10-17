"""The ready zip people download from the GitHub release: dist/burnout-for-gmail.zip.

The extension's files sit at the zip's root, plus the LICENSE, so unzipping it gives one
burnout-for-gmail folder to pick in Load unpacked (with the whole repository's zip, people pick
the wrong folder and Chrome says "Manifest file is missing"). The name has no version on purpose:
the README's link (releases/latest/download/burnout-for-gmail.zip) and the one in the manual
keep working for every new release. The version is in the release itself (tag v<version>) and in
the manifest. manifest.json carries a fixed "key", so Burnout has the same ID whatever folder it's
loaded from: an update loaded from a new folder replaces the old one and keeps the settings. (The
Chrome Web Store doesn't take a manifest with a "key": take it out before uploading there.)

    python scripts/package.py
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
OUT = ROOT / "dist" / "burnout-for-gmail.zip"

if __name__ == "__main__":
    version = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(EXT.rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts:
                z.write(f, f.relative_to(EXT).as_posix())
        z.write(ROOT / "LICENSE", "LICENSE")
    print(f"{OUT} (version {version}, {OUT.stat().st_size} bytes)")
