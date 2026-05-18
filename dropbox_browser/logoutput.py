"""Serialized terminal output thread for log line management.

All stderr writes are funnelled through a single queue consumed by one writer
thread.  This gives the thread exclusive knowledge of the terminal state,
allowing it to use ANSI cursor movement to update a pending start-line in
place when the corresponding command completes.

Non-TTY fallback: each command prints two lines (start + complete) with no
ANSI, matching the previous behaviour for piped/redirected output.
"""
from __future__ import annotations

import queue
import sys
import threading
import time

_ANSI_YELLOW = "\033[33m"
_ANSI_RED    = "\033[31m"
_ANSI_RESET  = "\033[0m"

# If a pending start-line has more than this many lines between it and the
# current cursor position, skip in-place update and print a second line
# (the start has likely scrolled off-screen).
_MAX_LOOKBACK = 50

_q: "queue.Queue[tuple]" = queue.Queue()

_id_lock = threading.Lock()
_id_counter = 0


def _next_id() -> int:
    global _id_counter
    with _id_lock:
        _id_counter += 1
        return _id_counter


def elapsed_color(elapsed: float) -> str:
    """Return ANSI color code for elapsed time, or '' if no color needed."""
    if elapsed >= 5.0:
        return _ANSI_RED
    if elapsed >= 1.0:
        return _ANSI_YELLOW
    return ""


# ---------------------------------------------------------------------------
# Public API — called from worker/request threads
# ---------------------------------------------------------------------------

def log_start(text: str) -> int:
    """Enqueue a command-start line.  Returns an id for log_complete."""
    entry_id = _next_id()
    ts = time.strftime("%H:%M:%S")
    _q.put(("start", entry_id, ts, text))
    return entry_id


def log_complete(entry_id: int, text: str, elapsed: float) -> None:
    """Enqueue a command-completion, updating the matching start line."""
    ts = time.strftime("%H:%M:%S")
    _q.put(("complete", entry_id, ts, text, elapsed))


def log_plain(ts: str, text: str) -> None:
    """Enqueue a plain log line (request logs, misc messages)."""
    _q.put(("plain", ts, text))


def start() -> None:
    """Start the writer thread.  Call once at server startup."""
    t = threading.Thread(target=_writer, daemon=True, name="log-output")
    t.start()


# ---------------------------------------------------------------------------
# Writer thread — sole writer of sys.stderr
# ---------------------------------------------------------------------------

def _writer() -> None:
    is_tty = sys.stderr.isatty()
    # Ordered record of every line printed to the terminal.
    # Each entry: {"id": int|None, "done": bool}
    # "done" is True for plain lines and completed rclone lines.
    screen_lines: list[dict] = []

    while True:
        msg = _q.get()
        kind = msg[0]

        if kind == "start":
            _, entry_id, ts, text = msg
            screen_lines.append({"id": entry_id, "done": False})
            sys.stderr.write("[%s] %s\n" % (ts, text))

        elif kind == "plain":
            _, ts, text = msg
            screen_lines.append({"id": None, "done": True})
            sys.stderr.write("[%s] %s\n" % (ts, text))

        elif kind == "complete":
            _, entry_id, ts, text, elapsed = msg
            color  = elapsed_color(elapsed) if is_tty else ""
            reset  = _ANSI_RESET if color else ""
            line   = "[%s] %s" % (ts, text)

            # Locate the matching start entry.
            idx = None
            for i, e in enumerate(screen_lines):
                if e.get("id") == entry_id:
                    idx = i
                    break

            # lines_up: how many lines above the current cursor position the
            # start line sits.  Cursor is always one line below the last print.
            lines_up = (len(screen_lines) - idx) if idx is not None else None

            if is_tty and idx is not None and lines_up <= _MAX_LOOKBACK:
                # In-place ANSI update:
                #   move up lines_up, erase line, write new content, move back.
                sys.stderr.write(
                    "\033[%dA\r\033[2K%s%s%s\033[%dB\r" % (
                        lines_up, color, line, reset, lines_up,
                    )
                )
            else:
                # Fallback: print a new line.
                screen_lines.append({"id": None, "done": True})
                sys.stderr.write("%s%s%s\n" % (color, line, reset))

            if idx is not None:
                screen_lines[idx]["done"] = True

        sys.stderr.flush()

        # Trim completed entries from the front of screen_lines.
        # Safe because removing k entries from the front decreases both
        # len(screen_lines) and each remaining idx by k, so lines_up is
        # unchanged for all still-pending entries.
        while screen_lines and screen_lines[0]["done"]:
            screen_lines.pop(0)
