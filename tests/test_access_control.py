from __future__ import annotations

import unittest
from types import SimpleNamespace

from dropbox_browser.errors import BrowserError
from dropbox_browser.handlers import RequestHandler


class AccessControlTests(unittest.TestCase):
    def _build_handler(self, host: str, *, localhost_only_access: bool = True) -> RequestHandler:
        handler = RequestHandler.__new__(RequestHandler)
        handler.client_address = (host, 12345)
        handler.server = SimpleNamespace(localhost_only_access=localhost_only_access)
        return handler

    def test_loopback_client_addresses_are_allowed(self) -> None:
        for host in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"):
            handler = self._build_handler(host)
            handler._enforce_localhost_only_access()

    def test_non_loopback_client_is_rejected_when_localhost_only_enabled(self) -> None:
        handler = self._build_handler("192.168.1.25")

        with self.assertRaises(BrowserError) as ctx:
            handler._enforce_localhost_only_access()

        self.assertEqual(ctx.exception.status.value, 403)
        self.assertEqual(ctx.exception.message, "Only localhost clients may access this server.")

    def test_non_loopback_client_is_allowed_when_localhost_only_disabled(self) -> None:
        handler = self._build_handler("192.168.1.25", localhost_only_access=False)

        handler._enforce_localhost_only_access()


if __name__ == "__main__":
    unittest.main()
