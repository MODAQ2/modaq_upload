"""Tests for configuration: cross-platform log directory and settings sanitizing."""

import json
import sys
import tempfile
from pathlib import Path

import pytest

from app import config


class TestDefaultLogDirectory:
    """get_default_log_directory follows each OS's conventions."""

    def test_macos(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.setattr(Path, "home", lambda: Path("/Users/tester"))

        result = config.get_default_log_directory("myapp")

        assert result == Path("/Users/tester/Library/Logs/myapp")

    def test_windows_uses_localappdata(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\tester\AppData\Local")

        result = config.get_default_log_directory("myapp")

        assert result == Path(r"C:\Users\tester\AppData\Local") / "myapp" / "logs"

    def test_windows_without_localappdata(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.delenv("LOCALAPPDATA", raising=False)
        monkeypatch.setattr(Path, "home", lambda: Path(r"C:\Users\tester"))

        result = config.get_default_log_directory("myapp")

        assert result == Path(r"C:\Users\tester") / "AppData" / "Local" / "myapp" / "logs"

    def test_linux_respects_xdg_state_home(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setenv("XDG_STATE_HOME", "/home/tester/.local/state")

        result = config.get_default_log_directory("myapp")

        assert result == Path("/home/tester/.local/state/myapp/logs")

    def test_linux_defaults_without_xdg(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.delenv("XDG_STATE_HOME", raising=False)
        monkeypatch.setattr(Path, "home", lambda: Path("/home/tester"))

        result = config.get_default_log_directory("myapp")

        assert result == Path("/home/tester/.local/state/myapp/logs")


class TestIsUnderTempDir:
    def test_temp_path_detected(self) -> None:
        leaked = Path(tempfile.gettempdir()) / "pytest-leak" / "logs"
        assert config._is_under_temp_dir(leaked) is True

    def test_non_temp_path_not_detected(self) -> None:
        assert config._is_under_temp_dir(Path.home() / "Library" / "Logs" / "app") is False


class TestLogDirectorySanitization:
    """A temp-dir log_directory leaked into settings.json is repaired on load."""

    def _load_with_settings(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, data: dict[str, object]
    ) -> config.Settings:
        settings_file = tmp_path / "settings.json"
        settings_file.write_text(json.dumps(data), encoding="utf-8")
        monkeypatch.setattr(config, "SETTINGS_FILE", settings_file)
        config.Settings._instance = None
        return config.Settings()

    def teardown_method(self) -> None:
        # Reset the singleton so other tests reload from the real settings file.
        config.Settings._instance = None

    def test_temp_log_directory_falls_back_to_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        leaked = str(Path(tempfile.gettempdir()) / "tmpXXXX")
        settings = self._load_with_settings(monkeypatch, tmp_path, {"log_directory": leaked})

        assert settings.log_directory == config.get_default_log_directory()

    def test_empty_log_directory_falls_back_to_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        settings = self._load_with_settings(monkeypatch, tmp_path, {"log_directory": ""})

        assert settings.log_directory == config.get_default_log_directory()

    def test_explicit_absolute_log_directory_preserved(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        custom = Path.home() / ".modaq_custom_logs"
        settings = self._load_with_settings(monkeypatch, tmp_path, {"log_directory": str(custom)})

        assert settings.log_directory == custom


class TestPartitionSanitization:
    """_sanitize_partition_value keeps values safe as a single path segment."""

    def test_replaces_path_hostile_chars(self) -> None:
        assert config._sanitize_partition_value("a/b\\c=d e") == "a-b-c-d-e"

    def test_strips_surrounding_separators(self) -> None:
        assert config._sanitize_partition_value("  spaced  ") == "spaced"

    def test_empty_falls_back_to_unknown(self) -> None:
        assert config._sanitize_partition_value("   ") == "unknown"

    def test_os_helpers_have_no_separators(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(config.platform, "system", lambda: "Mac OS/X")
        monkeypatch.setattr(config.platform, "release", lambda: "25.4 .0")

        assert config.get_os_name() == "Mac-OS-X"
        assert config.get_os_version() == "25.4-.0"


class TestInstallId:
    """A persistent per-install ID is generated once and reused thereafter."""

    def _load_with_settings(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, data: dict[str, object]
    ) -> config.Settings:
        settings_file = tmp_path / "settings.json"
        settings_file.write_text(json.dumps(data), encoding="utf-8")
        monkeypatch.setattr(config, "SETTINGS_FILE", settings_file)
        config.Settings._instance = None
        return config.Settings()

    def teardown_method(self) -> None:
        config.Settings._instance = None

    def test_generates_and_persists_when_absent(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        settings = self._load_with_settings(monkeypatch, tmp_path, {"log_directory": str(tmp_path)})

        generated = settings.install_id
        assert generated  # non-empty
        # Persisted to settings.json
        on_disk = json.loads((tmp_path / "settings.json").read_text())
        assert on_disk["install_id"] == generated

    def test_stable_across_reads(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        settings = self._load_with_settings(monkeypatch, tmp_path, {"log_directory": str(tmp_path)})
        assert settings.install_id == settings.install_id

    def test_existing_value_preserved(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        settings = self._load_with_settings(
            monkeypatch, tmp_path, {"log_directory": str(tmp_path), "install_id": "preset123456"}
        )
        assert settings.install_id == "preset123456"

    def test_session_partitions_shape(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        self._load_with_settings(
            monkeypatch, tmp_path, {"log_directory": str(tmp_path), "install_id": "preset123456"}
        )
        monkeypatch.setattr(config.platform, "system", lambda: "Linux")
        monkeypatch.setattr(config.platform, "release", lambda: "6.1.0")

        assert config.get_session_partitions() == [
            "os=Linux",
            "os_version=6.1.0",
            "session=preset123456",
        ]
