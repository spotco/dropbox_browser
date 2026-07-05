from __future__ import annotations

from http import HTTPStatus
from typing import Any


class BrowserError(Exception):
    def __init__(self, status: HTTPStatus, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = dict(details or {})
