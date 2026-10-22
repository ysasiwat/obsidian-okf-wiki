"""Read a bundle with the OKF reference parser and print what it concludes per concept.

    python -E -P reference_check.py <bundle-dir> <now-iso>

Prints JSON: {"<bundle-relative path>": {"valid": bool, "error": str|null,
"tier": str|null, "stale": bool|null}} for every non-reserved .md file.
"""

import importlib.util
import json
import pathlib
import sys
from datetime import datetime

here = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("okf_reference_document", here / "okf_reference_document.py")
ref = importlib.util.module_from_spec(spec)
sys.modules["okf_reference_document"] = ref  # dataclasses resolve annotations through sys.modules
spec.loader.exec_module(ref)

root = pathlib.Path(sys.argv[1])
now = datetime.fromisoformat(sys.argv[2])
out = {}
for path in sorted(root.rglob("*.md")):
    rel = path.relative_to(root).as_posix()
    if path.name in ("index.md", "log.md") or any(part.startswith(".") for part in path.relative_to(root).parts):
        continue
    entry = {"valid": True, "error": None, "tier": None, "stale": None}
    try:
        doc = ref.OKFDocument.parse(path.read_text(encoding="utf-8"))
        doc.validate()
        entry["tier"] = ref.trust_tier(doc.frontmatter)
        entry["stale"] = ref.is_stale(doc.frontmatter, now)
    except Exception as e:  # report, do not crash: the comparison decides
        entry["valid"] = False
        entry["error"] = f"{type(e).__name__}: {e}"
    out[rel] = entry
print(json.dumps(out, ensure_ascii=False))
