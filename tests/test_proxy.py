"""Offline regression tests: mocked daemon, real clients, recording HTTP/SOCKS proxies."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable
HOST = "proxy-audit.invalid"


def executable(path, content):
    path.write_text(content)
    path.chmod(0o755)


class ShellFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ts tests ")
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.home = self.directory / "home"
        (self.home / ".ssh").mkdir(parents=True)
        self.config = self.directory / "config" / "ts"
        self.config.mkdir(parents=True)
        self.legacy = self.config / "ssh_config"
        self.legacy.write_text("# active shell config: do not rewrite\n")
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.nc_log = self.directory / "nc.jsonl"
        executable(self.bin / "nc", f"#!{PYTHON}\nimport json,os,sys\nwith open(os.environ['NC_LOG'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nsys.exit(1 if '-G1' in sys.argv or sys.argv[-1] == os.environ.get('FAIL_PORT') else 0)\n")
        executable(self.bin / "tailscale", "#!/bin/sh\ncase \"$1\" in\n status) echo '{}';;\n ip) [ \"${2:-}\" = audit-tail ] && echo 100.101.102.103;;\n *) exit 1;;\nesac\n")
        self.shell = self.directory / "capture-shell"
        executable(self.shell, f"#!{PYTHON}\nimport os,json\nprint(json.dumps(dict(os.environ)))\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("TS_") and k.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
        self.env.update(HOME=str(self.home), XDG_CONFIG_HOME=str(self.directory / "config"), SHELL=str(self.shell), PATH=str(self.bin) + os.pathsep + self.env["PATH"], NC_LOG=str(self.nc_log), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

    def run_command(self, args, env=None, expected=0, timeout=25):
        result = subprocess.run(args, env=env or self.env, capture_output=True, text=True, timeout=timeout)
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def enter(self, **overrides):
        env = self.env | overrides
        return json.loads(self.run_command(["zsh", str(ROOT / "ts")], env).stdout)

    def ssh_options(self, env, target, *args):
        result = self.run_command([str(ROOT / "ts.d/ssh"), "-G", *args, target], env | {"SHELL": "/bin/sh"})
        return dict(line.split(" ", 1) for line in result.stdout.splitlines() if " " in line)


class ShellTests(ShellFixture):
    def test_proxy_exports_and_exclusion_merge(self):
        env = self.enter(NO_PROXY="existing.internal, localhost", no_proxy="lower.internal,existing.internal", TS_HTTP_PORT="2345")
        self.assertEqual(env["HTTP_PROXY"], "http://127.0.0.1:2345")
        self.assertEqual(env["HTTPS_PROXY"], env["http_proxy"])
        self.assertEqual(env["ALL_PROXY"], env["HTTP_PROXY"])
        self.assertEqual(env["ALL_PROXY"], env["all_proxy"])
        self.assertEqual(env["NODE_USE_ENV_PROXY"], "1")
        self.assertEqual(env["NO_PROXY"], "localhost,127.0.0.1,::1,existing.internal,lower.internal")
        self.assertEqual(env["NO_PROXY"], env["no_proxy"])
        self.assertTrue(env["PATH"].startswith(str(ROOT / "ts.d") + ":"))

    def test_ipv6_proxy_url(self):
        self.assertEqual(self.enter(TS_SOCKS_HOST="::1")["HTTP_PROXY"], "http://[::1]:1055")
        self.assertEqual(self.enter(TS_SOCKS_HOST="[::1]")["ALL_PROXY"], "http://[::1]:1055")

    def test_socks_opt_in_and_legacy_override(self):
        self.assertEqual(self.enter(TS_ALL_PROXY_SCHEME="socks5h")["ALL_PROXY"], "socks5h://127.0.0.1:1055")
        self.assertEqual(self.enter(TS_SOCKS_SCHEME="socks5")["ALL_PROXY"], "socks5://127.0.0.1:1055")
        self.assertEqual(self.enter(TS_SOCKS_SCHEME="socks5h", TS_ALL_PROXY_SCHEME="http")["ALL_PROXY"], "http://127.0.0.1:1055")
        self.run_command(["zsh", str(ROOT / "ts")], self.env | {"TS_ALL_PROXY_SCHEME": "invalid"}, expected=2)

    def test_preflight_checks_both_endpoints_portably(self):
        self.enter(TS_HTTP_PORT="2345")
        calls = [json.loads(line) for line in self.nc_log.read_text().splitlines()]
        self.assertEqual(calls, [["-z", "-w", "2", "127.0.0.1", "1055"], ["-z", "-w", "2", "127.0.0.1", "2345"]])
        self.run_command(["zsh", str(ROOT / "ts")], self.env | {"TS_HTTP_PORT": "2345", "FAIL_PORT": "2345"}, expected=1)
        self.run_command(["zsh", str(ROOT / "ts"), "status"], self.env | {"FAIL_PORT": "1055"}, expected=1)

    def test_nested_shell_and_stale_wrapper_recovery(self):
        first = self.enter(NO_PROXY="keep.internal")
        second = json.loads(self.run_command(["zsh", str(ROOT / "ts")], first).stdout)
        self.assertEqual(first["NO_PROXY"], second["NO_PROXY"])
        for key in ["TS_SSH_REAL", "TS_SCP_REAL", "TS_SFTP_REAL", "TS_PING_REAL"]:
            self.assertEqual(first[key], second[key])
            self.assertNotIn(str(ROOT / "ts.d"), second[key])
        stale = second | {"TS_SSH_REAL": str(ROOT / "ts.d/ssh")}
        self.assertEqual(self.ssh_options(stale, "audit-public.invalid")["hostname"], "audit-public.invalid")
        recovered = json.loads(self.run_command(["zsh", str(ROOT / "ts")], stale).stdout)
        self.assertEqual(recovered["TS_SSH_REAL"], first["TS_SSH_REAL"])

    def test_legacy_config_untouched_and_new_config_private(self):
        env = self.enter()
        self.assertEqual(self.legacy.read_text(), "# active shell config: do not rewrite\n")
        generated = Path(env["TS_SSH_CONFIG"])
        self.assertNotEqual(generated, self.legacy)
        self.assertEqual(generated.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.config.glob("ssh_config.v2.*")), [])
        self.assertIn("Include /etc/ssh/ssh_config", generated.read_text())

    def test_public_settings_aliases_and_user_overrides(self):
        (self.home / ".ssh/config").write_text("ServerAliveInterval 37\nHost audit-alias\n HostName audit-tail\n User audituser\nHost audit-override\n HostName audit-tail\n ProxyCommand echo custom\n BatchMode no\n")
        env = self.enter()
        public = self.ssh_options(env, "audit-public.invalid")
        self.assertEqual(public["serveraliveinterval"], "37")
        self.assertNotIn("proxycommand", public)
        alias = self.ssh_options(env, "audit-alias")
        self.assertEqual(alias["hostname"], "audit-tail")
        self.assertEqual(alias["user"], "audituser")
        self.assertEqual(alias["proxycommand"], "tailscale nc %h %p")
        self.assertEqual(alias["batchmode"], "yes")
        self.assertEqual(self.ssh_options(env, "100.101.102.103")["proxycommand"], "tailscale nc %h %p")
        override = self.ssh_options(env, "audit-override")
        self.assertEqual(override["proxycommand"], "echo custom")
        self.assertEqual(override["batchmode"], "no")
        self.assertEqual(self.ssh_options(env, "audit-alias", "-o", "BatchMode=no")["batchmode"], "no")

    def test_explicit_ssh_config_override(self):
        custom = self.directory / "custom ssh config"
        custom.write_text("Host *\n User explicit\n")
        env = self.enter()
        options = self.ssh_options(env, "audit-tail", "-F", str(custom))
        self.assertEqual(options["user"], "explicit")
        self.assertNotIn("proxycommand", options)

    def test_scp_sftp_forward_config_to_absolute_ssh(self):
        env = self.enter()
        log = self.directory / "ssh-args.jsonl"
        capture = self.directory / "capture-ssh"
        executable(capture, f"#!{PYTHON}\nimport json,sys\nwith open({str(log)!r},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nsys.exit(1)\n")
        for app in ["scp", "sftp"]:
            for custom in [None, str(self.directory / "custom config")]:
                with self.subTest(app=app, custom=custom):
                    if log.exists():
                        log.unlink()
                    args = [str(ROOT / "ts.d" / app), "-S", str(capture)]
                    if custom:
                        Path(custom).write_text("Host *\n")
                        args += ["-F", custom]
                    args += ["audit-alias:/nonexistent", str(self.directory / "download")] if app == "scp" else ["audit-alias"]
                    self.run_command(args, env, expected=None)
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    self.assertTrue(calls)
                    # OpenSSH accepts the last -F; scp/sftp preserve both in order.
                    configs = [[call[i + 1] for i, arg in enumerate(call[:-1]) if arg == "-F"] for call in calls]
                    self.assertTrue(any(values and values[-1] == (custom or env["TS_SSH_CONFIG"]) for values in configs), calls)

    def test_public_ping_recovers_from_stale_wrapper(self):
        executable(self.bin / "ping", "#!/bin/sh\nprintf 'direct ping: %s\\n' \"$*\"\n")
        env = self.enter() | {"TS_PING_REAL": str(ROOT / "ts.d/ping")}
        result = self.run_command([str(ROOT / "ts.d/ping"), "audit-public.invalid"], env)
        self.assertIn("direct ping: audit-public.invalid", result.stdout)

    def test_installer_preserves_link_on_failed_update(self):
        install = self.directory / "installation"
        install.mkdir()
        (install / ".git").mkdir()
        shutil.copy2(ROOT / "ts", install / "ts")
        shutil.copytree(ROOT / "ts.d", install / "ts.d")
        bindir = self.directory / "local bin"
        bindir.mkdir()
        link = bindir / "ts"
        link.symlink_to(self.shell)
        executable(self.bin / "git", "#!/bin/sh\nexit \"${MOCK_GIT_STATUS:-0}\"\n")
        env = self.env | {"TS_INSTALL_DIR": str(install), "TS_BIN_DIR": str(bindir)}
        self.run_command(["sh", str(ROOT / "install.sh")], env | {"MOCK_GIT_STATUS": "1"}, expected=1)
        self.assertEqual(link.readlink(), self.shell)
        self.run_command(["sh", str(ROOT / "install.sh")], env)
        self.assertEqual(link.readlink(), install / "ts")
        self.assertEqual(list(bindir.glob(".ts-link.*")), [])

    def test_doctor_local_and_failure_exit(self):
        result = self.run_command(["zsh", str(ROOT / "ts"), "doctor", "--local"])
        self.assertIn("no protocol, DNS, or egress verification", result.stdout)
        self.run_command(["zsh", str(ROOT / "ts"), "doctor", "--local"], self.env | {"FAIL_PORT": "1055"}, expected=1)
        self.run_command(["zsh", str(ROOT / "ts"), "doctor"], self.env | {"TS_DOCTOR_URL": "http://insecure.invalid"}, expected=2)


def receive(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise EOFError("client disconnected")
        data += chunk
    return data


def tls_response(sock, context):
    with context.wrap_socket(sock, server_side=True) as tls:
        tls.settimeout(5)
        data = b""
        while b"\r\n\r\n" not in data:
            data += receive(tls, 1)
        body = b"203.0.113.7"
        tls.sendall(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)


class RecordingHTTP(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.hits.append(("GET", self.path))
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
            self.end_headers()
        else:
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    def do_CONNECT(self):
        self.server.hits.append(("CONNECT", self.path))
        self.send_response(200)
        self.end_headers()
        tls_response(self.connection, self.server.context)
        self.close_connection = True


class RecordingSOCKS(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        sock.settimeout(5)
        version, count = receive(sock, 2)
        assert version == 5
        receive(sock, count)
        if getattr(self.server, "reject", False):
            sock.sendall(b"\x05\xff")
            return
        sock.sendall(b"\x05\x00")
        version, command, reserved, address_type = receive(sock, 4)
        assert (version, command, reserved, address_type) == (5, 1, 0, 3), "must use proxy-side DNS"
        host = receive(sock, receive(sock, 1)[0]).decode()
        port = int.from_bytes(receive(sock, 2), "big")
        self.server.hits.append(("SOCKS", host, port))
        sock.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
        tls_response(sock, self.server.context)


class ClientTests(ShellFixture):
    @classmethod
    def setUpClass(cls):
        cls.cert_tmp = tempfile.TemporaryDirectory(prefix="ts certificates ")
        cls.addClassCleanup(cls.cert_tmp.cleanup)
        cert = Path(cls.cert_tmp.name) / "cert.pem"
        key = Path(cls.cert_tmp.name) / "key.pem"
        config = Path(cls.cert_tmp.name) / "openssl.cnf"
        config.write_text(f"[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = extensions\n[dn]\nCN = {HOST}\n[extensions]\nsubjectAltName = DNS:{HOST}\n")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(key), "-out", str(cert), "-config", str(config)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.cert = str(cert)
        cls.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.context.load_cert_chain(cert, key)

    def setUp(self):
        super().setUp()
        self.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RecordingHTTP)
        self.socks = socketserver.ThreadingTCPServer(("127.0.0.1", 0), RecordingSOCKS)
        self.socks.daemon_threads = True
        for server in [self.http, self.socks]:
            server.hits = []
            server.context = self.context
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        self.client_env = self.enter(TS_HTTP_PORT=str(self.http.server_port), TS_SOCKS_PORT=str(self.socks.server_address[1]))
        self.client_env.update(CURL_CA_BUNDLE=self.cert, SSL_CERT_FILE=self.cert, NODE_EXTRA_CA_CERTS=self.cert, REQUESTS_CA_BUNDLE=self.cert)

    def assert_proxy(self, args, protocol="GET", env=None, timeout=25):
        self.http.hits.clear()
        self.run_command(args, env or self.client_env, timeout=timeout)
        self.assertTrue(any(hit[0] == protocol and HOST in hit[1] for hit in self.http.hits), self.http.hits)

    def test_curl_http_https_and_socks_remote_dns(self):
        self.assert_proxy(["curl", "-q", "-fsS", "--max-time", "5", f"http://{HOST}/resource"])
        self.assert_proxy(["curl", "-q", "-fsS", "--max-time", "5", f"https://{HOST}/resource"], "CONNECT")
        self.run_command(["curl", "-q", "-fsS", "--max-time", "5", "--proxy", f"socks5h://127.0.0.1:{self.socks.server_address[1]}", f"https://{HOST}/"] , self.client_env)
        self.assertIn(("SOCKS", HOST, 443), self.socks.hits)

    def test_python_urllib_http_and_https(self):
        for scheme in ["http", "https"]:
            self.assert_proxy([PYTHON, "-c", f"import urllib.request;print(urllib.request.urlopen('{scheme}://{HOST}/',timeout=5).read())"], "CONNECT" if scheme == "https" else "GET")

    def test_loopback_bypass(self):
        self.run_command([PYTHON, "-c", f"import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:{self.http.server_port}/direct',timeout=5).read())"], self.client_env)
        self.assertEqual(self.http.hits, [("GET", "/direct")])

    def test_node_proxy_adoption(self):
        if not shutil.which("node"):
            self.skipTest("node not installed")
        major, minor, *_ = map(int, self.run_command(["node", "--version"]).stdout.strip().lstrip("v").split("."))
        if not (major > 24 or major == 24 and minor >= 5 or major == 22 and minor >= 21):
            self.skipTest("requires Node >=24.5 or 22.21 for native fetch env proxy support")
        for scheme in ["http", "https"]:
            self.assert_proxy(["node", "-e", "fetch(process.argv[1]).then(async r=>console.log(await r.text())).catch(e=>{console.error(e);process.exit(1)})", f"{scheme}://{HOST}/"], "CONNECT" if scheme == "https" else "GET")
        self.assert_proxy(["node", "-e", "require('node:http').get(process.argv[1],r=>r.pipe(process.stdout)).on('error',()=>process.exit(1))", f"http://{HOST}/"])
        self.assert_proxy(["node", "-e", "const w=new WebSocket(process.argv[1]);w.addEventListener('open',()=>process.exit(0));w.addEventListener('error',()=>process.exit(1));setTimeout(()=>process.exit(2),5000)", f"ws://{HOST}/"])

    def test_bun_fetch(self):
        if not shutil.which("bun"):
            self.skipTest("bun not installed")
        self.assert_proxy(["bun", "-e", f"fetch('http://{HOST}/').then(async r=>console.log(await r.text())).catch(()=>process.exit(1))"])

    def test_documented_non_proxy_clients(self):
        self.run_command([PYTHON, "-c", f"import http.client;c=http.client.HTTPConnection('{HOST}',timeout=3);c.request('GET','/')"], self.client_env, expected=1)
        self.assertEqual(self.http.hits, [])
        if shutil.which("node"):
            self.run_command(["node", "-e", "const c=require('node:http2').connect(process.argv[1]);c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),5000)", f"http://{HOST}/"], self.client_env, expected=1)
            self.assertEqual(self.http.hits, [])

    def test_git_http_proxy_adoption(self):
        # The recording proxy is not a Git server; assert the route, not a clone.
        self.run_command(["git", "ls-remote", f"http://{HOST}/repo.git"], self.client_env, expected=None)
        self.assertTrue(any(hit[0] == "GET" and HOST in hit[1] for hit in self.http.hits), self.http.hits)

    def test_go_default_http_transport(self):
        if not shutil.which("go"):
            self.skipTest("go not installed")
        source = self.directory / "probe.go"
        source.write_text('package main\nimport ("net/http"; "os"; "io")\nfunc main() { r,e:=http.Get(os.Args[1]); if e!=nil { panic(e) }; defer r.Body.Close(); io.Copy(os.Stdout,r.Body) }\n')
        self.assert_proxy(["go", "run", str(source), f"http://{HOST}/"], env=self.client_env | {"GO111MODULE": "off"}, timeout=120)

    def test_java_explicit_proxy_properties(self):
        if not shutil.which("java") or self.run_command(["java", "-version"], expected=None).returncode:
            self.skipTest("Java runtime not installed")
        source = self.directory / "ProxyProbe.java"
        source.write_text('import java.net.*; public class ProxyProbe { public static void main(String[] a) throws Exception { var c = new URL(a[0]).openConnection(); c.setConnectTimeout(3000); c.setReadTimeout(3000); System.out.write(c.getInputStream().readAllBytes()); } }')
        endpoint = urlsplit(self.client_env["HTTP_PROXY"])
        self.assert_proxy(["java", f"-Dhttp.proxyHost={endpoint.hostname}", f"-Dhttp.proxyPort={endpoint.port}", str(source), f"http://{HOST}/"])

    def python_module(self, name):
        if self.run_command([PYTHON, "-c", "import " + name], self.client_env, expected=None).returncode:
            self.skipTest(name + " not installed (optional compatibility test)")

    def test_python_requests(self):
        self.python_module("requests")
        self.assert_proxy([PYTHON, "-c", f"import requests;print(requests.get('https://{HOST}/',timeout=5).status_code)"], "CONNECT")

    def test_python_httpx(self):
        self.python_module("httpx")
        self.assert_proxy([PYTHON, "-c", f"import httpx;print(httpx.get('https://{HOST}/',timeout=5).status_code)"], "CONNECT")

    def test_python_aiohttp_opt_in(self):
        self.python_module("aiohttp")
        snippet = "import asyncio,aiohttp\nasync def main():\n async with aiohttp.ClientSession(trust_env=True) as s:\n  async with s.get('http://" + HOST + "/') as r: print(await r.text())\nasyncio.run(main())"
        self.assert_proxy([PYTHON, "-c", snippet])

    def test_doctor_checks_both_protocols_even_with_no_proxy_star(self):
        env = self.client_env | {"TS_DOCTOR_URL": f"https://{HOST}/", "NO_PROXY": "*", "no_proxy": "*"}
        result = self.run_command(["zsh", str(ROOT / "ts"), "doctor"], env)
        self.assertIn("PASS HTTP", result.stdout)
        self.assertIn("PASS SOCKS5", result.stdout)
        self.assertIn("203.0.113.7", result.stdout)
        self.assertIn(("CONNECT", HOST + ":443"), self.http.hits)
        self.assertIn(("SOCKS", HOST, 443), self.socks.hits)

    def test_doctor_fails_on_protocol_errors(self):
        # A listening server that rejects SOCKS passes a TCP-only preflight.
        self.socks.reject = True
        env = self.client_env | {"TS_DOCTOR_URL": f"https://{HOST}/"}
        result = self.run_command(["zsh", str(ROOT / "ts"), "doctor"], env, expected=1)
        self.assertIn("FAIL SOCKS5", result.stderr)


if __name__ == "__main__":
    unittest.main()
