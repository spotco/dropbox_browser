from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from unittest.mock import patch

from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import DIFF_CACHE_SCHEMA_VERSION
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.rclone import RcloneClient
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until
except ImportError:
    from app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until


BETTY_YOUTUBE_5_26_2026_FILENAMES = [
    "[Alexandros] - Ash.mp3",
    "[OST ] Song of the Welkin Moon Teaser - Moonlit Ballad of the Night (Without Voice) _ Genshin Impact.mp3",
    "『ユイカ』「さんかくゲーム」 TVアニメ「ただいま、おじゃまされます！」ノンテロップED.mp3",
    "【ウマ娘】UNLIMITED IMPACT (パート分け_Color Coded_Lyrics).mp3",
    "【シナモロール】ふわふわしようよ　MV.mp3",
    "【原神】キャラクタートレーラー　スカーク（CV_能登麻美子）「荒廃の地の嘆き」.mp3",
    "Airi Suzuki & HOYO-MiX - 【鈴木愛理】原神スカーク イメージソング「Star Odyssey」MV.mp3",
    "Alichey(CV_Azusa Tachibana) - You'll Be In My Heart 〜そばに〜 - You'll Be In My Heart ~Sobani~.mp3",
    "ASH _ Alexandros _ Sword of the demon hunter opening 2 lyrics.mp3",
    "ATARAYO - 「僕は...」.mp3",
    "BACK-ON _ STRIKE BACK.mp3",
    "Blind to you _ Aimer [English subtitle].mp3",
    "CRANK UP - Ikusaburo Yamazaki [KAN_ROM_ENG] _ Twilight Out Of Focus _ Opening.mp3",
    "Crystal Sweatdrops (Extended) · Graphia Academy Gymnasium - Honkai_ Star Rail 4.0 OST.mp3",
    "Everlasting Snow - Miko.mp3",
    "Fairy Tail Ending 11 - Glitter (Instrumental).mp3",
    "Fairy tail zero ED full lyrics [Solidemo-Landscape].mp3",
    "Had I Not Seen the Sun (Vocals_ Chevy) - Honkai Star Rail Concert 2025.mp3",
    "Hilcrhyme - 千夜一夜 - One Thousand and One Nights (feat. Izumi Nakasone).mp3",
    "HOYO-MiX - Star Odyssey (Instrumental).mp3",
    "If I Can Stop One Heart From Breaking - Honkai_ Star Rail 2.0 OST.mp3",
    "Isekai Mokushiroku Mynoghra Ending Full『More Than W』by Takuma Terashima.mp3",
    "KALA - 『KINGSBLOOD』.mp3",
    "Kanon Ost- Last Regrets (Full Chorus Ver.).mp3",
    "Kitasan Black - Lost Shine (Uma Musume_ Pretty Derby Season 3 Episode 1 Ending Full).mp3",
    "Kitasan Black (CV_ Hinaki Yano), Satono Diamond (CV_ Hina Tachibana), Satono Crown (CV_ Sayumi Suzushiro), Cheval Grand (CV_ Yuko Natsuyoshi), Sounds of Earth (CV_ MAKIKO), and Duramente (CV_ Akina) - ソシテミンナノ - Be Their Beloved.mp3",
    "Koori no Jouheki (The Ramparts of Ice)「Opening」-『Toumei (Transparent)』by Novelbright.mp3",
    "L.E.I. - Enter.mp3",
    "Main Theme 【Extended Full Mix】   Our Last Crusade or the Rise of a New World OST.mp3",
    "milet「Anytime Anywhere」×「葬送のフリーレン」SPECIAL MUSIC VIDEO／フリーレンEDテーマアニメMV.mp3",
    "Niko Mikadono (CV.Aoi Koga) - One Road.mp3",
    "Oguri Cap(CV.Takayanagi Tomoyo) - ∞.mp3",
    "Our Last Crusade or the Rise of a New World - Insert Song Full『Soukyou Etranze』by Sora Amamiya.mp3",
    "Our Last Crusade Or The Rise Of A New World Epic_Character OST - Alicelies (Alice Lou Nebulis IX).mp3",
    "Proi Proi · Aquila Boss Theme (Album Version) - Honkai_ Star Rail 3.3 OST.mp3",
    "Proi Proi (Instrumental) - Honkai_ Star Rail 3.3 OST.mp3",
    "Rimu Miyake - Light of Life (from The Apothecary Diaries Season 2).mp3",
    "Robin (Chevy) - Hope Is the Thing With Feathers _ Honkai_ Star Rail.mp3",
    "Ryo Takahashi - Stronger (feat. Zachary Fitzgerald & Foggy-D).mp3",
    "Satou - パーフェクトデイ - Perfect Day.mp3",
    "Skirk Story Quest OST 5.7 - Star Odyssey Instrumental Version 【Genshin Impact EP】.mp3",
    "Skirk_ Lament of a Ruined World (feat. SOLARIA) - Remix Cover (Genshin Impact).mp3",
    "Snail's House - Imaginary Express.mp3",
    "Soala - 声の軌跡 - koe no kiseki.mp3",
    "Sumes Music - Skirk Theme Music - Lament of a Ruined World (Instrumental Cover) _ Genshin Impact.mp3",
    "The Apothecary Diaries Season 2 Insert Song FULL - Rimu Miyake『Light Of Life』EPIC VERSION.mp3",
    "The Ramparts of Ice (氷の城壁) Opening – Toumei_透明_Transparent [Instrumental] _ Novelbright (ノーベルブライト).mp3",
    "The Unaware Atelier Meister ED full.mp3",
    "tnbee - Apep Battle Theme ALL PHASES - God-Devouring Mania (tnbee mix) _ Genshin Impact.mp3",
    "tnbee - Cyrene Theme Music EXTENDED - With You Once More (tnbee mix) _ Honkai_ Star Rail.mp3",
    "Torches _ Aimer [English subtitle] (Anime Vinland Saga Ending_ED).mp3",
    "TVアニメ『帝乃三姉妹は案外、チョロい。』エンディング映像｜「One Road」帝乃二琥（CV.古賀葵）.mp3",
    "TVアニメ『貴族転生 ～恵まれた生まれから最強の力を得る～』ノンクレジットED映像│「You'll Be In My Heart 〜そばに〜」アリーチェ(CV_橘 杏咲).mp3",
    "Umapyoi Densetsu [Mirrored].mp3",
    "Uncontrollable - Xenoblade Chronicles X OST.mp3",
    "Undead Unluck - Ending FULL know me... by Kairi Yagi (Lyrics).mp3",
    "Yorushika - Algernon (アルジャーノン) (Lyrics_Kan_Rom_Eng).mp3",
    "Yoshihisa Kato - Q.E.D..mp3",
    "Yoshihisa Kato - お父さんの、本…！ - Oto san no Hon...!.mp3",
    "Yoshihisa Kato - 一歩、踏み出す - Ippo fumi dasu.mp3",
    "Yoshihisa Kato - 沈黙の魔女 - Chinmoku no Majo.mp3",
    "Yuika - Triangle Game.mp3",
    "Yuika - さんかくゲーム - Triangle Game.mp3",
    "Zero Ichi 01 [HD] - Undead Unluck アンデッドアンラック Lyrics _ Queen Bee 女王蜂.mp3",
    "ゲーム【ウマ娘 プリティーダービー】ライブ動画「UNLIMITED IMPACT」ゲームサイズVer..mp3",
    "ヨルシカ「晴る」×「葬送のフリーレン」SPECIAL MUSIC VIDEO／フリーレンOPテーマアニメMV.mp3",
]



class SyncRouteTests(AppTestCase):
    def _batch_plan(self, server: TestServer, fields: dict[str, str]) -> dict[str, Any]:
        payload = server.post_json("/sync-batch-plan", fields)
        return wait_until(
            lambda: server.get_json("/sync-status?id=" + payload["id"])
            if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
            else None,
            description="batch plan completion",
        )

    def _submit_batch_from_plan(self, server: TestServer, fields: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
        plan_status = self._batch_plan(server, fields)
        self.assertEqual(plan_status["status"], "complete")
        run_fields = dict(fields)
        run_fields["plan_token"] = plan_status["plan_token"]
        payload = server.post_json("/sync-batch", run_fields)
        return payload, plan_status["plan"]

    def test_sync_post_requires_enabled_guard(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=local.txt&kind=file&direction=local_to_dropbox&enable_write_dropbox=0"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sync_post_requires_direction_specific_enabled_guard(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=remote.txt&kind=file&direction=dropbox_to_local&enable_to_local=0&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sync_post_rejects_folder_kind(self) -> None:
        local_root = self.create_local_root({
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=folder&kind=folder&direction=local_to_dropbox&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_sync_local_only_file_copies_local_to_dropbox(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "local.txt",
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(rclone.cat_data["dropbox:local.txt"], b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == "dropbox:local.txt" for call in rclone.calls))

    def test_sync_unicode_local_file_routes_upload_with_rcat(self) -> None:
        local_name = "0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3"
        local_root = self.create_local_root({
            local_name: b"local",
        })
        commands: list[list[str]] = []

        class RecordingProcess:
            def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
                self.cmd = cmd
                self.returncode = 0
                commands.append(cmd)

            def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
                return b"", b""

        rclone = RcloneClient("rclone.exe", None, log_commands=False)
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingProcess),
            TestServer(app) as server,
        ):
            payload = server.post_json("/sync", {
                "path": local_name,
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="unicode local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            commands[0],
            [
                "rclone.exe",
                "rcat",
                "--size",
                "5",
                "--",
                "dropbox:" + local_name,
            ],
        )

    def test_sync_unicode_local_file_routes_upload_with_fullwidth_slash_uses_rcat(self) -> None:
        local_name = "TVアニメ『帝乃三姉妹は案外、チョロい。』エンディング映像｜「One Road」帝乃二琥（CV.古賀葵）.mp3"
        rel_path = "dropbox_browser/betty_youtube_5_26_2026/" + local_name
        local_root = self.create_local_root({
            rel_path: b"local",
        })
        commands: list[list[str]] = []

        class RecordingProcess:
            def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
                self.cmd = cmd
                self.returncode = 0
                commands.append(cmd)

            def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
                return b"", b""

        rclone = RcloneClient("rclone.exe", None, log_commands=False)
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingProcess),
            TestServer(app) as server,
        ):
            payload = server.post_json("/sync", {
                "path": rel_path,
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="fullwidth pipe local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            commands[0],
            [
                "rclone.exe",
                "rcat",
                "--size",
                "5",
                "--",
                "dropbox:" + rel_path,
            ],
        )

    def test_sync_rclone_escaped_local_only_file_targets_decoded_dropbox_name(self) -> None:
        local_name = "0287 - U.N.オーエンは彼女なのか‛？(TO-HOlic mix) - Copy.mp3"
        dropbox_name = "0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix) - Copy.mp3"
        local_root = self.create_local_root({
            "dropbox_browser/" + local_name: b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:dropbox_browser": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "dropbox_browser/" + local_name,
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="escaped local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(rclone.cat_data["dropbox:dropbox_browser/" + dropbox_name], b"local")
        self.assertNotIn("dropbox:dropbox_browser/" + local_name, rclone.cat_data)

    def test_sync_rclone_escaped_local_only_file_uploads_with_decoded_dropbox_target(self) -> None:
        local_name = "0287 - U.N.オーエンは彼女なのか‛？(TO-HOlic mix) - Copy.mp3"
        dropbox_name = "0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix) - Copy.mp3"
        local_root = self.create_local_root({
            "dropbox_browser/" + local_name: b"local",
        })
        commands: list[list[str]] = []

        class RecordingProcess:
            def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
                self.cmd = cmd
                self.returncode = 0
                commands.append(cmd)

            def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
                return b"", b""

        rclone = RcloneClient("rclone.exe", None, log_commands=False)
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingProcess),
            TestServer(app) as server,
        ):
            payload = server.post_json("/sync", {
                "path": "dropbox_browser/" + dropbox_name,
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="escaped local-to-dropbox rclone command completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            commands[0],
            [
                "rclone.exe",
                "rcat",
                "--size",
                "5",
                "--",
                "dropbox:dropbox_browser/" + dropbox_name,
            ],
        )

    def test_sync_uploads_every_betty_youtube_file_with_rcat(self) -> None:
        folder = "dropbox_browser/betty_youtube_5_26_2026"
        local_root = self.create_local_root({
            f"{folder}/{name}": b"x"
            for name in BETTY_YOUTUBE_5_26_2026_FILENAMES
        })
        commands: list[list[str]] = []

        class RecordingProcess:
            def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
                self.cmd = cmd
                self.returncode = 0
                commands.append(cmd)

            def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
                return b"", b""

        rclone = RcloneClient("rclone.exe", None, log_commands=False)
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingProcess),
            TestServer(app) as server,
        ):
            for name in BETTY_YOUTUBE_5_26_2026_FILENAMES:
                payload = server.post_json("/sync", {
                    "path": folder + "/" + name,
                    "kind": "file",
                    "direction": "local_to_dropbox",
                    "enable_write_dropbox": "1",
                })
                result = wait_until(
                    lambda: server.get_json("/sync-status?id=" + payload["id"])
                    if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                    else None,
                    description=f"betty youtube upload completion for {name}",
                )
                self.assertEqual(result["status"], "complete")

        self.assertEqual(len(commands), len(BETTY_YOUTUBE_5_26_2026_FILENAMES))
        self.assertEqual(
            {tuple(cmd) for cmd in commands},
            {
                (
                    "rclone.exe",
                    "rcat",
                    "--size",
                    "1",
                    "--",
                    "dropbox:" + folder + "/" + name,
                )
                for name in BETTY_YOUTUBE_5_26_2026_FILENAMES
            },
        )

    def test_batch_plan_decodes_rclone_escaped_local_only_dropbox_targets(self) -> None:
        local_root = self.create_local_root({
            "dropbox_browser/今日は晴れ‛？.txt": b"question",
            "dropbox_browser/價格‛＜税込‛＞.txt": b"brackets",
            "dropbox_browser/星‛＊月‛｜雪.txt": b"symbols",
        })
        rclone = SimulatedRclone({
            "dropbox:dropbox_browser": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        plan = app.plan_batch_sync("dropbox_browser", "local_to_dropbox_all", recursive=False)
        targets = {item["remote_path"] for item in plan["groups"]["local_to_dropbox"]}

        self.assertEqual(
            targets,
            {
                "dropbox:dropbox_browser/今日は晴れ？.txt",
                "dropbox:dropbox_browser/星＊月｜雪.txt",
                "dropbox:dropbox_browser/價格＜税込＞.txt",
            },
        )
        self.assertEqual(
            {Path(item["local_path"]).name for item in plan["groups"]["local_to_dropbox"]},
            {
                "今日は晴れ‛？.txt",
                "星‛＊月‛｜雪.txt",
                "價格‛＜税込‛＞.txt",
            },
        )

    def test_sync_dropbox_only_file_copies_dropbox_to_local(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "remote.txt",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="dropbox-to-local sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))

    def test_sync_dropbox_only_nested_file_does_not_copy_to_partial_ancestor_path(self) -> None:
        local_root = self.create_local_root({
            "conan/Season Pack": b"misplaced episode bytes",
        })
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        bad_partial = local_root / "conan" / "Season Pack"
        self.assertEqual(result["status"], "error")
        self.assertEqual(bad_partial.read_bytes(), b"misplaced episode bytes")
        self.assertFalse(expected.exists())
        self.assertFalse(any(
            call["args"][0] == "copyto" and call["target"] == str(bad_partial)
            for call in rclone.calls
        ))

    def test_sync_dropbox_only_nested_file_uses_full_safe_destination_path(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        self.assertEqual(result["status"], "complete")
        self.assertEqual(expected.read_bytes(), b"episode")
        self.assertTrue(any(
            call["args"][0] == "copyto" and call["target"] == str(expected)
            for call in rclone.calls
        ))

    def test_batch_plan_lists_current_folder_files_by_action(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "changed.txt": b"local",
            "synced.txt": b"synced",
            "child/local-child.txt": b"child",
            ".DS_Store": b"ignored",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 99, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
                remote_dir_item("child"),
            ])],
            "dropbox:child": [SimulatedLsjsonResponse(items=[
                {"Name": "remote-child.txt", "Path": "child/remote-child.txt", "IsDir": False, "Size": 7, "ModTime": "2024-01-01T12:00:00Z"},
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            nonrecursive = self._batch_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })["plan"]
            recursive = self._batch_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })["plan"]
            copy_to_local = self._batch_plan(server, {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })["plan"]
            copy_to_local_recursive = self._batch_plan(server, {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })["plan"]

        self.assertEqual([item["path"] for item in nonrecursive["groups"]["local_to_dropbox"]], ["changed.txt", "local.txt"])
        self.assertEqual([item["size"] for item in nonrecursive["groups"]["local_to_dropbox"]], [5, 5])
        self.assertEqual([item["path"] for item in recursive["groups"]["local_to_dropbox"]], ["child/local-child.txt", "changed.txt", "local.txt"])
        self.assertEqual([item["path"] for item in copy_to_local["groups"]["dropbox_to_local"]], ["remote.txt"])
        self.assertEqual([item["size"] for item in copy_to_local["groups"]["dropbox_to_local"]], [6])
        self.assertEqual([item["path"] for item in copy_to_local_recursive["groups"]["dropbox_to_local"]], ["child/remote-child.txt", "remote.txt"])
        self.assertNotIn(".DS_Store", str(nonrecursive))

    def test_sync_batch_plan_rejects_unsupported_action(self) -> None:
        local_root = self.create_local_root({"local.txt": b"local"})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/sync-batch-plan",
                data=b"action=unsupported_batch_action&recursive=0&enable_to_local=1",
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_local_only_delete_bat_download_lists_each_file_without_deleting(self) -> None:
        local_root = self.create_local_root({
            "root-local.txt": b"local",
            "percent%file.txt": b"percent",
            "local-folder/nested.txt": b"nested",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
            "dropbox:local-folder": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/local-only-delete-bat",
                data=b"recursive=1&enable_to_local=1",
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read().decode("utf-8-sig")
                count = response.headers["X-Local-Only-File-Count"]
                disposition = response.headers["Content-Disposition"]

        self.assertEqual(count, "3")
        self.assertIn('attachment; filename="delete-local-only-root.bat"', disposition)
        self.assertIn("@echo off", body)
        self.assertIn("setlocal DisableDelayedExpansion", body)
        self.assertIn("Are you sure you want to delete 3 file(s)? Enter y to continue:", body)
        self.assertIn('if /i not "%CONFIRM%"=="y" exit /b 0', body)
        self.assertEqual(body.count("\r\ndel /f /q "), 3)
        self.assertIn('percent%%file.txt"', body)
        self.assertIn('root-local.txt"', body)
        self.assertIn('nested.txt"', body)
        self.assertNotIn("synced.txt", body)
        self.assertTrue((local_root / "root-local.txt").exists())
        self.assertTrue((local_root / "local-folder" / "nested.txt").exists())

    def test_local_only_delete_bat_nonrecursive_skips_child_folder_files(self) -> None:
        local_root = self.create_local_root({
            "root-local.txt": b"local",
            "local-folder/nested.txt": b"nested",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
            "dropbox:local-folder": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/local-only-delete-bat",
                data=b"recursive=0&enable_to_local=1",
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read().decode("utf-8-sig")
                count = response.headers["X-Local-Only-File-Count"]

        self.assertEqual(count, "1")
        self.assertIn('root-local.txt"', body)
        self.assertNotIn("nested.txt", body)

    def test_batch_plan_progress_is_visible_while_planning(self) -> None:
        local_root = self.create_local_root({})
        release = threading.Event()
        started = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started)],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            wait_until(started.is_set, description="batch planning lsjson start")
            running = server.get_json("/sync-status?id=" + payload["id"])
            release.set()
            complete = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="visible planning completion",
            )

        self.assertEqual(running["status"], "running")
        self.assertEqual(running["message"], "Batch planning")
        self.assertIn("rclone lsjson -- dropbox:", running["command"])
        self.assertEqual(running["current"], 1)
        self.assertEqual(running["total"], 1)
        self.assertEqual(complete["status"], "complete")
        self.assertIn("plan_token", complete)

    def test_sync_batch_consumes_preview_plan_without_recomputing(self) -> None:
        local_root = self.create_local_root({"local.txt": b"local"})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload, plan = self._submit_batch_from_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="one-plan batch completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["local_to_dropbox"]], ["local.txt"])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(sum(1 for call in rclone.calls if call["args"][0] == "lsjson" and call["target"] == "dropbox:"), 1)
        self.assertEqual(rclone.cat_data["dropbox:local.txt"], b"local")

    def test_sync_batch_rejects_mismatched_plan_token(self) -> None:
        local_root = self.create_local_root({"local.txt": b"local"})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan_status = self._batch_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            request = Request(
                server.base_url + "/sync-batch",
                data=(
                    "action=local_to_dropbox_all&recursive=1&enable_write_dropbox=1&plan_token="
                    + plan_status["plan_token"]
                ).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_sync_batch_rejects_expired_plan_token(self) -> None:
        local_root = self.create_local_root({"local.txt": b"local"})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan_status = self._batch_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            app.BATCH_PLAN_TTL_SECONDS = -1
            request = Request(
                server.base_url + "/sync-batch",
                data=(
                    "action=local_to_dropbox_all&recursive=0&enable_write_dropbox=1&plan_token="
                    + plan_status["plan_token"]
                ).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_recursive_batch_plan_uses_sync_worker_concurrency(self) -> None:
        local_root = self.create_local_root({})
        release = threading.Event()
        started_a = threading.Event()
        started_b = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ]), SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ])],
            "dropbox:a": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_a),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:b": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_b),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        plan_holder: dict[str, Any] = {}

        def run_plan() -> None:
            plan_holder["plan"] = app.plan_batch_sync("", "dropbox_only_to_local_all", recursive=True)

        thread = threading.Thread(target=run_plan)
        thread.start()
        try:
            wait_until(started_a.is_set, description="first child planning listing")
            wait_until(started_b.is_set, description="second child planning listing")
        finally:
            release.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(
            [item["path"] for item in plan_holder["plan"]["groups"]["dropbox_dir_to_local"]],
            ["a", "b"],
        )

    def test_recursive_batch_plans_skip_confirmed_synced_subtrees(self) -> None:
        local_root = self.create_local_root({
            "synced/track.txt": b"same",
            "local-root.txt": b"local",
        })

        class SyncedFolderCache:
            def get(self, remote_path: str) -> dict[str, Any] | None:
                if remote_path == "dropbox:synced":
                    return {
                        "complete": True,
                        "diff_complete": True,
                        "diff_status": "synced",
                    }
                return None

        root_items = [
            remote_dir_item("synced"),
            remote_dir_item("remote-only"),
            {"Name": "remote-root.txt", "Path": "remote-root.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
        ]
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=root_items),
                SimulatedLsjsonResponse(items=root_items),
            ],
            "dropbox:remote-only": [
                SimulatedLsjsonResponse(items=[
                    {"Name": "remote-child.txt", "Path": "remote-only/remote-child.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                ]),
                SimulatedLsjsonResponse(items=[
                    {"Name": "remote-child.txt", "Path": "remote-only/remote-child.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                ]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        app.folder_cache = SyncedFolderCache()

        copy_to_local = app.plan_batch_sync("", "dropbox_only_to_local_all", recursive=True)
        sync_to_dropbox = app.plan_batch_sync("", "local_to_dropbox_all", recursive=True)

        self.assertEqual(
            [item["path"] for item in copy_to_local["groups"]["dropbox_dir_to_local"]],
            ["remote-only"],
        )
        self.assertEqual(
            [item["path"] for item in copy_to_local["groups"]["dropbox_to_local"]],
            ["remote-only/remote-child.txt", "remote-root.txt"],
        )
        self.assertEqual(
            [item["path"] for item in sync_to_dropbox["groups"]["local_to_dropbox"]],
            ["local-root.txt"],
        )
        self.assertFalse(any(call["target"] == "dropbox:synced" for call in rclone.calls))

    def test_batch_copy_dropbox_only_to_local_runs_per_file(self) -> None:
        local_root = self.create_local_root({
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        }, cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload, _plan = self._submit_batch_from_plan(server, {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch copy to local completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["message"], "Batch sync complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertEqual((local_root / "changed.txt").read_bytes(), b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))
        self.assertFalse(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "changed.txt") for call in rclone.calls))

    def test_recursive_batch_copy_dropbox_only_to_local_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("empty-remote"),
            ])],
            "dropbox:empty-remote": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload, plan = self._submit_batch_from_plan(server, {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty remote folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["dropbox_dir_to_local"]], ["empty-remote"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue((local_root / "empty-remote").is_dir())

    def test_recursive_batch_copy_local_to_dropbox_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({
            "empty-local": None,
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
            "dropbox:empty-local": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload, plan = self._submit_batch_from_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty local folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["local_dir_to_dropbox"]], ["empty-local"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue(any(call["args"][0] == "mkdir" and call["target"] == "dropbox:empty-local" for call in rclone.calls))

    def test_recursive_batch_copy_local_to_dropbox_deduplicates_mkdir_ancestors(self) -> None:
        local_root = self.create_local_root({
            "a/b/c": None,
            "a/b/d": None,
            "a/e": None,
        })
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b/c": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b/d": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/e": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=4)

        with TestServer(app) as server:
            payload, plan = self._submit_batch_from_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="deduplicated mkdir batch completion",
            )

        mkdir_targets = [
            call["target"]
            for call in rclone.calls
            if call["args"][0] == "mkdir"
        ]
        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            [item["path"] for item in plan["groups"]["local_dir_to_dropbox"]],
            ["a/b/c", "a/b/d", "a/b", "a/e", "a"],
        )
        self.assertEqual(
            sorted(mkdir_targets, key=str.casefold),
            sorted({
                "dropbox:a",
                "dropbox:a/b",
                "dropbox:a/b/c",
                "dropbox:a/b/d",
                "dropbox:a/e",
            }, key=str.casefold),
        )

    def test_recursive_local_to_dropbox_sync_invalidates_parent_listing_cache_for_new_folders(self) -> None:
        local_root = self.create_local_root({
            "local-folder/file.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[remote_dir_item("local-folder")]),
            ],
            "dropbox:local-folder": [
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        assert app.listing_cache is not None
        app.listing_cache.set("dropbox:", [])

        with TestServer(app) as server:
            payload, _plan = self._submit_batch_from_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="recursive local-to-dropbox sync completion",
            )
            listing = self._browse_listing(server)

        self.assertEqual(result["status"], "complete")
        folder_row = next(row for row in listing["rows"] if row["display_name"] == "local-folder")
        self.assertNotEqual(folder_row["status_label"], "Local Only")
        self.assertGreaterEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:"), 2)

    def test_batch_sync_continues_after_file_error_and_reports_it(self) -> None:
        local_root = self.create_local_root({
            "bad.txt": b"bad",
            "good.txt": b"good",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        original_copy = rclone.copy_file_overwrite

        def flaky_copy(source: str | Path, destination: str | Path, size_bytes: int | None = None) -> None:
            if str(destination) == "dropbox:bad.txt":
                raise BrowserError(HTTPStatus.BAD_GATEWAY, "planned failure")
            original_copy(source, destination, size_bytes=size_bytes)

        rclone.copy_file_overwrite = flaky_copy  # type: ignore[method-assign]
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload, _plan = self._submit_batch_from_plan(server, {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch failure completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertIn("1 error", result["message"])
        self.assertEqual(rclone.cat_data["dropbox:good.txt"], b"good")
        self.assertTrue(any("bad.txt" in error for error in result["errors"]))
