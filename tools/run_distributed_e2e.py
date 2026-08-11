#!/usr/bin/env python3
"""Run Dropbox Browser E2E specs locally and, when configured, on remotes.

Normal operation is automatic: reachable compatible Windows and macOS Intel
workers receive scheduled specs, while the current Windows machine remains a
local lane. Before a remote run, workers which are dirty or not at the local
``HEAD`` are reset to that commit. The normal path fetches from ``origin``;
when that is unavailable the runner transfers a Git bundle directly over SSH.
Both paths keep the worker checkout clean before tests begin. If the optional
shared worker SDK, local notes, credentials, coordination owner, or remote
checkouts are absent, the runner reports the reason and runs locally. Actual
remote runs claim each selected worker on the shared coordination board and
release the lease afterward.
Use ``--require-remote`` when a distributed run must fail instead of falling
back.  Linux workers are intentionally excluded until browser compatibility is
implemented.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    from network_workers_bootstrap import BootstrapError, load_shared, remote_notes
except ModuleNotFoundError:  # package import from the repository test suite
    from tools.network_workers_bootstrap import BootstrapError, load_shared, remote_notes


REPO = Path(__file__).resolve().parents[1]
E2E_DIR = REPO / "tests" / "e2e"
TIMING_PATH = REPO / "Temp" / "remote-e2e" / "spec-timing.json"
DEFAULT_LOCAL_WEIGHT = 10.0
DEFAULT_POLL_SECONDS = 2.0
SUPPORTED_PLATFORMS = frozenset({"windows", "macos-intel"})


class RunnerError(RuntimeError):
    """Actionable distributed-runner failure."""


@dataclass(frozen=True)
class RemoteWorker:
    id: str
    nickname: str
    label: str
    host: str
    user: str
    repo: str
    git: str
    path_prefix: str
    platform: str
    remote_os: str
    branch: str | None
    schedule_weight: float
    browser: str = ""

    def target(self, ssh_module: Any) -> Any:
        return ssh_module.SshTarget(
            host=self.host,
            user=self.user,
            nickname=self.nickname,
            label=self.label,
            remote_os=self.remote_os,
        )


@dataclass(frozen=True)
class Assignment:
    lane_id: str
    specs: tuple[Path, ...]
    execution: str


def fail(message: str) -> None:
    raise RunnerError(message)


def _parse_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, parsed)


def infer_platform(host_entry: Any) -> str:
    hardware = getattr(host_entry, "hardware", None)
    os_name = str(getattr(hardware, "os", "") or "").casefold()
    description = " ".join(
        str(getattr(hardware, key, "") or "")
        for key in ("model", "cpu", "notes")
    ).casefold()
    if os_name.startswith("windows"):
        return "windows"
    if os_name.startswith("macos") or os_name.startswith("mac os"):
        if any(token in description for token in ("intel", "xeon", "core i3", "core i5", "core i7", "core i9")):
            return "macos-intel"
    return "unsupported"


def is_supported_platform(platform: str) -> bool:
    return str(platform or "").strip().casefold() in SUPPORTED_PLATFORMS


def _host_by_nickname(hosts: Any, nickname: str) -> Any:
    try:
        return hosts.get(nickname)
    except Exception as exc:  # noqa: BLE001 - normalize SDK errors
        raise RunnerError(f"worker {nickname!r} is missing from the shared host inventory: {exc}") from exc


def load_workers(shared: Any, settings: dict[str, Any]) -> tuple[list[RemoteWorker], list[str]]:
    """Resolve project-map workers and exclude unsupported platforms.

    The shared project map owns worker checkout/runtime settings.  A worker
    list in LOCAL_NOTES remains accepted as a compatibility override for
    machines that have not migrated their private notes yet.
    """

    workers_raw = settings.get("workers")
    project = None
    project_error: str | None = None
    project_name = str(settings.get("project") or "dropbox_browser").strip()
    try:
        project = shared.package.load_project(project_name, root=shared.root)
    except Exception as exc:  # noqa: BLE001 - legacy notes can still work without a map
        project_error = str(exc)
        if not isinstance(workers_raw, list):
            raise RunnerError(
                f"shared project map {project_name!r} could not be loaded: {exc}"
            ) from exc

    if isinstance(workers_raw, list):
        worker_entries: list[dict[str, Any]] = [
            raw for raw in workers_raw if isinstance(raw, dict)
        ]
    elif project is not None:
        worker_entries = [
            {"id": nickname.casefold(), "nickname": nickname}
            for nickname in project.workers
        ]
    else:
        return [], ["no local Remote E2E workers are configured"]

    hosts = shared.package.load_hosts(root=shared.root)
    workers: list[RemoteWorker] = []
    skipped: list[str] = []
    if project_error:
        skipped.append(f"project map unavailable; using legacy local notes: {project_error}")
    for index, raw in enumerate(worker_entries):
        if not isinstance(raw, dict):
            skipped.append(f"worker entry {index} is not an object")
            continue
        nickname = str(raw.get("nickname") or "").strip()
        if not nickname:
            skipped.append(f"worker entry {index} has no nickname")
            continue
        project_worker = None
        if project is not None:
            try:
                project_worker = project.get(nickname)
            except Exception:
                project_worker = None
        project_extra = getattr(project_worker, "extra", {})
        if not isinstance(project_extra, dict):
            project_extra = {}
        try:
            host_entry = _host_by_nickname(hosts, nickname)
        except RunnerError as exc:
            skipped.append(str(exc))
            continue
        if bool(getattr(host_entry, "never_remote", False)):
            skipped.append(f"{nickname}: inventory marks this host local-only")
            continue
        platform = str(
            raw.get("platform")
            or project_extra.get("platform")
            or infer_platform(host_entry)
        ).strip().casefold()
        if not is_supported_platform(platform):
            skipped.append(f"{nickname}: unsupported remote platform {platform or 'unknown'}")
            continue
        repo = str(
            raw.get("repo")
            or getattr(project_worker, "repo", "")
            or ""
        ).strip()
        if not repo:
            skipped.append(f"{nickname}: no remote checkout path configured")
            continue
        hardware = getattr(host_entry, "hardware", None)
        schedule_weight = raw.get("schedule_weight")
        if schedule_weight is None:
            schedule_weight = project_extra.get("schedule_weight")
        if schedule_weight is None:
            schedule_weight = getattr(getattr(host_entry, "defaults", None), "schedule_weight", None)
        try:
            schedule_weight = float(schedule_weight or 1.0)
        except (TypeError, ValueError):
            schedule_weight = 1.0
        workers.append(
            RemoteWorker(
                id=str(raw.get("id") or project_extra.get("id") or nickname.casefold()),
                nickname=nickname,
                label=str(
                    raw.get("label")
                    or project_extra.get("label")
                    or getattr(host_entry, "label", None)
                    or nickname
                ),
                host=str(getattr(host_entry, "host", "")),
                user=str(getattr(host_entry, "user", "")),
                repo=repo,
                git=str(raw.get("git") or getattr(project_worker, "git", "") or "git"),
                path_prefix=str(
                    raw.get("path_prefix")
                    or getattr(project_worker, "path_prefix", "")
                    or ""
                ),
                platform=platform,
                remote_os=str(getattr(hardware, "os", "") or ""),
                branch=(
                    str(raw["branch"])
                    if raw.get("branch")
                    else str(project_extra["branch"])
                    if project_extra.get("branch")
                    else None
                ),
                schedule_weight=max(0.01, schedule_weight),
                browser=str(
                    raw.get("browser")
                    or getattr(project_worker, "browser", "")
                    or project_extra.get("browser", "")
                    or ""
                ).strip(),
            )
        )
    return workers, skipped


def collect_specs(values: Iterable[str]) -> list[Path]:
    if values:
        specs: list[Path] = []
        for value in values:
            path = (REPO / value).resolve()
            if not path.is_file() or path.suffix != ".js" or E2E_DIR not in path.parents:
                fail(f"E2E spec must be a .js file under tests/e2e: {value}")
            specs.append(path)
    else:
        specs = sorted(E2E_DIR.glob("*.spec.js"))
    if not specs:
        fail("no E2E specs were found")
    return list(dict.fromkeys(specs))


def relative_spec(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def load_timings() -> dict[str, float]:
    if not TIMING_PATH.is_file():
        return {}
    try:
        payload = json.loads(TIMING_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        str(key): float(value)
        for key, value in payload.items()
        if isinstance(value, (int, float)) and value > 0
    } if isinstance(payload, dict) else {}


def save_timings(values: dict[str, float]) -> None:
    TIMING_PATH.parent.mkdir(parents=True, exist_ok=True)
    TIMING_PATH.write_text(json.dumps(dict(sorted(values.items())), indent=2) + "\n", encoding="utf-8")


def choose_assignments(shared: Any, specs: list[Path], workers: list[RemoteWorker], *, local_enabled: bool) -> list[Assignment]:
    if not workers and local_enabled:
        return [Assignment("local", tuple(specs), "local")]
    if not workers and not local_enabled:
        fail("remote mode has no compatible workers")

    bins: list[Any] = []
    if local_enabled:
        bins.append(shared.schedule.LaneBin("local", weight=DEFAULT_LOCAL_WEIGHT, execution="local", label="local"))
    for worker in workers:
        bins.append(shared.schedule.LaneBin(worker.id, weight=worker.schedule_weight, execution="remote", label=worker.label))
    timings = load_timings()
    units = [
        shared.schedule.WorkUnit(relative_spec(spec), size=timings.get(relative_spec(spec), 1.0))
        for spec in specs
    ]
    assignment, estimates = shared.schedule.optimize_assignment(units, bins, exact_limit=12)
    shared.schedule.apply_assignment(units, bins, assignment, estimates)
    result: list[Assignment] = []
    for lane in bins:
        lane_specs = tuple(REPO / unit.id for unit in lane.units)
        if lane_specs:
            result.append(Assignment(lane.lane_id, lane_specs, lane.execution))
    return result


def _path_export(path_prefix: str) -> str:
    if not path_prefix:
        return ""
    return f"export PATH={shlex.quote(path_prefix)}:\"$PATH\"; "


def remote_shell_path(worker: RemoteWorker, path: str) -> str:
    """Return a path accepted by the remote worker's POSIX shell.

    The shared SSH layer uses Git Bash for Windows workers.  Git Bash accepts
    ``E:/...`` for ``cd`` and Git, but treats the same spelling as a relative
    path when it is passed to ``mkdir`` or ``rm``.  Normalizing drive paths to
    ``/e/...`` keeps job creation, polling, retrieval, and cleanup consistent.
    """

    normalized = str(path).replace("\\", "/")
    if worker.platform == "windows" and len(normalized) >= 2 and normalized[1] == ":":
        return f"/{normalized[0].casefold()}{normalized[2:]}"
    return normalized


def remote_scp_path(worker: RemoteWorker, path: str) -> str:
    """Return a path accepted by OpenSSH SCP on a Windows worker."""

    normalized = str(path).replace("\\", "/")
    if (
        worker.platform == "windows"
        and len(normalized) >= 3
        and normalized[0] == "/"
        and normalized[2] == "/"
        and normalized[1].isalpha()
    ):
        return f"{normalized[1].upper()}:{normalized[2:]}"
    return normalized


def _remote_script(shared: Any, worker: RemoteWorker, specs: tuple[Path, ...], remote_dir: str, job_id: str) -> str:
    quote = shared.ssh.shell_quote
    spec_args = " ".join(quote(relative_spec(spec)) for spec in specs)
    stdout_path = quote(f"{remote_dir}/stdout.log")
    result_path = quote(f"{remote_dir}/result.json")
    repo_path = remote_shell_path(worker, worker.repo)
    browser_export = (
        f"export DROPBOX_BROWSER_BROWSER_EXECUTABLE={quote(worker.browser)}; "
        if worker.browser
        else ""
    )
    return "\n".join(
        [
            "set -e",
            _path_export(worker.path_prefix)
            + browser_export
            + f"cd {quote(repo_path)}",
            "set +e",
            "overall=0",
            f"for spec in {spec_args}; do",
            f"  npx playwright test \"$spec\" --reporter=line >> {stdout_path} 2>&1",
            "  code=$?",
            "  if test $code -ne 0; then overall=$code; fi",
            "done",
            f"printf '{{\"format\":\"dropbox-browser-distributed-e2e-v1\",\"job_id\":\"{job_id}\",\"exit_code\":%s}}\\n' \"$overall\" > {result_path}",
            "exit $overall",
        ]
    )


def _npx_command() -> str:
    return shutil.which("npx.cmd") or shutil.which("npx") or ("npx.cmd" if os.name == "nt" else "npx")


def run_local_specs(specs: tuple[Path, ...], output_dir: Path) -> tuple[bool, float]:
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    passed = True
    for spec in specs:
        log_path = output_dir / (spec.stem + ".log")
        with log_path.open("w", encoding="utf-8") as log:
            result = subprocess.run(
                [_npx_command(), "playwright", "test", relative_spec(spec), "--reporter=line"],
                cwd=REPO,
                env={**os.environ, "DROPBOX_BROWSER_E2E_DISTRIBUTED": "1"},
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        if result.returncode != 0:
            passed = False
    return passed, max(0.001, time.monotonic() - started)


def check_remote(shared: Any, ssh: Any, worker: RemoteWorker) -> tuple[bool, str]:
    target = worker.target(shared.ssh)
    repo_path = remote_shell_path(worker, worker.repo)
    try:
        shared.git_ops.preflight(
            ssh,
            target,
            repo=repo_path,
            git=worker.git,
            expected_head=None,
            require_clean=True,
            timeout=45,
        )
        branch_check = (
            f"{_path_export(worker.path_prefix)}"
            f"{shared.ssh.shell_quote(worker.git)} -C {shared.ssh.shell_quote(repo_path)} "
            "symbolic-ref --short -q HEAD || "
            f"{shared.ssh.shell_quote(worker.git)} -C {shared.ssh.shell_quote(repo_path)} rev-parse --abbrev-ref HEAD"
        )
        result = ssh.run(target, branch_check, timeout=45)
        if result.returncode != 0:
            return False, (result.stderr or result.stdout or "branch check failed").strip()[-500:]
        branch = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
        if worker.branch and worker.branch not in {"auto", branch}:
            return False, f"checked out branch {branch or '(detached)'!r}, expected {worker.branch!r}"
        command_check = (
            f"{_path_export(worker.path_prefix)}"
            "command -v npx >/dev/null 2>&1 || command -v npx.cmd >/dev/null 2>&1"
        )
        result = ssh.run(target, command_check, timeout=30)
        if result.returncode != 0:
            return False, "npx was not found on the configured remote PATH"
        dependency_check = (
            f"{_path_export(worker.path_prefix)}"
            f"cd {shared.ssh.shell_quote(repo_path)} && "
            "test -d node_modules/@playwright/test"
        )
        result = ssh.run(target, dependency_check, timeout=30)
        if result.returncode != 0:
            return False, "Playwright dependencies are not installed in the remote checkout"
    except Exception as exc:  # noqa: BLE001 - unavailable workers fall back locally
        return False, str(exc)[-800:]
    return True, "ready"


def inspect_remote_git(shared: Any, ssh: Any, worker: RemoteWorker) -> Any:
    """Return HEAD/cleanliness without rejecting a stale worker checkout."""

    return shared.git_ops.preflight(
        ssh,
        worker.target(shared.ssh),
        repo=remote_shell_path(worker, worker.repo),
        git=worker.git,
        expected_head=None,
        require_clean=False,
        timeout=45,
    )


def worker_needs_publish(report: Any, expected_head: str) -> bool:
    return (
        not bool(getattr(report, "clean", False))
        or str(getattr(report, "head", "") or "") != expected_head
    )


def _git_result(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def origin_has_commit(commit: str, *, branch: str) -> bool:
    """Return whether origin/<branch> contains ``commit`` after a best-effort fetch."""

    _git_result(["git", "fetch", "origin", branch])
    return _git_result(
        ["git", "merge-base", "--is-ancestor", commit, f"origin/{branch}"]
    ).returncode == 0


def ensure_origin_has_head(commit: str, *, branch: str) -> None:
    """Publish HEAD only when the configured branch cannot serve it to workers."""

    if origin_has_commit(commit, branch=branch):
        return
    print(
        f"publish: origin/{branch} lacks {commit[:12]}; pushing HEAD so workers can fetch…",
        flush=True,
    )
    pushed = _git_result(["git", "push", "origin", f"HEAD:{branch}"])
    if pushed.returncode != 0:
        detail = (pushed.stderr or pushed.stdout or "").strip()[-2000:]
        raise RunnerError(
            f"cannot push {commit[:12]} to origin/{branch}: {detail}"
        )
    if not origin_has_commit(commit, branch=branch):
        raise RunnerError(
            f"origin/{branch} still lacks {commit[:12]} after push; refusing to reset workers"
        )


def create_sync_bundle(commit: str, prerequisite_heads: Iterable[str]) -> Path:
    """Create a source-pinned bundle for direct worker synchronization."""

    bundle = REPO / "Temp" / "remote-e2e" / "sync" / f"{commit}.bundle"
    bundle.parent.mkdir(parents=True, exist_ok=True)
    heads = [head for head in prerequisite_heads if head and head != commit]
    revision_args = ["HEAD", "--not", heads[0]] if len(heads) == 1 else ["--all"]
    result = _git_result(["git", "bundle", "create", str(bundle), *revision_args])
    if result.returncode != 0 or not bundle.is_file() or bundle.stat().st_size == 0:
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise RunnerError(f"could not create direct worker sync bundle for {commit[:12]}: {detail}")
    return bundle


def _worker_branch(worker: RemoteWorker) -> str:
    return worker.branch if worker.branch and worker.branch != "auto" else "master"


def publish_worker_to_head(
    shared: Any,
    ssh: Any,
    worker: RemoteWorker,
    expected_head: str,
    *,
    bundle: Path | None,
) -> None:
    """Reset one worker to ``expected_head`` through origin or a direct bundle."""

    quote = shared.ssh.shell_quote
    target = worker.target(shared.ssh)
    repo = remote_shell_path(worker, worker.repo)
    branch = _worker_branch(worker)
    git_q = quote(worker.git)
    repo_q = quote(repo)
    head_q = quote(expected_head)
    branch_q = quote(branch)
    remote_bundle = ""
    if bundle is not None:
        remote_dir = f"{repo.rstrip('/')}/Temp/remote-e2e/sync"
        remote_bundle = f"{remote_dir}/runner-sync-{expected_head}.bundle"
        created = ssh.run(target, f"set -eu; mkdir -p {quote(remote_dir)}", timeout=45)
        if created.returncode != 0:
            detail = (created.stderr or created.stdout or "").strip()[-2000:]
            raise RunnerError(f"could not create sync directory on {worker.label}: {detail}")
        ssh.scp_to(target, bundle, remote_scp_path(worker, remote_bundle), timeout=180, check=True)
        fetch = f"{git_q} -C {repo_q} fetch {quote(remote_bundle)} {head_q}:refs/remotes/dropbox-browser/direct-sync"
    else:
        fetch = (
            f"{git_q} -C {repo_q} fetch origin {branch_q}; "
            f"if ! {git_q} -C {repo_q} cat-file -e {head_q}^{{commit}} 2>/dev/null; then "
            f"{git_q} -C {repo_q} fetch origin --prune; fi"
        )
    # Preserve a worker's local work before making its checkout testable.  The
    # clean preflight remains strict; the stash is intentional worker recovery.
    command = "\n".join(
        [
            "set -eu",
            f"{git_q} -C {repo_q} stash push -u -m dropbox-browser-runner-preserve-before-sync >/dev/null 2>&1 || true",
            fetch,
            f"{git_q} -C {repo_q} rev-parse --verify {head_q}^{{commit}} >/dev/null",
            f"{git_q} -C {repo_q} checkout {branch_q}",
            f"{git_q} -C {repo_q} reset --hard {head_q}",
            f"{git_q} -C {repo_q} clean -fd",
            *([f"rm -f {quote(remote_bundle)}"] if remote_bundle else []),
            f"printf 'PUBLISHED_HEAD='; {git_q} -C {repo_q} rev-parse HEAD; printf '\\n'",
        ]
    )
    result = ssh.run(target, command, timeout=180)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise RunnerError(f"publish {worker.label} failed: {detail}")
    published = next(
        (line.split("=", 1)[1].strip() for line in result.stdout.splitlines() if line.startswith("PUBLISHED_HEAD=")),
        "",
    )
    if published != expected_head:
        raise RunnerError(
            f"publish {worker.label}: reset landed on {published[:12] or '?'}; expected {expected_head[:12]}"
        )
    print(f"publish {worker.label}: reset to {expected_head[:12]}", flush=True)


def prepare_workers_for_run(
    shared: Any,
    ssh: Any,
    workers: list[RemoteWorker],
    *,
    expected_head: str,
    publish_mode: str,
    force_sync_clean: bool,
) -> None:
    """Synchronize stale/dirty workers, then enforce a clean exact-HEAD preflight."""

    mode = publish_mode.strip().lower()
    if mode not in {"auto", "always", "never"}:
        raise RunnerError("--publish-workers must be auto, always, or never")
    reports: list[tuple[RemoteWorker, Any]] = []
    for worker in workers:
        reports.append((worker, inspect_remote_git(shared, ssh, worker)))
    needing = [
        worker
        for worker, report in reports
        if force_sync_clean or mode == "always" or worker_needs_publish(report, expected_head)
    ]
    if needing and mode == "never" and not force_sync_clean:
        raise RunnerError(
            "publish-workers=never but remote(s) need update: "
            + ", ".join(worker.label for worker in needing)
        )
    if needing:
        branches = {_worker_branch(worker) for worker in needing}
        if len(branches) != 1:
            raise RunnerError("workers needing publish must use one configured branch")
        branch = branches.pop()
        bundle: Path | None = None
        try:
            ensure_origin_has_head(expected_head, branch=branch)
        except RunnerError as exc:
            bundle = create_sync_bundle(expected_head, [str(getattr(report, "head", "") or "") for _, report in reports])
            print(f"publish: origin unavailable ({exc}); using direct SSH bundle {bundle.name}", flush=True)
        for worker in needing:
            publish_worker_to_head(shared, ssh, worker, expected_head, bundle=bundle)
    for worker in workers:
        report = shared.git_ops.preflight(
            ssh,
            worker.target(shared.ssh),
            repo=remote_shell_path(worker, worker.repo),
            git=worker.git,
            expected_head=expected_head,
            require_clean=True,
            timeout=45,
        )
        print(f"preflight {worker.label}: HEAD {report.head[:12]} clean", flush=True)


def coordination_owner(settings: dict[str, Any], args: argparse.Namespace) -> str:
    return str(
        getattr(args, "coord_owner", None)
        or os.environ.get("SPTMP2_COORD_OWNER")
        or settings.get("coord_owner")
        or ""
    ).strip()


def claim_coordination_workers(
    shared: Any,
    workers: list[RemoteWorker],
    *,
    owner: str,
    duration_seconds: float,
    grace_seconds: float,
) -> tuple[list[RemoteWorker], list[tuple[RemoteWorker, str]]]:
    """Claim workers before remote preflight/test execution."""

    store = shared.coordination.coordination_store(root=shared.root)
    claimed: list[RemoteWorker] = []
    leases: list[tuple[RemoteWorker, str]] = []
    for worker in workers:
        try:
            lease = store.claim(
                [worker.nickname],
                owner=owner,
                duration_seconds=duration_seconds,
                grace_seconds=grace_seconds,
                reason="Dropbox Browser distributed E2E",
            )
            leases.append((worker, str(lease["lease_id"])))
            claimed.append(worker)
            print(
                f"coordination: claimed {worker.nickname} for {duration_seconds:.0f}s "
                f"(lease {lease['lease_id']})",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - another project may own it
            print(
                f"remote worker skipped: {worker.label}: coordination claim failed: {exc}",
                file=sys.stderr,
                flush=True,
            )
    return claimed, leases


def release_coordination_leases(
    shared: Any,
    leases: list[tuple[RemoteWorker, str]],
    *,
    owner: str,
    reason: str,
) -> None:
    if not leases:
        return
    store = shared.coordination.coordination_store(root=shared.root)
    for worker, lease_id in leases:
        try:
            store.release(lease_id, owner=owner, reason=reason)
            print(f"coordination: released {worker.nickname} ({lease_id})", flush=True)
        except Exception as exc:  # noqa: BLE001 - do not hide the test result
            print(
                f"coordination warning: could not release {worker.nickname} "
                f"({lease_id}): {exc}",
                file=sys.stderr,
                flush=True,
            )


def normalize_job_result(
    execution: str,
    value: tuple[bool, float] | tuple[bool, float, str],
) -> tuple[bool, float, str]:
    """Normalize local and remote job results for the shared result loop."""

    if execution == "local":
        passed, duration = value
        return passed, duration, "local run"
    passed, duration, detail = value
    return passed, duration, detail


def run_remote_job(shared: Any, ssh: Any, worker: RemoteWorker, specs: tuple[Path, ...], run_id: str, keep_remote: bool, local_dir: Path) -> tuple[bool, float, str]:
    target = worker.target(shared.ssh)
    client = shared.jobs.JobClient(ssh)
    job_id = f"{worker.id}-{uuid.uuid4().hex[:8]}"
    remote_dir = f"{remote_shell_path(worker, worker.repo).rstrip('/')}/Temp/remote-e2e/{run_id}/{worker.id}"
    remote_copy_dir = remote_scp_path(worker, remote_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    script = _remote_script(shared, worker, specs, remote_dir, job_id)
    started = time.monotonic()

    # Windows OpenSSH commonly starts PowerShell as the login shell. Its
    # Git-Bash child processes are terminated when SSH disconnects, so the
    # shared detached JobClient protocol is not reliable there. Hold the SSH
    # session open for the foreground run, matching the worker setup used by
    # the other distributed E2E runner while keeping the shared JobClient for
    # Unix-like remotes.
    if worker.platform == "windows":
        shell_quote = shared.ssh.shell_quote
        command = "\n".join(
            [
                "set -eu",
                f"mkdir -p {shell_quote(remote_dir)}",
                script,
            ]
        )
        result = ssh.run(target, command, timeout=7200)
        copy_handle = shared.jobs.JobHandle(
            job_id=job_id,
            target=target,
            remote_dir=remote_copy_dir,
            local_dir=str(local_dir),
        )
        cleanup_handle = shared.jobs.JobHandle(
            job_id=job_id,
            target=target,
            remote_dir=remote_dir,
            local_dir=str(local_dir),
        )
        try:
            payload = client.retrieve(
                copy_handle,
                names=("result.json", "stdout.log"),
                local_dir=local_dir,
            )
        except Exception as exc:  # noqa: BLE001 - report both transfer and run failures
            if not keep_remote:
                client.cleanup(cleanup_handle)
            detail = str(exc)
            if result.returncode != 0:
                detail = f"remote exit {result.returncode}: {detail}"
            return False, max(0.001, time.monotonic() - started), detail
        if not keep_remote:
            client.cleanup(cleanup_handle)
        code = int(payload.get("exit_code", result.returncode or 1)) if isinstance(payload, dict) else 1
        return code == 0, max(0.001, time.monotonic() - started), f"exit {code}"

    handle = client.start(target, job_id, script, run_id=run_id, remote_dir=remote_dir, local_dir=local_dir)
    payload: dict[str, Any] = {}
    while True:
        status, detail = client.poll(handle)
        if status == shared.jobs.JobPollStatus.RUNNING:
            time.sleep(DEFAULT_POLL_SECONDS)
            continue
        if status != shared.jobs.JobPollStatus.RESULT:
            if not keep_remote:
                client.cleanup(handle)
            return False, max(0.001, time.monotonic() - started), detail or str(status)
        handle.remote_dir = remote_copy_dir
        try:
            payload = client.retrieve(handle, names=("result.json", "stdout.log"), local_dir=local_dir)
        except Exception as exc:  # noqa: BLE001
            handle.remote_dir = remote_dir
            if not keep_remote:
                client.cleanup(handle)
            return False, max(0.001, time.monotonic() - started), str(exc)
        handle.remote_dir = remote_dir
        if not keep_remote:
            client.cleanup(handle)
        code = int(payload.get("exit_code", 1)) if isinstance(payload, dict) else 1
        return code == 0, max(0.001, time.monotonic() - started), f"exit {code}"


def run(args: argparse.Namespace) -> int:
    specs = collect_specs(args.spec)
    settings = remote_notes()
    local_config = settings.get("local") if isinstance(settings.get("local"), dict) else {}
    local_enabled = bool(local_config.get("enabled", True)) and args.mode != "remote"
    require_remote = bool(args.require_remote or args.mode == "remote")

    shared_loaded: tuple[Path, Any] | None = None
    if args.mode != "local":
        try:
            shared_loaded = load_shared(args.shared_root, required=require_remote)
        except BootstrapError as exc:
            if require_remote:
                fail(str(exc))
            print(f"remote E2E unavailable: {exc}; using local lane", file=sys.stderr, flush=True)
    coord_owner = coordination_owner(settings, args)
    if shared_loaded is not None and not args.dry_run and not coord_owner:
        message = (
            "SPTMP2_COORD_OWNER or LOCAL_NOTES coord_owner is required before "
            "using remote workers"
        )
        if require_remote:
            fail(message)
        print(f"remote E2E unavailable: {message}; using local lane", file=sys.stderr, flush=True)
        shared_loaded = None
    if shared_loaded is None:
        if not local_enabled:
            fail("remote worker SDK is unavailable and the local lane is disabled")
        assignment = [Assignment("local", tuple(specs), "local")]
        if args.dry_run:
            print(f"local plan: {len(specs)} spec(s); remote SDK unavailable")
            return 0
        passed, duration = run_local_specs(tuple(specs), REPO / "Temp" / "remote-e2e" / "local")
        print(f"local E2E {'passed' if passed else 'failed'} in {duration:.1f}s", flush=True)
        return 0 if passed else 1

    root, package = shared_loaded
    shared = type(
        "SharedBindings",
        (),
        {
            "root": root,
            "package": package,
            "auth": __import__("network_computers.auth", fromlist=["resolve_auth"]),
            "availability": __import__("network_computers.availability", fromlist=["select_available_workers"]),
            "coordination": __import__("network_computers.coordination", fromlist=["coordination_store"]),
            "git_ops": __import__("network_computers.git_ops", fromlist=["preflight"]),
            "jobs": __import__("network_computers.jobs", fromlist=["JobClient"]),
            "schedule": __import__("network_computers.schedule", fromlist=["optimize_assignment"]),
            "ssh": __import__("network_computers.ssh", fromlist=["SshClient"]),
        },
    )
    try:
        workers, skipped = load_workers(shared, settings)
    except Exception as exc:  # noqa: BLE001 - malformed optional config falls back locally
        if require_remote:
            fail(f"remote worker configuration failed: {exc}")
        print(f"remote E2E unavailable: {exc}; using local lane", file=sys.stderr, flush=True)
        workers = []
        skipped = []
    for message in skipped:
        print(f"remote worker skipped: {message}", file=sys.stderr, flush=True)
    if not workers:
        if require_remote:
            fail("no compatible remote E2E workers are configured")
        if not local_enabled:
            fail("no compatible remote workers and local lane is disabled")
        print("remote E2E unavailable: no compatible workers; using local lane", file=sys.stderr, flush=True)
        if args.dry_run:
            print(f"local plan: {len(specs)} spec(s)")
            return 0
        passed, duration = run_local_specs(tuple(specs), REPO / "Temp" / "remote-e2e" / "local")
        print(f"local E2E {'passed' if passed else 'failed'} in {duration:.1f}s", flush=True)
        return 0 if passed else 1

    try:
        auth = shared.auth.resolve_auth(root=root, required=True)
        ssh = shared.ssh.SshClient(auth, connect_timeout=5)
        hosts = shared.package.load_hosts(root=root)
        workers, availability_plan = shared.availability.select_available_workers(
            ssh,
            workers,
            hosts=hosts,
            timeout=5,
            connect_timeout=5,
            coordination_owner=coord_owner or None,
        )
        for line in shared.availability.format_plan_lines(availability_plan):
            print(line, flush=True)
    except Exception as exc:  # noqa: BLE001 - default is safe local fallback
        if require_remote:
            fail(f"remote availability setup failed: {exc}")
        print(f"remote E2E unavailable: {exc}; using local lane", file=sys.stderr, flush=True)
        workers = []
        ssh = None

    coordination_leases: list[tuple[RemoteWorker, str]] = []
    if ssh is not None and not args.dry_run:
        workers, coordination_leases = claim_coordination_workers(
            shared,
            workers,
            owner=coord_owner,
            duration_seconds=args.coord_duration_seconds,
            grace_seconds=args.coord_grace_seconds,
        )

    expected_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.strip()
    if ssh is not None and coordination_leases and not args.dry_run:
        try:
            prepare_workers_for_run(
                shared,
                ssh,
                workers,
                expected_head=expected_head,
                publish_mode=args.publish_workers,
                force_sync_clean=args.sync_clean,
            )
        except Exception:
            release_coordination_leases(
                shared,
                coordination_leases,
                owner=coord_owner,
                reason="worker publication failed",
            )
            raise

    ready_workers: list[RemoteWorker] = []
    if ssh is not None:
        for worker in workers:
            ready, detail = check_remote(shared, ssh, worker)
            if ready:
                ready_workers.append(worker)
            else:
                print(f"remote worker skipped: {worker.label}: {detail}", file=sys.stderr, flush=True)
    ready_ids = {worker.id for worker in ready_workers}
    failed_preflight_leases = [
        lease for lease in coordination_leases if lease[0].id not in ready_ids
    ]
    if failed_preflight_leases:
        release_coordination_leases(
            shared,
            failed_preflight_leases,
            owner=coord_owner,
            reason="remote preflight did not pass",
        )
        coordination_leases = [
            lease for lease in coordination_leases if lease[0].id in ready_ids
        ]
    if not ready_workers and require_remote:
        release_coordination_leases(
            shared,
            coordination_leases,
            owner=coord_owner,
            reason="no remote workers passed preflight",
        )
        fail("no compatible reachable remote E2E workers passed preflight")
    if not ready_workers and not local_enabled:
        release_coordination_leases(
            shared,
            coordination_leases,
            owner=coord_owner,
            reason="local lane disabled",
        )
        fail("no remote E2E workers passed preflight and local lane is disabled")

    try:
        assignments = choose_assignments(shared, specs, ready_workers, local_enabled=local_enabled)
        for item in assignments:
            print(f"plan: {item.execution} {item.lane_id}: {len(item.specs)} spec(s)", flush=True)
        if args.dry_run:
            return 0

        run_id = uuid.uuid4().hex[:12]
        timings = load_timings()
        results: list[tuple[str, bool, float, str]] = []
        remote_assignments = [item for item in assignments if item.execution == "remote"]
        local_assignments = [item for item in assignments if item.execution == "local"]
        worker_by_id = {worker.id: worker for worker in ready_workers}
        with ThreadPoolExecutor(max_workers=max(1, len(remote_assignments) + len(local_assignments))) as pool:
            futures = {}
            for item in remote_assignments:
                worker = worker_by_id[item.lane_id]
                futures[pool.submit(
                    run_remote_job,
                    shared,
                    ssh,
                    worker,
                    item.specs,
                    run_id,
                    args.keep_remote,
                    REPO / "Temp" / "remote-e2e" / run_id / worker.id,
                )] = item
            for item in local_assignments:
                futures[pool.submit(run_local_specs, item.specs, REPO / "Temp" / "remote-e2e" / run_id / "local")] = item
            for future in as_completed(futures):
                item = futures[future]
                try:
                    passed, duration, detail = normalize_job_result(item.execution, future.result())
                except Exception as exc:  # noqa: BLE001
                    passed, duration, detail = False, 0.001, str(exc)
                results.append((item.lane_id, passed, duration, detail))
                for spec in item.specs:
                    timings[relative_spec(spec)] = duration / max(1, len(item.specs))
                print(
                    f"result: {item.execution} {item.lane_id}: "
                    f"{'passed' if passed else 'failed'} "
                    f"({duration:.1f}s; {detail})",
                    flush=True,
                )

        save_timings(timings)
        passed = all(item[1] for item in results) and len(results) == len(assignments)
        print(f"distributed E2E {'passed' if passed else 'failed'}", flush=True)
        return 0 if passed else 1
    finally:
        release_coordination_leases(
            shared,
            coordination_leases,
            owner=coord_owner,
            reason="distributed E2E finished",
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("auto", "local", "remote"), default="auto")
    parser.add_argument("--require-remote", action="store_true", help="fail instead of falling back when remote execution is unavailable")
    parser.add_argument("--shared-root", help="override the optional shared worker SDK root")
    parser.add_argument("--spec", action="append", default=[], help="run one tests/e2e spec; repeatable (default: all specs)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan without starting Playwright")
    parser.add_argument(
        "--publish-workers",
        choices=("auto", "always", "never"),
        default="auto",
        help="sync dirty or stale workers to local HEAD: auto (default), always, or never",
    )
    parser.add_argument(
        "--sync-clean",
        action="store_true",
        help="force synchronization of every selected worker before preflight",
    )
    parser.add_argument("--keep-remote", action="store_true", help="retain remote job directories for inspection")
    parser.add_argument("--coord-owner", help="coordination-board owner; defaults to SPTMP2_COORD_OWNER or LOCAL_NOTES")
    parser.add_argument("--coord-duration-seconds", type=float, default=1800.0, help="worker lease duration for a remote run (default: 1800)")
    parser.add_argument("--coord-grace-seconds", type=float, default=30.0, help="worker lease grace period (default: 30)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except (RunnerError, OSError, ValueError) as exc:
        print(f"distributed E2E error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
