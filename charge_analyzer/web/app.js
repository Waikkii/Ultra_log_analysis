(() => {
    "use strict";

    const byId = id => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat("zh-CN", {maximumSignificantDigits: 10});
    const integerFormat = new Intl.NumberFormat("zh-CN");
    const seriesColors = [
        "#147d83", "#5c61c9", "#c66c23", "#a23d73", "#3769bd",
        "#3c8434", "#bd4540", "#77602c", "#1681ad", "#8459a2",
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

    function sourceFileEntry(name, contents) {
        const item = element("li");
        const details = element("details", "source-file");
        const summary = element("summary", "source-file-name", name);
        const content = element("pre", "source-file-content");
        content.tabIndex = 0;
        content.setAttribute("role", "region");
        content.setAttribute("aria-label", `${name} 原始内容`);
        details.append(summary, content);
        item.append(details);

        function populate() {
            if (!details.open) return;
            const text = contents?.[name];
            content.textContent = typeof text === "string" ? text || "文件为空" : "源文件内容不可用";
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
        const defaults = columns.filter(column => column.kind === "number").slice(0, 3);
        const firstCategory = columns.find(column => column.kind === "category");
        if (firstCategory) defaults.push(firstCategory);
        const selected = new Set(defaults.map(column => column.index));
        const groups = [];
        let filter = "all";
        let editingGroup = -1;
        let visibleSeries = [];
        let lastFrame;
        const search = byId("column-search");
        const columnList = byId("column-list");
        const emptyChart = byId("chart-empty");
        const tooltip = byId("chart-tooltip");
        const groupDialog = byId("group-dialog");
        const groupName = byId("group-name");
        const groupColumns = byId("group-columns");
        const groupSave = byId("group-save");
        const groupError = byId("group-error");

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
        byId("files-list").replaceChildren(...data.files.map(name => sourceFileEntry(name, data.source_contents)));
        byId("warnings").hidden = data.warnings.length === 0;
        byId("warning-count").textContent = integerFormat.format(data.warnings.length);
        byId("warning-list").replaceChildren(...data.warnings.map(warning => element("li", "", warning)));

        function columnOption(column, checked, disabled = false) {
            const label = element("label", "column-option");
            const input = element("input");
            input.type = "checkbox";
            input.value = String(column.index);
            input.checked = checked;
            input.disabled = disabled;
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
                    ? `${info.relativeScale ? "纵轴按各列范围显示 · " : ""}拖动平移 · 滚轮缩放 · 悬停读数`
                    : "";
            },
            onHover: showHover,
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
            chart.update({rows, series: visibleSeries, groups});
            renderLegend();
        }

        function clearGroupError() {
            groupError.hidden = true;
            groupError.textContent = "";
        }

        function groupErrorMessage(message) {
            groupError.textContent = message;
            groupError.hidden = false;
        }

        function renderGroupOptions(indices) {
            const elsewhere = new Set(groups.flatMap((group, index) => index === editingGroup ? [] : group.indices));
            groupColumns.replaceChildren(...columns.map(column => {
                const option = columnOption(column, indices.includes(column.index), elsewhere.has(column.index));
                if (elsewhere.has(column.index)) option.title = `已属于 ${groupFor(column.index).name}`;
                return option;
            }));
            groupSave.disabled = columns.length < 2;
        }

        function showGroupForm(index) {
            editingGroup = index;
            const group = groups[index];
            groupName.value = group?.name ?? "";
            groupSave.textContent = group ? "保存修改" : "添加分组";
            renderGroupOptions(group?.indices ?? []);
            clearGroupError();
        }

        function renderGroups() {
            const list = byId("group-list");
            byId("group-open").disabled = columns.length < 2;
            const badge = byId("group-count");
            if (badge) badge.textContent = String(groups.length);
            const items = groups.map((group, index) => {
                const info = element("div", "");
                info.append(element("strong", "", group.name), element("p", "", group.indices.map(i => columns[i].name).join("、")));
                const edit = element("button", "button button-quiet", "编辑");
                edit.type = "button";
                edit.addEventListener("click", () => {
                    showGroupForm(index);
                    groupName.focus();
                });
                const remove = element("button", "button button-danger", "删除");
                remove.type = "button";
                remove.addEventListener("click", () => {
                    groups.splice(index, 1);
                    renderGroups();
                    showGroupForm(-1);
                    refreshChart();
                });
                const actions = element("div", "group-actions");
                actions.append(edit, remove);
                const item = element("div", "group-item");
                item.append(info, actions);
                return item;
            });
            list.replaceChildren(...(items.length ? items : [element("p", "list-empty", "暂无纵轴分组")]));
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
        byId("group-open").addEventListener("click", () => {
            showGroupForm(-1);
            groupDialog.showModal();
        });
        byId("group-close").addEventListener("click", () => groupDialog.close());
        groupName.addEventListener("input", clearGroupError);
        groupColumns.addEventListener("change", clearGroupError);
        byId("group-form").addEventListener("submit", event => {
            event.preventDefault();
            const name = groupName.value.trim();
            const indices = [...groupColumns.querySelectorAll("input:checked")].map(input => Number(input.value));
            if (!name) return groupErrorMessage("请输入分组名称。");
            if (groups.some((group, index) => index !== editingGroup && group.name === name)) {
                return groupErrorMessage("这个分组名称已存在。");
            }
            if (indices.length < 2) return groupErrorMessage("请至少选择两列。");
            if (new Set(indices.map(index => columns[index].kind)).size !== 1) {
                return groupErrorMessage("同一分组中的列须同为数值或同为文字。");
            }
            const group = {name, indices};
            if (columns[indices[0]].kind === "category") {
                group.categories = [...new Set(indices.flatMap(index => columns[index].categories))];
            }
            if (editingGroup < 0) groups.push(group);
            else groups[editingGroup] = group;
            renderGroups();
            showGroupForm(-1);
            refreshChart();
        });
        byId("zoom-in").addEventListener("click", () => chart.zoomBy(1.5));
        byId("zoom-out").addEventListener("click", () => chart.zoomBy(1 / 1.5));
        byId("zoom-reset").addEventListener("click", () => chart.resetZoom());

        renderColumnList();
        renderGroups();
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
