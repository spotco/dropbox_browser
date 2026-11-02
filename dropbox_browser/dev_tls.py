"""Generate local self-signed TLS material for the Dropbox Browser dev HTTPS listener.

Material is stored under ignored Temp/ by default. Browsers show a certificate
warning until an operator manually trusts the generated CA; the server does not
install trust automatically.
"""
from __future__ import annotations

import argparse
import csv
import ctypes
from ctypes import wintypes
import ipaddress
import io
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import TEMP_DIR


DNS_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


class DevTlsUnavailable(Exception):
    """Dev TLS material could not be generated on this machine."""


def default_dev_tls_directory() -> Path:
    return TEMP_DIR / "dev-https"


def openssl_executable() -> str | None:
    configured = os.environ.get("DROPBOX_BROWSER_OPENSSL")
    if configured is not None:
        return shutil.which(configured) or (configured if Path(configured).is_file() else None)
    found = shutil.which("openssl")
    if found:
        return found
    if os.name == "nt":
        roots = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "usr" / "bin" / "openssl.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Git" / "usr" / "bin" / "openssl.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Git" / "usr" / "bin" / "openssl.exe",
        ]
        for candidate in roots:
            if candidate.is_file():
                return str(candidate)
    return None


def windows_user_sid() -> str:
    whoami = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "whoami.exe"
    completed = subprocess.run(
        [str(whoami), "/user", "/fo", "csv", "/nh"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"whoami could not identify the current Windows user: {completed.stderr.strip()}")
    try:
        row = next(csv.reader(io.StringIO(completed.stdout)))
        sid = row[-1].strip()
    except (StopIteration, csv.Error, IndexError) as error:
        raise RuntimeError("whoami returned an unreadable Windows user SID") from error
    if not re.fullmatch(r"S-1-5-(?:\d+-)*\d+", sid):
        raise RuntimeError(f"whoami returned an invalid Windows user SID: {sid!r}")
    return sid


def _set_and_verify_windows_acl(path: Path, user_sid: str, is_directory: bool) -> None:
    """Replace a TLS path's DACL with user, SYSTEM, and Administrators only."""
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    convert_in = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert_in.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.DWORD),
    ]
    convert_in.restype = wintypes.BOOL
    get_dacl = advapi32.GetSecurityDescriptorDacl
    get_dacl.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL),
    ]
    get_dacl.restype = wintypes.BOOL
    set_named = advapi32.SetNamedSecurityInfoW
    set_named.argtypes = [
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    set_named.restype = wintypes.DWORD
    get_named = advapi32.GetNamedSecurityInfoW
    get_named.argtypes = [
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    get_named.restype = wintypes.DWORD
    convert_out = advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW
    convert_out.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(wintypes.DWORD),
    ]
    convert_out.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    inherit = "OICI" if is_directory else ""
    ace_flags = f"{inherit};" if inherit else ";"
    sddl = (
        f"D:P(A;{inherit};FA;;;{user_sid})"
        f"(A;{inherit};FA;;;SY)(A;{inherit};FA;;;BA)"
    )
    descriptor = ctypes.c_void_p()
    if not convert_in(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        present = wintypes.BOOL()
        defaulted = wintypes.BOOL()
        dacl = ctypes.c_void_p()
        if not get_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present.value:
            raise RuntimeError(f"could not read the generated DACL for {path}")
        security_information = 0x00000004 | 0x80000000  # DACL | protected DACL
        error = set_named(str(path), 1, security_information, None, None, dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel32.LocalFree(descriptor)

    owner = ctypes.c_void_p()
    group = ctypes.c_void_p()
    actual_dacl = ctypes.c_void_p()
    sacl = ctypes.c_void_p()
    actual_descriptor = ctypes.c_void_p()
    error = get_named(
        str(path),
        1,
        0x00000004,
        ctypes.byref(owner),
        ctypes.byref(group),
        ctypes.byref(actual_dacl),
        ctypes.byref(sacl),
        ctypes.byref(actual_descriptor),
    )
    if error:
        raise ctypes.WinError(error)
    sddl_pointer = wintypes.LPWSTR()
    try:
        if not convert_out(actual_descriptor, 1, 0x00000004, ctypes.byref(sddl_pointer), None):
            raise ctypes.WinError(ctypes.get_last_error())
        actual_sddl = ctypes.wstring_at(sddl_pointer)
    finally:
        if sddl_pointer:
            kernel32.LocalFree(sddl_pointer)
        if actual_descriptor:
            kernel32.LocalFree(actual_descriptor)

    actual_body = actual_sddl.split("D:", 1)[-1]
    actual_aces = set(re.findall(r"\(([^()]*)\)", actual_body))
    expected_aces = {
        f"A;{ace_flags}FA;;;{user_sid}",
        f"A;{ace_flags}FA;;;SY",
        f"A;{ace_flags}FA;;;BA",
    }
    if not actual_body.startswith("P") or actual_aces != expected_aces:
        raise RuntimeError(f"Windows TLS ACL verification failed for {path}: {actual_sddl}")


def restrict_windows_tls_permissions(directory: Path) -> None:
    if os.name != "nt":
        return
    sid = windows_user_sid()
    _set_and_verify_windows_acl(directory, sid, is_directory=True)
    for child in sorted(directory.iterdir()):
        if child.is_file():
            _set_and_verify_windows_acl(child, sid, is_directory=False)


def add_subject(value: str, dns_names: set[str], ip_addresses: set[str]) -> None:
    value = value.strip().rstrip(".")
    if not value:
        return
    try:
        ip_addresses.add(ipaddress.ip_address(value).compressed)
        return
    except ValueError:
        pass
    if DNS_NAME.fullmatch(value):
        dns_names.add(value.lower())


def discovered_subject_names(extra_hosts: list[str]) -> tuple[list[str], list[str]]:
    dns_names: set[str] = {"localhost"}
    ip_addresses: set[str] = {"127.0.0.1", "::1"}
    candidates = [socket.gethostname(), socket.getfqdn(), os.environ.get("COMPUTERNAME", "")]
    candidates.extend(extra_hosts)

    for candidate in candidates:
        add_subject(candidate, dns_names, ip_addresses)
        try:
            for result in socket.getaddrinfo(candidate, None, type=socket.SOCK_STREAM):
                add_subject(result[4][0], dns_names, ip_addresses)
        except (OSError, UnicodeError):
            pass

    # Resolve the host's default outbound IPv4 address without sending traffic;
    # this makes direct-IP access work when DNS resolves only on client devices.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route_probe:
            route_probe.connect(("192.0.2.1", 9))
            add_subject(route_probe.getsockname()[0], dns_names, ip_addresses)
    except OSError:
        pass

    return sorted(dns_names), sorted(ip_addresses, key=lambda value: (":" in value, value))


def openssl_run(executable: str, arguments: list[str]) -> None:
    completed = subprocess.run(
        [executable, *arguments],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"OpenSSL command failed ({completed.returncode}): {detail}")


def write_config(path: Path, content: str) -> None:
    path.write_text(content, encoding="ascii", newline="\n")


def write_ca(executable: str, directory: Path) -> None:
    config = "\n".join(
        [
            "[req]",
            "prompt = no",
            "distinguished_name = distinguished_name",
            "x509_extensions = v3_ca",
            "[distinguished_name]",
            "CN = Dropbox Browser Dev Local CA",
            "[v3_ca]",
            "basicConstraints = critical,CA:TRUE,pathlen:0",
            "keyUsage = critical,keyCertSign,cRLSign",
            "subjectKeyIdentifier = hash",
            "authorityKeyIdentifier = keyid:always,issuer",
            "",
        ]
    )
    with tempfile.TemporaryDirectory(prefix=".root-ca-", dir=directory) as temporary:
        temp = Path(temporary)
        config_path = temp / "ca-openssl.cnf"
        key_path = temp / "root-ca.key"
        cert_path = temp / "root-ca.crt"
        write_config(config_path, config)
        openssl_run(
            executable,
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:3072",
                "-nodes",
                "-sha256",
                "-days",
                "3650",
                "-keyout",
                str(key_path),
                "-out",
                str(cert_path),
                "-config",
                str(config_path),
            ],
        )
        key_path.replace(directory / "root-ca.key")
        cert_path.replace(directory / "root-ca.crt")


def write_server_certificate(
    executable: str,
    directory: Path,
    dns_names: list[str],
    ip_addresses: list[str],
) -> None:
    primary_name = dns_names[1] if len(dns_names) > 1 else dns_names[0]
    san_lines = [f"DNS.{index} = {name}" for index, name in enumerate(dns_names, 1)]
    san_lines.extend(f"IP.{index} = {address}" for index, address in enumerate(ip_addresses, 1))
    config = "\n".join(
        [
            "[req]",
            "prompt = no",
            "distinguished_name = distinguished_name",
            "req_extensions = request_extensions",
            "[distinguished_name]",
            f"CN = {primary_name}",
            "[request_extensions]",
            "subjectAltName = @subject_alt_names",
            "[subject_alt_names]",
            *san_lines,
            "[server_certificate]",
            "basicConstraints = critical,CA:FALSE",
            "keyUsage = critical,digitalSignature,keyEncipherment",
            "extendedKeyUsage = serverAuth",
            "subjectKeyIdentifier = hash",
            "authorityKeyIdentifier = keyid,issuer",
            "subjectAltName = @subject_alt_names",
            "",
        ]
    )
    with tempfile.TemporaryDirectory(prefix=".server-cert-", dir=directory) as temporary:
        temp = Path(temporary)
        config_path = temp / "server-openssl.cnf"
        request_path = temp / "server.csr"
        key_path = temp / "server.key"
        cert_path = temp / "server.crt"
        write_config(config_path, config)
        openssl_run(
            executable,
            [
                "req",
                "-new",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-keyout",
                str(key_path),
                "-out",
                str(request_path),
                "-config",
                str(config_path),
            ],
        )
        openssl_run(
            executable,
            [
                "x509",
                "-req",
                "-sha256",
                "-days",
                "825",
                "-in",
                str(request_path),
                "-CA",
                str(directory / "root-ca.crt"),
                "-CAkey",
                str(directory / "root-ca.key"),
                "-CAcreateserial",
                "-out",
                str(cert_path),
                "-extfile",
                str(config_path),
                "-extensions",
                "server_certificate",
            ],
        )
        key_path.replace(directory / "server.key")
        cert_path.replace(directory / "server.crt")


def _extra_hosts_from_env() -> list[str]:
    return [
        host.strip()
        for host in os.environ.get("DROPBOX_BROWSER_HTTPS_HOSTS", "").split(",")
        if host.strip()
    ]


def ensure_dev_tls_material(
    directory: Path,
    extra_hosts: list[str] | None = None,
) -> tuple[Path, Path]:
    """Create or reuse server.crt/server.key under directory."""
    executable = openssl_executable()
    if executable is None:
        raise DevTlsUnavailable(
            "OpenSSL was not found. Install OpenSSL, add it to PATH, or set "
            "DROPBOX_BROWSER_OPENSSL to its executable."
        )

    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        directory.chmod(0o700)
    else:
        restrict_windows_tls_permissions(directory)

    hosts = list(extra_hosts or _extra_hosts_from_env())
    dns_names, ip_addresses = discovered_subject_names(hosts)
    root_key = directory / "root-ca.key"
    root_cert = directory / "root-ca.crt"
    if not root_key.is_file() or not root_cert.is_file():
        if root_key.exists() or root_cert.exists():
            root_key.unlink(missing_ok=True)
            root_cert.unlink(missing_ok=True)
        write_ca(executable, directory)
    openssl_run(
        executable,
        [
            "x509",
            "-in",
            str(root_cert),
            "-outform",
            "DER",
            "-out",
            str(directory / "root-ca.cer"),
        ],
    )

    write_server_certificate(executable, directory, dns_names, ip_addresses)
    if os.name != "nt":
        root_key.chmod(0o600)
        (directory / "server.key").chmod(0o600)
    else:
        restrict_windows_tls_permissions(directory)

    cert_path = directory / "server.crt"
    key_path = directory / "server.key"
    if not cert_path.is_file() or not key_path.is_file():
        raise DevTlsUnavailable("OpenSSL finished without writing server.crt/server.key")
    return cert_path, key_path


def main_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--directory",
        type=Path,
        default=default_dev_tls_directory(),
        help="Ignored directory for generated local certificates (default: Temp/dev-https)",
    )
    parser.add_argument(
        "--host",
        action="append",
        default=_extra_hosts_from_env(),
        help="Extra DNS name or IP address to include; repeat as needed",
    )
    args = parser.parse_args(argv)

    try:
        cert_path, key_path = ensure_dev_tls_material(args.directory, extra_hosts=args.host)
    except DevTlsUnavailable as error:
        print(str(error), file=sys.stderr)
        return 2

    executable = openssl_executable()
    assert executable is not None
    root_cert = args.directory.resolve() / "root-ca.crt"
    fingerprint = subprocess.run(
        [executable, "x509", "-in", str(root_cert), "-noout", "-fingerprint", "-sha256"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout.strip()
    dns_names, ip_addresses = discovered_subject_names(args.host)
    print(f"Dev HTTPS certificate: {cert_path}")
    print(f"Dev HTTPS private key: {key_path}")
    print("This is a local self-signed development certificate; browsers will warn until its CA is trusted manually.")
    print(f"Local CA (for manual inspection only): {args.directory.resolve() / 'root-ca.cer'} ({fingerprint})")
    if os.name == "nt":
        print("Windows TLS ACLs: verified for current user, SYSTEM, and Administrators only.")
    print(f"Certificate DNS names: {', '.join(dns_names)}")
    print(f"Certificate IP addresses: {', '.join(ip_addresses)}")
    return 0
