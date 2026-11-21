"""Analyzers exposed by the command line and File Explorer."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .parser import parse_folder


@dataclass(frozen=True)
class Analyzer:
    label: str
    title: str
    parse: Callable[[Path], dict] | None = None


ANALYZERS = {
    "charge-log": Analyzer("解析charge-log", "充电日志分析", parse_folder),
    "hilog": Analyzer("解析hilog", "系统日志分析"),
    "kmsg": Analyzer("解析kmsg", "内核日志分析"),
}
