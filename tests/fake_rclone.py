from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any


DEFAULT_MOD_TIME = "2024-01-01T12:00:00Z"


def _fixture_path() -> Path:
    fixture_path = os.environ.get("DROPBOX_BROWSER_FAKE_RCLONE_FIXTURE")
    if not fixture_path:
        raise SystemExit("DROPBOX_BROWSER_FAKE_RCLONE_FIXTURE is required")
    return Path(fixture_path)


def _state_path() -> Path:
    state_path = os.environ.get("DROPBOX_BROWSER_FAKE_RCLONE_STATE")
    if not state_path:
        raise SystemExit("DROPBOX_BROWSER_FAKE_RCLONE_STATE is required")
    return Path(state_path)


def _decode_content(entry: dict[str, Any]) -> bytes:
    if "base64" in entry:
        return base64.b64decode(entry["base64"])
    return str(entry.get("content", "")).encode("utf-8")


def _is_remote_target(value: str) -> bool:
    return value.startswith("dropbox:")


class FakeRemoteState:
    def __init__(self, fixture: dict[str, Any]) -> None:
        self.entries: dict[str, dict[str, Any]] = {}
        for raw_entry in fixture.get("entries", []):
            entry = dict(raw_entry)
            rel_path = self._clean_rel_path(entry["path"])
            kind = entry["type"]
            if kind == "dir":
                self.entries[rel_path] = {
                    "type": "dir",
                    "mod_time": entry.get("mod_time", DEFAULT_MOD_TIME),
                }
            elif kind == "file":
                self.entries[rel_path] = {
                    "type": "file",
                    "mod_time": entry.get("mod_time", DEFAULT_MOD_TIME),
                    "content": _decode_content(entry),
                }
                self._ensure_parent_dirs(rel_path)
            else:
                raise SystemExit(f"Unsupported fake entry type: {kind!r}")

    def to_json(self) -> dict[str, Any]:
        entries: list[dict[str, Any]] = []
        for rel_path, entry in sorted(self.entries.items()):
            record = {
                "path": rel_path,
                "type": entry["type"],
                "mod_time": entry.get("mod_time", DEFAULT_MOD_TIME),
            }
            if entry["type"] == "file":
                record["base64"] = base64.b64encode(entry["content"]).decode("ascii")
            entries.append(record)
        return {"entries": entries}

    def _clean_rel_path(self, value: str) -> str:
        return "/".join(part for part in str(value).replace("\\", "/").split("/") if part)

    def _ensure_parent_dirs(self, rel_path: str) -> None:
        parts = self._clean_rel_path(rel_path).split("/")
        for count in range(1, len(parts)):
            parent = "/".join(parts[:count])
            self.entries.setdefault(parent, {"type": "dir", "mod_time": DEFAULT_MOD_TIME})

    def list_dir(self, remote_path: str) -> list[dict[str, Any]]:
        rel_dir = self._clean_rel_path(remote_path.split(":", 1)[1] if ":" in remote_path else remote_path)
        prefix = rel_dir + "/" if rel_dir else ""
        children: dict[str, dict[str, Any]] = {}
        for rel_path, entry in self.entries.items():
            if rel_dir:
                if rel_path == rel_dir or not rel_path.startswith(prefix):
                    continue
                remainder = rel_path[len(prefix):]
            else:
                remainder = rel_path
            if not remainder:
                continue
            child_name = remainder.split("/", 1)[0]
            child_rel = child_name if not rel_dir else prefix + child_name
            child_entry = self.entries.get(child_rel)
            if child_entry is None:
                child_entry = {"type": "dir", "mod_time": DEFAULT_MOD_TIME}
            children[child_name] = {
                "Name": child_name,
                "Path": child_name,
                "IsDir": child_entry["type"] == "dir",
                "Size": 0 if child_entry["type"] == "dir" else len(child_entry["content"]),
                "ModTime": child_entry.get("mod_time", DEFAULT_MOD_TIME),
            }
        return sorted(children.values(), key=lambda item: item["Name"].casefold())

    def cat(self, remote_path: str) -> bytes:
        rel_path = self._clean_rel_path(remote_path.split(":", 1)[1] if ":" in remote_path else remote_path)
        entry = self.entries.get(rel_path)
        if entry is None or entry["type"] != "file":
            raise FileNotFoundError(remote_path)
        return entry["content"]

    def mkdir(self, remote_path: str) -> None:
        rel_path = self._clean_rel_path(remote_path.split(":", 1)[1] if ":" in remote_path else remote_path)
        if rel_path:
            self._ensure_parent_dirs(rel_path)
            self.entries[rel_path] = {"type": "dir", "mod_time": DEFAULT_MOD_TIME}

    def copyto(self, source: str, destination: str) -> None:
        dest_is_remote = _is_remote_target(destination)
        source_is_remote = _is_remote_target(source)
        if source_is_remote and not dest_is_remote:
            target = Path(destination)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.cat(source))
            return
        if dest_is_remote and not source_is_remote:
            source_path = Path(source)
            data = source_path.read_bytes()
            rel_path = self._clean_rel_path(destination.split(":", 1)[1])
            self._ensure_parent_dirs(rel_path)
            self.entries[rel_path] = {
                "type": "file",
                "content": data,
                "mod_time": DEFAULT_MOD_TIME,
            }
            return
        raise SystemExit(f"Unsupported fake copyto direction: {source!r} -> {destination!r}")


def _append_call(args: list[str]) -> None:
    call_log = os.environ.get("DROPBOX_BROWSER_FAKE_RCLONE_CALL_LOG")
    if not call_log:
        return
    path = Path(call_log)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"args": args}) + "\n")


def _load_state() -> FakeRemoteState:
    state_path = _state_path()
    if state_path.exists():
        payload = json.loads(state_path.read_text(encoding="utf-8"))
        return FakeRemoteState(payload)
    payload = json.loads(_fixture_path().read_text(encoding="utf-8"))
    state = FakeRemoteState(payload)
    _save_state(state)
    return state


def _save_state(state: FakeRemoteState) -> None:
    state_path = _state_path()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state.to_json(), indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command")
    parser.add_argument("rest", nargs="*")
    args = parser.parse_args(argv)
    command = args.command
    rest = list(args.rest)
    _append_call([command, *rest])
    state = _load_state()

    if command == "lsjson":
        target = rest[-1]
        sys.stdout.write(json.dumps(state.list_dir(target)))
        return 0

    if command == "cat":
        offset = None
        count = None
        target = ""
        index = 0
        while index < len(rest):
            part = rest[index]
            if part == "--offset":
                offset = int(rest[index + 1])
                index += 2
                continue
            if part == "--count":
                count = int(rest[index + 1])
                index += 2
                continue
            if part == "--":
                target = rest[index + 1]
                break
            index += 1
        data = state.cat(target)
        if offset is not None:
            data = data[offset:]
        if count is not None:
            data = data[:count]
        sys.stdout.buffer.write(data)
        return 0

    if command == "copyto":
        source = rest[-2]
        destination = rest[-1]
        state.copyto(source, destination)
        _save_state(state)
        return 0

    if command == "mkdir":
        state.mkdir(rest[-1])
        _save_state(state)
        return 0

    raise SystemExit(f"Unsupported fake rclone command: {command!r}")


if __name__ == "__main__":
    raise SystemExit(main())
