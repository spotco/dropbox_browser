from __future__ import annotations

import unittest

from dropbox_browser import config as config_module


class ConfigDefaultsTests(unittest.TestCase):
    def test_default_folder_cache_ttl_is_two_weeks(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["FolderCacheTTLSeconds"], 14 * 24 * 60 * 60)

    def test_packaged_config_folder_cache_ttl_is_two_weeks(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["FolderCacheTTLSeconds"], 14 * 24 * 60 * 60)


if __name__ == "__main__":
    unittest.main()
