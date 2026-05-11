from __future__ import annotations

from http import HTTPStatus


class BrowserError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
