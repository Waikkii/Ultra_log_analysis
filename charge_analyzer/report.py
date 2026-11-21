"""Render a self-contained offline chart for an analyzer result."""

import json
from pathlib import Path

WEB = Path(__file__).with_name("web")


def render_report(data: dict) -> str:
    template = (WEB / "index.html").read_text(encoding="utf-8")
    source = (
        ("/*__STYLES__*/", (WEB / "styles.css").read_text(encoding="utf-8")),
        ("/*__CHART_JS__*/", (WEB / "chart.js").read_text(encoding="utf-8")),
        ("/*__APP_JS__*/", (WEB / "app.js").read_text(encoding="utf-8")),
    )
    for marker, content in source:
        template = template.replace(marker, content, 1)

    # Logs can contain arbitrary markup. Keep it inert inside the JSON script.
    payload = json.dumps(data, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    return template.replace("__LOG_DATA__", payload.replace("<", "\\u003c"), 1)
