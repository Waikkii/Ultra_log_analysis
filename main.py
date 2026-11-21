"""Command-line and File Explorer entry point."""

import argparse
import os
import sys
import tempfile
import webbrowser
from pathlib import Path

from charge_analyzer.analyzers import ANALYZERS
from charge_analyzer.config import load_config
from charge_analyzer.parser import find_gaps
from charge_analyzer.report import render_report
from charge_analyzer.windows import install_context_menu, uninstall_context_menu


def show_message(message: str) -> None:
    if sys.stderr is not None:
        print(message, file=sys.stderr)
    elif os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "日志分析", 0x40)


def arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地日志分析")
    commands = parser.add_subparsers(dest="command", required=True)
    analyze = commands.add_parser("analyze", help="分析文件夹并打开交互图表")
    analyze.add_argument("analyzer", choices=ANALYZERS)
    analyze.add_argument("folder", type=Path)
    analyze.add_argument("--output", type=Path, help="将离线 HTML 保存到指定路径（默认写入日志文件夹）")
    analyze.add_argument("--no-open", action="store_true", help="生成图表后不打开浏览器")
    commands.add_parser("install-context-menu", help="安装 Windows 文件夹右键菜单")
    commands.add_parser("uninstall-context-menu", help="移除 Windows 文件夹右键菜单")
    return parser.parse_args(argv)


def analyze(args: argparse.Namespace) -> int:
    analyzer = ANALYZERS[args.analyzer]
    if analyzer.parse is None:
        show_message(f"{analyzer.label}将在后续版本实现。")
        return 2

    folder = args.folder.resolve(strict=True)
    if not folder.is_dir():
        raise NotADirectoryError(f"请选择文件夹：{folder}")

    config = load_config(Path(__file__).resolve().parent)
    data = analyzer.parse(folder)
    expected_interval = config["expected_interval_seconds"]
    if expected_interval is not None:
        data["gaps"] = find_gaps(data["rows"], expected_interval_ms=expected_interval * 1000)
    data.update(analyzer=args.analyzer, title=analyzer.title, view_config=config)
    report = render_report(data)
    output = args.output.resolve() if args.output is not None else folder / f"{args.analyzer}.html"
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(report)
        temporary_path.replace(output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    if sys.stdout is not None:
        print(output)
    if not args.no_open and not webbrowser.open(output.as_uri(), new=1):
        show_message(f"请在浏览器打开图表文件：\n{output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = arguments(argv)
    try:
        if args.command == "install-context-menu":
            install_context_menu(Path(__file__).resolve())
            print("已安装文件夹右键菜单。")
        elif args.command == "uninstall-context-menu":
            uninstall_context_menu()
            print("已移除文件夹右键菜单。")
        else:
            return analyze(args)
    except (OSError, ValueError) as error:
        show_message(f"日志分析失败：{error}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
