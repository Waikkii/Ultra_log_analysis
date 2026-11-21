"""Read rotated charge logs and normalize their columns for the chart."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
from pathlib import Path
import re


_FILENAME = re.compile(r"charge-log\.([0-9]+)")
_HEADER = re.compile(r"^\s*Time\s+\S")
_TIMESTAMP = re.compile(
    r"^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)[ \t]*>"
)
_WORD = re.compile(r"\S+")
_INTEGER = re.compile(r"[+-]?[0-9]+")
_HEX = re.compile(r"[+-]?0[xX][0-9a-fA-F]+")
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_WARNING_LIMIT = 100


@dataclass
class _Warnings:
    messages: list[str] = field(default_factory=list)
    skipped: int = 0

    def add(self, message: str) -> None:
        if len(self.messages) < _WARNING_LIMIT:
            self.messages.append(message)
        else:
            self.skipped += 1

    def all(self) -> list[str]:
        if self.skipped:
            return [*self.messages, f"另有 {self.skipped:,} 条解析提示。"]
        return self.messages


@dataclass(frozen=True)
class _Unaligned:
    file: str
    line_number: int
    text: str
    payload_start: int
    value_count: int


@dataclass
class _Section:
    names: list[str]
    header_words: list[tuple[int, int]]
    header_separator: str | None
    rows: list[tuple[int, list[str | None] | _Unaligned]] = field(default_factory=list)
    starts: list[int | None] = field(default_factory=list)
    ends: list[int | None] = field(default_factory=list)
    separator: str | None = None

    def observe(self, text: str, payload_start: int, words: list[re.Match[str]]) -> None:
        starts = [word.start() for word in words]
        ends = [word.end() for word in words]
        gaps = [text[payload_start:starts[0]]]
        gaps.extend(text[end:start] for end, start in zip(ends, starts[1:]))
        separator = gaps[0] if gaps[0] and set(gaps) == {gaps[0]} else None
        if not self.starts:
            self.starts = starts
            self.ends = ends
            self.separator = separator
            return
        self.starts = [a if a == b else None for a, b in zip(self.starts, starts)]
        self.ends = [a if a == b else None for a, b in zip(self.ends, ends)]
        if self.separator != separator:
            self.separator = None

    def read_row(self, time: int, text: str, payload_start: int, file: str, number: int) -> None:
        tab_values = _tab_values(text[payload_start:], len(self.names))
        if tab_values is not None:
            self.rows.append((time, tab_values))
            return
        words = list(_WORD.finditer(text, payload_start))
        if len(words) == len(self.names):
            self.observe(text, payload_start, words)
            self.rows.append((time, [word.group() for word in words]))
        elif not words:
            self.rows.append((time, [None] * len(self.names)))
        else:
            self.rows.append((time, _Unaligned(file, number, text, payload_start, len(words))))

    def align(self, row: _Unaligned) -> list[str | None] | None:
        separator = self.separator if self.starts else self.header_separator
        payload = row.text[row.payload_start:]
        if separator and payload.startswith(separator):
            values = payload[len(separator):].split(separator)
            if len(values) == len(self.names) and all(not value or _WORD.fullmatch(value) for value in values):
                return values
        words = list(_WORD.finditer(row.text, row.payload_start))
        if self.starts:
            learned = _align_words(words, self.starts, self.ends)
            if learned is not None:
                return learned
        starts = [start for start, _ in self.header_words]
        ends = [end for _, end in self.header_words]
        return _align_words(words, starts, ends)

    def finish(self, warnings: _Warnings) -> list[tuple[int, dict[str, str]]]:
        records = []
        for time, row in self.rows:
            if isinstance(row, _Unaligned):
                values = self.align(row)
                if values is None:
                    details = f"表头有 {len(self.names)} 列，识别到 {row.value_count} 个值"
                    reason = "空白列位置无法确定" if row.value_count < len(self.names) else "值的数量超过表头列数"
                    warnings.add(f"{row.file}:{row.line_number} {details}，{reason}。已将该行标记为缺失。")
                    records.append((time, {}))
                    continue
            else:
                values = row
            records.append((time, {
                name: value
                for name, raw in zip(self.names, values)
                if (value := _present_value(raw)) is not None
            }))
        return records


def _tab_values(payload: str, count: int) -> list[str] | None:
    if "\t" not in payload:
        return None
    values = payload.split("\t")
    if len(values) == count + 1 and not values[0].strip():
        return values[1:]
    return values if len(values) == count else None


def _align_words(
    words: list[re.Match[str]], starts: list[int | None], ends: list[int | None]
) -> list[str | None] | None:
    if len(words) > len(starts):
        return None
    start_columns = {start: index for index, start in enumerate(starts) if start is not None}
    end_columns = {end: index for index, end in enumerate(ends) if end is not None}
    options = [
        sorted({start_columns.get(word.start(), -1), end_columns.get(word.end(), -1)} - {-1})
        for word in words
    ]
    # Compare the first and last possible ordered placements. Matching placements
    # mean every token has exactly one column consistent with the known alignment.
    ordered_columns = []
    previous = -1
    for candidates in options:
        column = next((candidate for candidate in candidates if candidate > previous), None)
        if column is None:
            return None
        ordered_columns.append(column)
        previous = column
    following = len(starts)
    for candidates, expected in zip(reversed(options), reversed(ordered_columns)):
        column = next((candidate for candidate in reversed(candidates) if candidate < following), None)
        if column != expected:
            return None
        following = column
    values = [None] * len(starts)
    for column, word in zip(ordered_columns, words):
        values[column] = word.group()
    return values


def _section(line: str) -> _Section:
    header = list(_WORD.finditer(line))
    names = []
    seen: dict[str, int] = {}
    for word in header[1:]:
        name = word.group()
        seen[name] = seen.get(name, 0) + 1
        names.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
    gaps = [line[left.end():right.start()] for left, right in zip(header, header[1:])]
    separator = gaps[0] if gaps and set(gaps) == {gaps[0]} else None
    return _Section(names, [(word.start(), word.end()) for word in header[1:]], separator)


def _read_text(path: Path, warnings: _Warnings) -> str:
    data = path.read_bytes()
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return data.decode("gb18030")
        except UnicodeDecodeError:
            warnings.add(f"{path.name} 含无法解码的字符，已用替代字符保留内容。")
            return data.decode("utf-8-sig", errors="replace")


def _milliseconds(timestamp: str) -> int:
    moment = datetime.fromisoformat(timestamp.replace(",", ".")).replace(tzinfo=timezone.utc)
    elapsed = moment - _EPOCH
    return (elapsed.days * 86400 + elapsed.seconds) * 1000 + elapsed.microseconds // 1000


def _present_value(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped and stripped.casefold() != "none" else None


def _number(value: str) -> int | float | None:
    try:
        if _HEX.fullmatch(value) or _INTEGER.fullmatch(value):
            base = 16 if "x" in value.lower() else 10
            number = int(value, base)
            return number if math.isfinite(number) else None
        if _DECIMAL.fullmatch(value):
            number = float(value)
            return number if math.isfinite(number) else None
    except (OverflowError, ValueError):
        pass
    return None


def parse_folder(path: str | Path) -> dict:
    """Read charge-log.N files, preserving the logged local wall-clock time."""
    folder = Path(path).expanduser().resolve()
    sources = [
        (int(match[1]), entry)
        for entry in folder.iterdir()
        if (match := _FILENAME.fullmatch(entry.name)) and entry.is_file()
    ]
    sources.sort(key=lambda item: (item[0], item[1].name))
    warnings = _Warnings()
    source_contents: dict[str, str] = {}
    names: dict[str, None] = {}
    records: list[tuple[int, dict[str, str]]] = []
    section = None
    for _, source in sources:
        try:
            text = _read_text(source, warnings)
        except (OSError, UnicodeError) as error:
            warnings.add(f"{source.name} 读取失败（{error}）。")
            continue
        source_contents[source.name] = text
        for number, line in enumerate(text.splitlines(), start=1):
            if _HEADER.match(line):
                if section is not None:
                    records.extend(section.finish(warnings))
                section = _section(line)
                names.update(dict.fromkeys(section.names))
                continue
            timestamp = _TIMESTAMP.match(line)
            if timestamp is None:
                if line.strip():
                    warnings.add(f"{source.name}:{number} 无法识别为表头或时间记录，已跳过。")
                continue
            if section is None:
                warnings.add(f"{source.name}:{number} 记录出现在首个表头之前，已跳过。")
                continue
            try:
                time = _milliseconds(timestamp[1])
            except ValueError:
                warnings.add(f"{source.name}:{number} 时间无效，已跳过。")
                continue
            section.read_row(time, line, timestamp.end(), source.name, number)
    if section is not None:
        records.extend(section.finish(warnings))
    if not sources:
        warnings.add("此文件夹中没有 charge-log.n 日志文件。")
    elif not records:
        warnings.add("没有可绘制的时间记录。")

    records.sort(key=lambda record: record[0])
    distinct: dict[str, dict[str, int | float | None]] = {name: {} for name in names}
    for _, values in records:
        for name, value in values.items():
            if value not in distinct[name]:
                distinct[name][value] = _number(value)
    columns = []
    converters = []
    for name, values in distinct.items():
        category = any(number is None for number in values.values())
        columns.append({
            "name": name,
            "kind": "category" if category else "number",
            "categories": list(values) if category else [],
        })
        converters.append({value: value for value in values} if category else values)
    rows = [
        {"time": time, "values": [converter.get(values.get(name)) for name, converter in zip(names, converters)]}
        for time, values in records
    ]
    return {
        "folder": str(folder),
        "files": list(source_contents),
        "columns": columns,
        "rows": rows,
        "warnings": warnings.all(),
        "source_contents": source_contents,
    }
