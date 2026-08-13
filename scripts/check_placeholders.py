#!/usr/bin/env python3
"""Pre-commit guard: fail when template placeholders survive initialization.

While the repository is still the pristine template (detected by the
"## Initialization (first time only)" section in AGENTS.md), the check is a
no-op. Once that section has been removed — i.e. the repo claims to be
initialized — any leftover placeholder token fails the commit with a
file:line listing so the fix is mechanical.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from init_module import REPO_ROOT, report_findings, scan_placeholders  # noqa: E402

TEMPLATE_MARKER = "## Initialization (first time only)"


def main() -> int:
    agents_md = REPO_ROOT / "AGENTS.md"
    if agents_md.is_file() and TEMPLATE_MARKER in agents_md.read_text(encoding="utf-8"):
        return 0  # still the pristine template; placeholders are expected

    findings = scan_placeholders(skip_instruction_files=False)
    if findings:
        print(
            "Template placeholders are still present although the AGENTS.md\n"
            "Initialization section was removed. Fix them (or re-run\n"
            "scripts/init_module.py) before committing:"
        )
        report_findings(findings)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
