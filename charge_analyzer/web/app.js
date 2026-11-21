(() => {
    "use strict";

    const byId = id => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat("zh-CN", {maximumSignificantDigits: 10});
    const integerFormat = new Intl.NumberFormat("zh-CN");
    const seriesColors = [
        "#147d83", "#5c61c9", "#a8721b", "#356940", "#3769bd",
        "#71842e", "#72509e", "#77602c", "#1681ad", "#525b70",
    ];

    function element(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = value;
        return node;
    }

    function swatch(className, color) {
        const node = element("span", className);
        node.style.backgroundColor = color;
        node.setAttribute("aria-hidden", "true");
        return node;
    }

    function labelTime(time, showMilliseconds = false) {
        return new Date(time).toISOString().slice(0, showMilliseconds ? 23 : 19).replace("T", " ");
    }

    function typeLabel(column) {
        return column.kind === "category" ? "文字" : "数值";
    }

    function sourceFileEntry(name, tables) {
        const item = element("li");
        const details = element("details", "source-file");
        const summary = element("summary", "source-file-name", name);
        const content = element("div", "source-file-content");
        content.tabIndex = 0;
        content.setAttribute("role", "region");
        content.setAttribute("aria-label", `${name} 原始内容`);
        details.append(summary, content);
        item.append(details);

        function populate() {
            if (!details.open) return;
            const source = tables?.[name];
            if (!source?.rows.length && !source?.headers.length) {
                content.append(element("p", "list-empty", source ? "文件为空" : "源文件内容不可用"));
            } else {
                const table = element("table", "source-table");
                table.setAttribute("aria-label", name);
                const heading = table.createTHead().insertRow();
                for (const name of source.headers) {
                    const cell = element("th", "", name);
                    cell.scope = "col";
                    heading.append(cell);
                }
                const body = table.createTBody();
                for (const values of source.rows) {
                    const row = body.insertRow();
                    const time = element("th", "", values[0] ?? "");
                    time.scope = "row";
                    row.append(time);
                    for (let index = 1; index < source.headers.length; index += 1) {
                        row.append(element("td", "", values[index] ?? ""));
                    }
                }
                content.append(table);
            }
            details.removeEventListener("toggle", populate);
        }

        details.addEventListener("toggle", populate);
        return item;
    }

    function initialize(data) {
        const columns = data.columns.map((column, index) => ({
            ...column,
            index,
            color: seriesColors[index % seriesColors.length],
        }));
        const rows = data.rows;
        const {default_columns, shared_axes = {}} = data.view_config ?? {};
        const defaultColumns = new Set(default_columns);
        const selected = new Set(columns.filter(column => defaultColumns.has(column.name)).map(column => column.index));
        const byName = new Map(columns.map(column => [column.name, column]));
        const warnings = [...data.warnings];
        const groups = [];
        for (const [name, names] of Object.entries(shared_axes)) {
            const members = names.map(name => byName.get(name)).filter(Boolean);
            if (members.length < 2) continue;
            if (members.some(member => member.kind !== members[0].kind)) {
                warnings.push(`配置中的纵轴组「${name}」同时包含数值列和文字列，已使用各列自己的刻度。`);
                continue;
            }
            groups.push({
                name,
                indices: members.map(member => member.index),
                categories: [...new Set(members.flatMap(member => member.categories))],
            });
        }
        let filter = "all";
        let visibleSeries = [];
        let lastFrame;
        const search = byId("column-search");
        const columnList = byId("column-list");
        const emptyChart = byId("chart-empty");
        const tooltip = byId("chart-tooltip");
        const markersPanel = byId("markers-panel");
        const markersList = byId("markers-list");
        const markerNotes = new Map();

        const folderParts = data.folder.split(/[\\/]+/).filter(Boolean);
        const folderName = folderParts.at(-1) ?? data.folder;
        byId("folder-name").textContent = folderName;
        if (byId("folder-path")) byId("folder-path").textContent = data.folder;
        byId("analyzer-name").textContent = data.analyzer;
        byId("app-title").textContent = data.title;
        document.title = `${data.analyzer} · ${folderName}`;
        byId("file-count").textContent = integerFormat.format(data.files.length);
        byId("row-count").textContent = integerFormat.format(rows.length);
        byId("column-count").textContent = integerFormat.format(columns.length);
        const timeRange = byId("time-range");
        if (rows.length) {
            const start = labelTime(rows[0].time);
            const end = labelTime(rows.at(-1).time);
            timeRange.textContent = start.slice(0, 10) === end.slice(0, 10)
                ? `${start} – ${end.slice(11)}`
                : `${start} – ${end}`;
        }
        byId("files").hidden = data.files.length === 0;
        byId("files-list").replaceChildren(...data.files.map(name => sourceFileEntry(name, data.source_tables)));
        byId("warnings").hidden = warnings.length === 0;
        byId("warning-count").textContent = integerFormat.format(warnings.length);
        byId("warning-list").replaceChildren(...warnings.map(warning => element("li", "", warning)));

        function columnOption(column, checked) {
            const label = element("label", "column-option");
            const input = element("input");
            input.type = "checkbox";
            input.value = String(column.index);
            input.checked = checked;
            const name = element("span", "column-name", column.name);
            name.title = column.name;
            label.append(
                input, swatch("column-swatch", column.color), name,
                element("span", "column-kind", typeLabel(column)),
            );
            return label;
        }

        function renderColumnList() {
            const query = search.value.trim().toLowerCase();
            const matches = columns.filter(column =>
                (filter === "all" || column.kind === filter) && column.name.toLowerCase().includes(query)
            );
            if (matches.length) {
                columnList.replaceChildren(...matches.map(column => columnOption(column, selected.has(column.index))));
            } else {
                columnList.replaceChildren(element("p", "list-empty", columns.length ? "没有匹配的列" : "没有可选列"));
            }
        }

        function groupFor(index) {
            return groups.find(group => group.indices.includes(index));
        }

        function renderLegend() {
            const entries = visibleSeries.map(column => {
                const group = groupFor(column.index);
                const domain = lastFrame?.domains.get(column.index);
                const categoryCount = lastFrame?.categoryLevels?.get(column.index)?.length ?? column.categories.length;
                let range = "无数值";
                if (column.kind === "category") {
                    range = `${categoryCount} 种状态`;
                } else if (domain) {
                    range = domain.min === domain.max
                        ? numberFormat.format(domain.min)
                        : `${numberFormat.format(domain.min)} – ${numberFormat.format(domain.max)}`;
                }
                const item = element("div", "legend-item");
                item.append(
                    swatch("legend-swatch", column.color),
                    element("span", "legend-name", column.name),
                    element("span", "legend-range", group ? `${group.name} · ${range}` : range),
                );
                return item;
            });
            byId("chart-legend").replaceChildren(...entries);
        }

        function showHover(info) {
            if (!info) {
                tooltip.hidden = true;
                return;
            }
            const time = element("div", "tooltip-time", labelTime(info.row.time, info.row.time % 1000 !== 0));
            const values = visibleSeries.map(column => {
                const value = info.row.values[column.index];
                const row = element("div", "tooltip-row");
                row.append(
                    swatch("legend-swatch", column.color),
                    element("span", "tooltip-label", column.name),
                    element("span", "tooltip-value", value == null ? "—" : String(value)),
                );
                return row;
            });
            tooltip.replaceChildren(time, ...values);
            tooltip.hidden = false;
            const frame = byId("chart-frame");
            let left = info.x + 14;
            if (left + tooltip.offsetWidth > frame.clientWidth - 8) {
                left = info.x - tooltip.offsetWidth - 14;
            }
            const top = Math.min(info.y + 12, frame.clientHeight - tooltip.offsetHeight - 8);
            tooltip.style.left = `${Math.max(8, left)}px`;
            tooltip.style.top = `${Math.max(8, top)}px`;
        }

        const chart = new window.ChargeChart(byId("chart-canvas"), {
            onFrame(info) {
                lastFrame = info;
                renderLegend();
                byId("zoom-reset").disabled = !info.zoomed;
                byId("zoom-out").disabled = !info.zoomed;
                byId("chart-status").textContent = visibleSeries.length && rows.length
                    ? `${info.relativeScale ? "纵轴按各列范围显示 · " : ""}拖动平移 · 滚轮缩放 · 双击虚线添加标记`
                    : "";
            },
            onHover: showHover,
            onMark: addMarker,
        });

        function refreshChart() {
            visibleSeries = columns.filter(column => selected.has(column.index));
            tooltip.hidden = true;
            byId("selection-count").textContent = `已选 ${integerFormat.format(visibleSeries.length)} 列`;
            byId("clear-selection").disabled = !visibleSeries.length;
            if (byId("chart-selection-label")) {
                byId("chart-selection-label").textContent = `${visibleSeries.length} 条曲线`;
            }
            byId("zoom-in").disabled = !visibleSeries.length || rows.length < 2 || rows[0].time === rows.at(-1).time;
            const heading = emptyChart.querySelector("strong");
            const description = emptyChart.querySelector("p");
            emptyChart.hidden = Boolean(visibleSeries.length && rows.length);
            if (!rows.length) {
                heading.textContent = data.files.length ? "没有可绘制的数据" : `未读取到 ${data.analyzer} 文件`;
                description.textContent = "可在解析提示中查看日志读取情况。";
            } else {
                heading.textContent = "选择要查看的列";
                description.textContent = "在左侧勾选一列或多列，图表将随即更新。";
            }
            chart.update({rows, series: visibleSeries, groups, gaps: data.gaps});
            renderLegend();
        }

        function syncMarkers() {
            markersPanel.hidden = !markerNotes.size;
            chart.setMarkers([...markerNotes.keys()]);
        }

        function addMarker(row) {
            const existing = markerNotes.get(row.time);
            if (existing) {
                existing.focus({preventScroll: true});
                return;
            }

            const item = element("li", "marker-item");
            const timeLabel = labelTime(row.time, row.time % 1000 !== 0);
            const remove = element("button", "marker-remove", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", `删除 ${timeLabel} 的标记`);
            const time = element("time", "marker-time", timeLabel);
            time.dateTime = new Date(row.time).toISOString();
            const note = element("input", "marker-note");
            note.type = "text";
            note.placeholder = "添加备注";
            note.setAttribute("aria-label", `${timeLabel} 的备注`);
            const values = element("div", "marker-values");
            for (const column of visibleSeries) {
                const value = row.values[column.index];
                const valueLabel = element("span", "marker-value");
                valueLabel.append(
                    swatch("legend-swatch", column.color),
                    element("span", "marker-column", column.name),
                    element("span", "marker-reading", value == null ? "—" : String(value)),
                );
                values.append(valueLabel);
            }
            remove.addEventListener("click", () => {
                markerNotes.delete(row.time);
                item.remove();
                syncMarkers();
            });
            item.append(remove, time, note, values);
            markersList.prepend(item);
            markerNotes.set(row.time, note);
            syncMarkers();
            note.focus({preventScroll: true});
        }

        search.addEventListener("input", renderColumnList);
        document.querySelectorAll("[data-filter]").forEach(button => {
            button.addEventListener("click", () => {
                document.querySelector(`[data-filter="${filter}"]`).setAttribute("aria-pressed", "false");
                filter = button.dataset.filter;
                button.setAttribute("aria-pressed", "true");
                renderColumnList();
            });
        });
        columnList.addEventListener("change", event => {
            if (!(event.target instanceof HTMLInputElement)) return;
            const index = Number(event.target.value);
            if (event.target.checked) selected.add(index);
            else selected.delete(index);
            refreshChart();
        });
        byId("clear-selection").addEventListener("click", () => {
            selected.clear();
            renderColumnList();
            refreshChart();
        });
        byId("zoom-in").addEventListener("click", () => chart.zoomBy(1.5));
        byId("zoom-out").addEventListener("click", () => chart.zoomBy(1 / 1.5));
        byId("zoom-reset").addEventListener("click", () => chart.resetZoom());

        renderColumnList();
        refreshChart();
    }

    try {
        initialize(JSON.parse(byId("log-data").textContent));
    } catch (error) {
        const banner = byId("app-error");
        banner.textContent = `无法打开图表：${error.message}`;
        banner.hidden = false;
        console.error(error);
    }
})();
