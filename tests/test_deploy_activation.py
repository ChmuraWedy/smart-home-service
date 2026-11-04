import importlib.util
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

SPEC = importlib.util.spec_from_file_location(
    "dell_activation", Path(__file__).parents[1] / "deploy" / "activate-dell.py"
)
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)
OLD = "fixture-old-key"
NEW = "a" * 64
ENV = f"# Private settings\nSMART_HOME_CLOUD_ENABLED=1\n\nSMART_HOME_API_TOKEN='{OLD}'\nOTHER=keep-me\n"


@pytest.mark.parametrize("value", [OLD, f'"{OLD}"', f"'{OLD}' # comment"])
def test_replace_only_key_and_preserve_other_settings(value):
    original = ENV.replace(f"'{OLD}'", value)
    changed = deployment.with_token(original, NEW)
    assert deployment.read_token(changed) == NEW
    assert changed == original.replace(f"SMART_HOME_API_TOKEN={value}", f"SMART_HOME_API_TOKEN={NEW}")


@pytest.mark.parametrize("value", ["", "SMART_HOME_API_TOKEN=\n", "SMART_HOME_API_TOKEN=${OTHER}\n", ENV + ENV])
def test_reject_ambiguous_or_interpolated_key(value):
    with pytest.raises(ValueError):
        deployment.read_token(value)


def test_private_replacement_and_symlink_rejection(tmp_path):
    target = tmp_path / ".env"
    target.write_text(ENV)
    target.chmod(0o644)
    deployment.private_write(target, ENV.replace(OLD, NEW))
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    link = tmp_path / ".env.link"
    link.symlink_to(target)
    with pytest.raises(ValueError):
        deployment.private_write(link, "replacement")
    assert deployment.read_token(target.read_text()) == NEW
    assert not list(tmp_path.glob(".env.deploy-*"))


def remote_fakes(monkeypatch, tmp_path, failure=False):
    (tmp_path / ".env").write_text(ENV)
    calls = []

    def command(args, directory, image=None):
        assert directory == tmp_path
        calls.append((args, image))
        if "ps" in args:
            return "existing-container"
        if "inspect" in args:
            return "sha256:old-image"
        if "up" in args and not image and failure:
            raise RuntimeError("Do not expose credentials: " + NEW)
        return ""

    monkeypatch.setattr(deployment, "command", command)
    check = Mock(return_value=9)
    monkeypatch.setattr(deployment, "check_api", check)
    return calls, check


def test_activate_rotates_and_verifies_new_key(tmp_path, monkeypatch):
    calls, check = remote_fakes(monkeypatch, tmp_path)
    result = deployment.activate(tmp_path, OLD, NEW)
    assert result == {"ok": True, "saved_devices": 9}
    assert deployment.read_token((tmp_path / ".env").read_text()) == NEW
    assert (tmp_path / ".env.before-deploy").read_text() == ENV
    check.assert_called_once_with(NEW)
    assert any("up" in args for args, _ in calls)
    assert any("tag" in args for args, _ in calls)
    assert NEW not in json.dumps(result)


def test_failure_restores_previous_image_and_key_without_logging_secret(tmp_path, monkeypatch):
    calls, check = remote_fakes(monkeypatch, tmp_path, failure=True)
    result = deployment.activate(tmp_path, OLD, NEW)
    assert result["rolled_back"] is True
    assert result["ok"] is False
    assert (tmp_path / ".env").read_text() == ENV
    assert any(image == deployment.ROLLBACK_IMAGE for _, image in calls)
    check.assert_called_once_with(OLD)
    assert NEW not in json.dumps(result)


def test_api_failure_rolls_back_and_failed_rollback_is_reported(tmp_path, monkeypatch):
    remote_fakes(monkeypatch, tmp_path)
    monkeypatch.setattr(deployment, "check_api", Mock(side_effect=RuntimeError(NEW)))
    result = deployment.activate(tmp_path, OLD, NEW)
    assert result["rolled_back"] is False
    assert not result["ok"]
    assert (tmp_path / ".env").read_text() == ENV
    assert NEW not in json.dumps(result)


def test_mismatched_local_key_cannot_overwrite_dell(tmp_path, monkeypatch):
    calls, _ = remote_fakes(monkeypatch, tmp_path)
    result = deployment.activate(tmp_path, "different-fixture", NEW)
    assert not result["ok"]
    assert calls == []
    assert (tmp_path / ".env").read_text() == ENV


def mac_args(tmp_path):
    env = tmp_path / ".env"
    env.write_text(ENV)
    return SimpleNamespace(local_env=env, host="dell5070", directory="/remote/service")


def test_mac_commits_same_new_key_only_after_confirmed_success(tmp_path, monkeypatch, capsys):
    args = mac_args(tmp_path)
    monkeypatch.setattr(deployment.secrets, "token_hex", lambda size: NEW)

    def run(command, **kwargs):
        payload = json.loads(kwargs["input"])
        assert payload["token"] == NEW
        assert payload["expected_token"] == OLD
        assert NEW not in " ".join(command)
        assert args.local_env.read_text() == ENV
        assert deployment.read_token((tmp_path / ".env.pending-deploy").read_text()) == NEW
        return SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True, "saved_devices": 9}))

    monkeypatch.setattr(deployment.subprocess, "run", run)
    assert deployment.activate_from_mac(args) == 0
    assert deployment.read_token(args.local_env.read_text()) == NEW
    assert stat.S_IMODE(args.local_env.stat().st_mode) == 0o600
    assert not (tmp_path / ".env.pending-deploy").exists()
    assert NEW not in capsys.readouterr().out


def test_unknown_remote_result_keeps_both_private_keys_and_blocks_retry(tmp_path, monkeypatch, capsys):
    args = mac_args(tmp_path)
    monkeypatch.setattr(deployment.secrets, "token_hex", lambda size: NEW)
    monkeypatch.setattr(deployment.subprocess, "run", Mock(return_value=SimpleNamespace(
        returncode=255, stdout="", stderr="sensitive " + NEW,
    )))
    assert deployment.activate_from_mac(args) == 1
    assert args.local_env.read_text() == ENV
    pending = tmp_path / ".env.pending-deploy"
    assert deployment.read_token(pending.read_text()) == NEW
    assert stat.S_IMODE(pending.stat().st_mode) == 0o600
    assert (tmp_path / ".env.before-deploy").read_text() == ENV
    with pytest.raises(RuntimeError, match="pending-deploy"):
        deployment.activate_from_mac(args)
    captured = capsys.readouterr()
    assert NEW not in captured.out + captured.err


def test_compose_cannot_inherit_another_api_key(monkeypatch, tmp_path):
    monkeypatch.setenv("SMART_HOME_API_TOKEN", "unrelated-fixture")
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout="ok"))
    monkeypatch.setattr(deployment.subprocess, "run", run)
    deployment.command(["example"], tmp_path)
    assert "SMART_HOME_API_TOKEN" not in run.call_args.kwargs["env"]
    assert os.environ["SMART_HOME_API_TOKEN"] == "unrelated-fixture"


def test_remote_entrypoint_works_without_file_variable(monkeypatch):
    monkeypatch.delattr(deployment, "__file__")
    monkeypatch.setattr(deployment.sys, "argv", ["-c", "--remote"])
    run = Mock()
    monkeypatch.setattr(deployment, "remote", run)
    assert deployment.main() == 0
    run.assert_called_once_with()


def test_local_deployment_lock_blocks_concurrent_activation(monkeypatch, tmp_path):
    args = mac_args(tmp_path)
    monkeypatch.setattr(deployment.sys, "argv", ["activate-dell.py", "--local-env", str(args.local_env)])
    activate = Mock()
    monkeypatch.setattr(deployment, "activate_from_mac", activate)
    with (tmp_path / ".env.deploy.lock").open("w") as lock:
        deployment.fcntl.flock(lock, deployment.fcntl.LOCK_EX | deployment.fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):
            deployment.main()
    activate.assert_not_called()
