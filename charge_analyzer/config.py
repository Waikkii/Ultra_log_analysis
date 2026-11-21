"""Read the shared configuration used by CLI and Explorer launches."""

import json
from pathlib import Path
from sys import float_info


def _column_names(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(name, str) or not name.strip() for name in value
    ):
        raise ValueError(f"配置项 {field} 必须是非空列名组成的数组。")

    names = [name.strip() for name in value]
    if len(names) != len(set(names)):
        raise ValueError(f"配置项 {field} 含有重复列名。")
    return names


def load_config(project_root: Path) -> dict:
    path = project_root / "config.json"
    if not path.exists():
        path = project_root / "config.example.json"

    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError as error:
        raise ValueError(f"配置文件 {path.name} 必须使用 UTF-8 编码。") from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"配置文件 {path.name} 的 JSON 格式有误（第 {error.lineno} 行，第 {error.colno} 列）。"
        ) from error

    if not isinstance(config, dict):
        raise ValueError(f"配置文件 {path.name} 的顶层必须是 JSON 对象。")

    default_columns = _column_names(config.get("default_columns", []), "default_columns")
    groups = config.get("shared_axes", {})
    if not isinstance(groups, dict):
        raise ValueError("配置项 shared_axes 必须是以分组名为键、列名数组为值的对象。")

    shared_axes: dict[str, list[str]] = {}
    column_groups: dict[str, str] = {}
    for name, value in groups.items():
        group = name.strip()
        if not group or group in shared_axes:
            raise ValueError("shared_axes 的分组名称必须非空且唯一。")
        columns = _column_names(value, f"shared_axes.{group}")
        if len(columns) < 2:
            raise ValueError(f"共用纵轴分组“{group}”至少需要两列。")

        for column in columns:
            if column in column_groups:
                raise ValueError(
                    f"列“{column}”同时出现在共用纵轴分组“{column_groups[column]}”和“{group}”中。"
                )
            column_groups[column] = group
        shared_axes[group] = columns

    interval = config.get("expected_interval_seconds")
    if interval is not None and (
        type(interval) not in (int, float) or not 0 < interval <= float_info.max
    ):
        raise ValueError("配置项 expected_interval_seconds 必须是有限的正数或 null。")

    return {
        "default_columns": default_columns,
        "shared_axes": shared_axes,
        "expected_interval_seconds": interval,
    }
