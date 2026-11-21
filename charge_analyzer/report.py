"""Render a self-contained offline chart for an analyzer result."""

import json
from pathlib import Path

WEB = Path(__file__).with_name("web")
LARGE_SOURCE_BYTES = 1024 * 1024
SOURCE_CHUNK_ROWS = 128


def _script_json(value: object) -> str:
    # Inert JSON must not allow a log field to close its enclosing script tag.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).replace("<", "\\u003c")


def _cell_width(value: str) -> int:
    if value.isascii() and "\t" not in value:
        return len(value)
    return sum(4 if char == "\t" else 2 if not char.isascii() else 1 for char in value)


def _source_payloads(data: dict) -> tuple[dict, list[str]]:
    tables = dict(data.get("source_tables", {}))
    sizes = data.get("source_sizes", {})
    chunks = []
    for name, table in tables.items():
        if sizes.get(name, 0) <= LARGE_SOURCE_BYTES:
            continue

        headers = table["headers"]
        rows = table["rows"]
        widths = [_cell_width(header) for header in headers]
        for row in rows:
            for index, value in enumerate(row):
                widths[index] = max(widths[index], _cell_width(value))

        chunk_ids = []
        for start in range(0, len(rows), SOURCE_CHUNK_ROWS):
            chunk_id = len(chunks)
            chunk_ids.append(chunk_id)
            payload = _script_json(rows[start:start + SOURCE_CHUNK_ROWS])
            chunks.append(f'<script type="application/json" id="source-chunk-{chunk_id}">{payload}</script>')
        tables[name] = {
            "headers": headers,
            "start": table.get("start"),
            "end": table.get("end"),
            "row_count": len(rows),
            "chunk_size": SOURCE_CHUNK_ROWS,
            "chunk_ids": chunk_ids,
            "widths": widths,
        }
    return tables, chunks


def render_report(data: dict) -> str:
    template = (WEB / "index.html").read_text(encoding="utf-8")
    source = (
        ("/*__STYLES__*/", (WEB / "styles.css").read_text(encoding="utf-8")),
        ("/*__CHART_JS__*/", (WEB / "chart.js").read_text(encoding="utf-8")),
        ("/*__APP_JS__*/", (WEB / "app.js").read_text(encoding="utf-8")),
    )
    for marker, content in source:
        template = template.replace(marker, content, 1)

    tables, chunks = _source_payloads(data)
    payload = {key: value for key, value in data.items() if key != "source_sizes"}
    payload["source_tables"] = tables
    template = template.replace("<!--__SOURCE_CHUNKS__-->", "\n".join(chunks), 1)
    return template.replace("__LOG_DATA__", _script_json(payload), 1)
