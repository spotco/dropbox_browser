"""Optionally locate and link the shared remote-worker SDK.

The product remains runnable without this optional checkout.  Discovery is
capability-based: a candidate must contain ``hosts.json`` and a
``python/network_computers`` package.  Machine-specific paths belong in the
gitignored ``LOCAL_NOTES.md`` or in environment variables, never in product
source.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[1]
NOTES_PATH = REPO / "LOCAL_NOTES.md"
ENV_ROOT_KEYS = (
    "DROPBOX_BROWSER_NETWORK_ROOT",
    "NETWORK_COMPUTERS_ROOT",
)


class BootstrapError(RuntimeError):
    """The optional shared worker SDK was requested but could not be loaded."""


def _json_block(text: str, heading: str) -> dict[str, Any] | None:
    pattern = re.compile(
        rf"^##\s+{re.escape(heading)}\s*$.*?```json\s*(.*?)```",
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def remote_notes(notes_path: Path = NOTES_PATH) -> dict[str, Any]:
    """Return the local remote-E2E settings block, or an empty mapping."""

    if not notes_path.is_file():
        return {}
    try:
        text = notes_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    for heading in ("Remote E2E", "Distributed E2E"):
        payload = _json_block(text, heading)
        if payload:
            return payload
    return {}


def _is_candidate(root: Path) -> bool:
    return (
        (root / "hosts.json").is_file()
        and (root / "python" / "network_computers").is_dir()
    )


def _candidate_roots(explicit: str | Path | None = None) -> list[Path]:
    candidates: list[Path] = []
    if explicit:
        # An explicit override is authoritative; do not silently select a
        # different sibling checkout when the requested provider is missing.
        return [Path(explicit).expanduser()]
    for key in ENV_ROOT_KEYS:
        value = os.environ.get(key)
        if value:
            candidates.append(Path(value).expanduser())

    notes = remote_notes()
    for key in ("shared_root", "network_root", "network_computers_root"):
        value = notes.get(key)
        if value:
            candidates.append(Path(str(value)).expanduser())
    nested = notes.get("network_computers")
    if isinstance(nested, dict) and nested.get("root"):
        candidates.append(Path(str(nested["root"])).expanduser())

    # Capability-based sibling discovery lets a configured private checkout
    # work without embedding its repository name in this repository.
    try:
        for sibling in sorted(REPO.parent.iterdir(), key=lambda item: item.name.casefold()):
            if sibling.is_dir() and _is_candidate(sibling):
                candidates.append(sibling)
    except OSError:
        pass

    seen: set[Path] = set()
    result: list[Path] = []
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved not in seen:
            seen.add(resolved)
            result.append(resolved)
    return result


def find_root(explicit: str | Path | None = None) -> Path | None:
    for candidate in _candidate_roots(explicit):
        if _is_candidate(candidate):
            return candidate
    return None


def load_shared(explicit: str | Path | None = None, *, required: bool = False) -> tuple[Path, Any] | None:
    """Add the optional SDK to ``sys.path`` and return ``(root, package)``."""

    root = find_root(explicit)
    if root is None:
        if required:
            searched = ", ".join(str(item) for item in _candidate_roots(explicit)) or "(none)"
            raise BootstrapError(
                "remote E2E was required, but no shared worker SDK was found; "
                f"searched: {searched}"
            )
        return None

    python_dir = str(root / "python")
    if python_dir not in sys.path:
        sys.path.insert(0, python_dir)
    try:
        package = importlib.import_module("network_computers")
    except ImportError as exc:
        raise BootstrapError(f"shared worker SDK import failed from {root}: {exc}") from exc
    os.environ.setdefault("NETWORK_COMPUTERS_ROOT", str(root))
    return root, package
