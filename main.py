"""Command-line and File Explorer entry point."""

import argparse
import os
import sys
import tempfile
import webbrowser
from pathlib import Path

from charge_analyzer.analyzers import ANALYZERS
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
    analyze.add_argument("--output", type=Path, help="将离线 HTML 保存到指定路径")
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

    data = analyzer.parse(folder)
    data.update(analyzer=args.analyzer, title=analyzer.title)
    report = render_report(data)
    if args.output is not None:
        output = args.output.resolve()
    else:
        output = Path(tempfile.mkdtemp(prefix="log-analyzer-")) / f"{args.analyzer}.html"
    output.write_text(report, encoding="utf-8")

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
