"""Unit tests for the guest tools. Run: python3 -B -m unittest discover apps/desktop/vm-guest/tests

They exercise the pure parts (boot line, archive filtering, install retention and digests,
resolver discovery, the egress ruleset). Run as root on Linux, they also check the frame
channel's pipe ownership and, with nft installed, that nftables accepts the ruleset. Mounting,
sudo, loaded nftables and systemd scopes need a real guest and are covered by the manual VM
gate.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import pwd
import shutil
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


class BackendDigestTest(unittest.TestCase):
    """A backend is identified by version and archive digest: a rebuild keeps the version."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.saved = (guest.BACKEND_ROOT, guest.root_owned)
        guest.BACKEND_ROOT = self.root
        # Ownership is checked separately; these files belong to the test user.
        guest.root_owned = lambda _path: True
        os.makedirs(os.path.join(self.root, "1.2.3"))
        open(os.path.join(self.root, "1.2.3", "f5"), "w").close()
        with open(os.path.join(self.root, "1.2.3", ".installed"), "w") as handle:
            handle.write("d" * 64 + "\n")

    def tearDown(self):
        guest.BACKEND_ROOT, guest.root_owned = self.saved
        shutil.rmtree(self.root)

    def test_reports_each_backend_with_its_digest(self):
        self.assertEqual(guest.installed_backends(), [{"version": "1.2.3", "sha256": "d" * 64}])

    def test_launches_only_the_build_with_the_expected_digest(self):
        guest.check_backend("1.2.3", "d" * 64)
        with self.assertRaisesRegex(guest.Refusal, "different archive"):
            guest.check_backend("1.2.3", "e" * 64)
        with self.assertRaisesRegex(guest.Refusal, "invalid sha256"):
            guest.check_backend("1.2.3", "D" * 64)


class GuestDirsTest(unittest.TestCase):
    """f5 can't create entries in the root-owned data root, so the launcher makes them all."""

    def test_includes_the_servers_profiles_root(self):
        # packages/shared/src/profilePaths.ts: profilesRootDir(stateDir) = `${stateDir}-profiles`.
        self.assertIn(guest.STATE_DIR + "-profiles", guest.GUEST_DIRS)
        self.assertIn(guest.STATE_DIR, guest.GUEST_DIRS)
        self.assertIn(guest.HOME, guest.GUEST_DIRS)
        for path in guest.GUEST_DIRS:
            self.assertEqual(os.path.dirname(path), guest.DATA)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "needs root on Linux")
class ChannelPipeTest(unittest.TestCase):
    """The launcher runs as root and the backend as an unprivileged user, so the backend's
    close-on-exec reopen through /proc/self/fd works only on pipes that user owns."""

    # Run by a process the backend would start: the inodes of every descriptor it inherited.
    INHERITED = (
        "import os, json\n"
        "seen = []\n"
        "for fd in range(256):\n"
        "    try: seen.append(os.fstat(fd).st_ino)\n"
        "    except OSError: pass\n"
        "print(json.dumps(seen))\n"
    )

    def reopen_as_nobody(self, read_end):
        """In a child dropped to `nobody` with the pipe on fd 3, as the backend gets it:
        reopen it, close fd 3, then start a process that keeps every inheritable descriptor.
        Returns "denied", or whether that process inherited the pipe."""
        nobody = pwd.getpwnam("nobody")
        result_read, result_write = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(result_read)
                # Out of the way of fd 3 first: either could already be 3.
                out = os.dup2(result_write, 40, inheritable=False)
                source = os.dup2(read_end, 41, inheritable=False)
                os.dup2(source, 3, inheritable=True)
                os.setgroups([])
                os.setgid(nobody.pw_gid)
                os.setuid(nobody.pw_uid)
                try:
                    private = os.open("/proc/self/fd/3", os.O_RDONLY | os.O_NONBLOCK)
                except PermissionError:
                    os.write(out, b"denied")
                    os._exit(0)
                pipe_inode = os.fstat(private).st_ino
                os.close(3)
                os.close(source)
                seen = json.loads(
                    subprocess.run(
                        [sys.executable, "-I", "-c", self.INHERITED],
                        capture_output=True,
                        text=True,
                        close_fds=False,
                        check=True,
                    ).stdout
                )
                os.write(out, json.dumps({"inherited": pipe_inode in seen}).encode())
            finally:
                os._exit(0)
        os.close(result_write)
        os.waitpid(pid, 0)
        with os.fdopen(result_read) as handle:
            return handle.read()

    def test_a_pipe_root_creates_cant_be_reopened_by_the_backend_user(self):
        read_end, write_end = os.pipe()
        try:
            self.assertEqual(self.reopen_as_nobody(read_end), "denied")
        finally:
            os.close(read_end)
            os.close(write_end)

    def test_a_channel_pipe_reopens_close_on_exec_and_nothing_started_inherits_it(self):
        nobody = pwd.getpwnam("nobody")
        read_end, write_end = guest.channel_pipe(nobody.pw_uid, nobody.pw_gid)
        try:
            self.assertEqual(json.loads(self.reopen_as_nobody(read_end)), {"inherited": False})
        finally:
            os.close(read_end)
            os.close(write_end)


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


def render(resolvers):
    return subprocess.run(
        ["bash", "-c", 'source "$1"; render_ruleset "$2"', "bash",
         os.path.join(BIN, "f5-egress-apply"), resolvers],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


class EgressRulesetTest(unittest.TestCase):
    def rules(self):
        text = render("192.168.5.3")
        start = text.index("chain output {")
        return [line.strip() for line in text[start:].splitlines()[2:] if line.strip() not in ("", "}")]

    def test_dns_goes_only_to_the_resolvers(self):
        rules = self.rules()
        allow = rules.index("ip daddr { 192.168.5.3 } meta l4proto { udp, tcp } th dport 53 accept")
        drop = rules.index("meta l4proto { udp, tcp } th dport 53 counter drop")
        private = next(i for i, rule in enumerate(rules) if "192.168.0.0/16" in rule)
        # The resolver may sit in a private range; the DNS exception comes before that drop.
        self.assertLess(allow, drop)
        self.assertLess(drop, private)

    def test_ipv6_carries_only_discovery_and_path_mtu(self):
        rules = self.rules()
        icmp = [rule for rule in rules if rule.startswith("icmpv6")]
        self.assertEqual(len(icmp), 1)
        for kind in ("echo-request", "echo-reply"):
            self.assertNotIn(kind, icmp[0])
        self.assertNotIn("meta l4proto ipv6-icmp accept", rules)
        self.assertEqual(rules[-1], "meta nfproto ipv6 counter reject with icmpx type admin-prohibited")

    @unittest.skipUnless(shutil.which("nft") and os.geteuid() == 0, "needs nft and root")
    def test_nft_accepts_the_ruleset(self):
        subprocess.run(["nft", "-c", "-f", "-"], input=render("192.168.5.3"), text=True, check=True)


if __name__ == "__main__":
    unittest.main()
