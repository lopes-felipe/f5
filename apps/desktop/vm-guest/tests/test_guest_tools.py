"""Unit tests for the guest tools. Run: python3 -B -m unittest discover apps/desktop/vm-guest/tests

They exercise the pure parts (boot line, archive filtering, install retention, resolver
discovery). Mounting, sudo, nftables and systemd scopes need a real guest and are covered by
the manual VM gate.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "rootfs", "opt", "f5", "bin")


def load_guest_tool():
    loader = importlib.machinery.SourceFileLoader("f5_guest", os.path.join(BIN, "f5-guest"))
    spec = importlib.util.spec_from_loader("f5_guest", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


guest = load_guest_tool()
GOOD_BOOT = {"port": 41000, "authToken": "a" * 48, "profileId": "0" * 32}


def read_boot(data):
    """Feeds `data` on fd 0 and returns (result or refusal, bytes left on fd 0)."""
    read_end, write_end = os.pipe()
    os.write(write_end, data)
    os.close(write_end)
    saved = os.dup(0)
    os.dup2(read_end, 0)
    os.close(read_end)
    try:
        try:
            result = guest.read_boot_line()
        except guest.Refusal as refusal:
            result = refusal
        return result, os.read(0, 1024)
    finally:
        os.dup2(saved, 0)
        os.close(saved)


class BootLineTest(unittest.TestCase):
    def test_reads_exactly_one_line_and_leaves_the_frames(self):
        frames = b"\x00\x00\x00\x02{}"
        result, rest = read_boot(json.dumps(GOOD_BOOT).encode() + b"\n" + frames)
        self.assertEqual(result, (41000, "a" * 48, "0" * 32))
        self.assertEqual(rest, frames)

    def test_refuses_malformed_lines(self):
        cases = [
            ({**GOOD_BOOT, "extra": 1}, "unexpected fields"),
            ({**GOOD_BOOT, "port": True}, "invalid port"),
            ({**GOOD_BOOT, "port": 80}, "invalid port"),
            ({**GOOD_BOOT, "authToken": "a b"}, "invalid auth token"),
            ({**GOOD_BOOT, "profileId": "../x"}, "invalid profile id"),
        ]
        for boot, message in cases:
            with self.subTest(message=message):
                result, _ = read_boot(json.dumps(boot).encode() + b"\n")
                self.assertIsInstance(result, guest.Refusal)
                self.assertIn(message, str(result))

    def test_refuses_an_unterminated_or_oversized_line(self):
        result, _ = read_boot(json.dumps(GOOD_BOOT).encode())
        self.assertIn("stdin closed", str(result))
        result, _ = read_boot(b"x" * 5000)
        self.assertIn("too long", str(result))


def archive(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/shadow"
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "/etc/shadow"
            tar.addfile(info, io.BytesIO(b""))
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r:gz")


class SafeMembersTest(unittest.TestCase):
    top = "f5-1.2.3-linux-arm64"

    def test_accepts_regular_files_under_the_top_directory(self):
        members = list(guest.safe_members(archive([(self.top, "dir"), (self.top + "/f5", "file")]), self.top))
        self.assertEqual([member.name for member in members], [self.top, self.top + "/f5"])

    def test_refuses_escapes_links_and_foreign_entries(self):
        for entries in (
            [(self.top + "/../evil", "file")],
            [("/etc/passwd", "file")],
            [("other/f5", "file")],
            [(self.top + "/link", "symlink")],
            [(self.top + "/hard", "hardlink")],
        ):
            with self.subTest(entries=entries):
                with self.assertRaises(guest.Refusal):
                    list(guest.safe_members(archive(entries), self.top))


class RetentionTest(unittest.TestCase):
    def test_keeps_the_previous_install_not_the_lexically_largest_name(self):
        with tempfile.TemporaryDirectory() as root:
            for index, version in enumerate(["1.9", "1.10", "1.11"]):
                os.makedirs(os.path.join(root, version))
                marker = os.path.join(root, version, ".installed")
                open(marker, "w").close()
                os.utime(marker, ns=(index * 10**9, index * 10**9))
            os.makedirs(os.path.join(root, ".install-tmp"))
            saved, guest.BACKEND_ROOT = guest.BACKEND_ROOT, root
            try:
                installed = guest.installed_versions()
            finally:
                guest.BACKEND_ROOT = saved
            self.assertEqual(installed, ["1.9", "1.10", "1.11"])
            self.assertEqual(guest.retired_versions(installed, "1.11"), ["1.9"])
            self.assertEqual(guest.retired_versions(["1.10"], "1.11"), [])


def discover(resolv_conf):
    """Sources f5-egress-apply and runs discover_resolvers against one resolv.conf."""
    with tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False) as handle:
        handle.write(resolv_conf)
    try:
        script = (
            'source "$1"; resolvectl() { return 1; }; RESOLV_FILES=("$2"); discover_resolvers'
        )
        return subprocess.run(
            ["bash", "-c", script, "bash", os.path.join(BIN, "f5-egress-apply"), handle.name],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    finally:
        os.unlink(handle.name)


class ResolverDiscoveryTest(unittest.TestCase):
    def test_finds_non_loopback_resolvers(self):
        self.assertEqual(
            discover("nameserver 192.168.5.2\nnameserver 127.0.0.53\nnameserver 1.1.1.1\n"),
            "1.1.1.1,192.168.5.2",
        )

    def test_reports_nothing_before_a_resolver_exists(self):
        self.assertEqual(discover("# not yet configured\nnameserver 127.0.0.53\n"), "")


if __name__ == "__main__":
    unittest.main()
