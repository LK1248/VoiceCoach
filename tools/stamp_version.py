"""Stamp a version onto every module import and asset link (`?v=...`).

Browsers (and GitHub Pages, which allows 10-minute caching) can otherwise mix a
new index.html with cached old modules, breaking the app until a hard refresh.
Run this before each commit that changes js/ or css/:

    python tools/stamp_version.py            # version = current UTC timestamp
    python tools/stamp_version.py 20261001a  # explicit version
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# `from './x.js'` / `import('./x.js')`, with or without an existing ?v=
JS_IMPORT = re.compile(r"""((?:from|import)\s*\(?\s*['"]\./[\w\-/]+\.js)(?:\?v=[\w.-]+)?(['"])""")
# src="js/x.js" / href="css/x.css" in index.html
HTML_ASSET = re.compile(r"""((?:src|href)="(?:js|css)/[\w\-/]+\.(?:js|css))(?:\?v=[\w.-]+)?(")""")


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    changed = 0
    for path in sorted((ROOT / "js").glob("*.js")):
        text = path.read_text(encoding="utf-8")
        new = JS_IMPORT.sub(rf"\1?v={version}\2", text)
        if new != text:
            path.write_text(new, encoding="utf-8", newline="\n")
            changed += 1
    index = ROOT / "index.html"
    text = index.read_text(encoding="utf-8")
    new = HTML_ASSET.sub(rf"\1?v={version}\2", text)
    if new != text:
        index.write_text(new, encoding="utf-8", newline="\n")
        changed += 1
    print(f"stamped v={version} in {changed} files")


if __name__ == "__main__":
    main()
