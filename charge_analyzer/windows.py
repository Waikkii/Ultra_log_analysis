"""Register the analyzer commands in the current user's Explorer context menu."""

from pathlib import Path
import subprocess
import sys

from .analyzers import ANALYZERS


_SHELL_PATH = r"Software\Classes\Directory\shell"
_KEY_PREFIX = "LogAnalyzer."


def _registry():
    if sys.platform != "win32":
        raise OSError("文件夹右键菜单仅支持 Windows 文件资源管理器。")

    import winreg

    return winreg


def install_context_menu(entrypoint: Path) -> None:
    registry = _registry()
    script = entrypoint.resolve(strict=True)
    if not script.is_file():
        raise OSError(f"找不到程序文件：{script}")

    executable = Path(sys.executable).absolute()
    windowed_executable = executable.with_name("pythonw.exe")
    if executable.name.lower() == "python.exe" and windowed_executable.is_file():
        executable = windowed_executable

    for name, analyzer in ANALYZERS.items():
        key_path = rf"{_SHELL_PATH}\{_KEY_PREFIX}{name}"
        command = subprocess.list2cmdline([str(executable), str(script), "analyze", name])
        command += ' "%1"'

        with registry.CreateKeyEx(registry.HKEY_CURRENT_USER, key_path) as key:
            with registry.CreateKeyEx(key, "command") as command_key:
                registry.SetValueEx(command_key, "", 0, registry.REG_SZ, command)
            registry.SetValueEx(key, "", 0, registry.REG_SZ, analyzer.label)
            registry.SetValueEx(key, "MultiSelectModel", 0, registry.REG_SZ, "Single")


def uninstall_context_menu() -> None:
    registry = _registry()
    for name in ANALYZERS:
        key_path = rf"{_SHELL_PATH}\{_KEY_PREFIX}{name}"
        for path in (rf"{key_path}\command", key_path):
            try:
                registry.DeleteKey(registry.HKEY_CURRENT_USER, path)
            except FileNotFoundError:
                pass
