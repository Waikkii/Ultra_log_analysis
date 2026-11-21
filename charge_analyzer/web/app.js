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

    function setupTitle(defaultTitle, defaultTabTitle) {
        const heading = byId("app-title");
        const dialog = byId("title-dialog");
        const input = byId("title-input");
        const storageKey = `ultra-log-analysis:title:${location.pathname}`;
        let custom = "";
        try {
            custom = localStorage.getItem(storageKey) ?? "";
        } catch {
            // Some browsers block storage for local HTML reports.
        }

        function render() {
            heading.textContent = custom || defaultTitle;
            document.title = custom || defaultTabTitle;
        }

        byId("title-edit").addEventListener("click", () => {
            input.value = custom || defaultTitle;
            dialog.showModal();
            input.select();
        });
        byId("title-cancel").addEventListener("click", () => dialog.close());
        byId("title-form").addEventListener("submit", event => {
            event.preventDefault();
            custom = input.value.trim();
            try {
                if (custom) localStorage.setItem(storageKey, custom);
                else localStorage.removeItem(storageKey);
            } catch {
                // The title still applies to the open page.
            }
            render();
            dialog.close();
        });
        render();
    }

    function sourceCellWidth(value) {
        const text = String(value ?? "");
        if (/^[\x20-\x7e]*$/.test(text)) return text.length;
        let width = 0;
        for (const character of text) {
            width += character === "\t" ? 4 : (character.codePointAt(0) > 127 ? 2 : 1);
        }
        return width;
    }

    function sourceColumnWidths(source) {
        if (source.widths) return source.widths;
        const widths = source.headers.map(sourceCellWidth);
        for (const row of source.rows) {
            for (let index = 0; index < widths.length; index += 1) {
                widths[index] = Math.max(widths[index], sourceCellWidth(row[index]));
            }
        }
        return widths;
    }

    function setSourceColumnWidths(table, source) {
        const widths = sourceColumnWidths(source);
        const columns = element("colgroup");
        for (const width of widths) {
            const column = element("col");
            column.style.width = `calc(${width}ch + 21px)`;
            columns.append(column);
        }
        const width = widths.reduce((total, value) => total + value, 0);
        table.style.width = `calc(${width}ch + ${widths.length * 21}px)`;
        table.prepend(columns);
    }

    function addSourceRow(body, width) {
        const row = body.insertRow();
        const cells = [];
        for (let index = 0; index < width; index += 1) {
            const cell = element(index === 0 ? "th" : "td");
            if (index === 0) cell.scope = "row";
            const text = document.createTextNode("");
            cell.append(text);
            row.append(cell);
            cells.push(text);
        }
        return {row, cells};
    }

    function fillSourceRow(cells, values) {
        for (let index = 0; index < cells.length; index += 1) {
            const value = String(values[index] ?? "");
            if (cells[index].data !== value) cells[index].data = value;
        }
    }

    function addSourceSpacer(body, width) {
        const row = body.insertRow();
        row.className = "source-spacer";
        row.setAttribute("aria-hidden", "true");
        row.insertCell().colSpan = width;
        return row;
    }

    function sourceWindow(source, chunks, first, count) {
        if (!source.chunk_ids) return source.rows.slice(first, first + count);
        const {chunk_size: size, chunk_ids: ids} = source;
        const start = Math.floor(first / size);
        const end = Math.floor((first + count - 1) / size);
        for (const index of chunks.keys()) {
            if (index < start || index > end) chunks.delete(index);
        }
        for (let index = start; index <= end; index += 1) {
            if (!chunks.has(index)) {
                const payload = byId(`source-chunk-${ids[index]}`);
                chunks.set(index, JSON.parse(payload.textContent));
            }
        }
        return Array.from({length: count}, (_, offset) => {
            const row = first + offset;
            const values = chunks.get(Math.floor(row / size))[row % size];
            if (!Array.isArray(values)) throw new Error("Invalid source preview row");
            return values;
        });
    }

    function virtualizeSourceRows(content, status, table, body, source, position, isOpen) {
        const chunked = Boolean(source.chunk_ids);
        const rowCount = source.row_count ?? source.rows.length;
        const chunks = new Map();
        const style = getComputedStyle(content);
        const height = Number.parseFloat(style.getPropertyValue("--source-row-height"));
        const maxHeight = Number.parseFloat(style.getPropertyValue("--source-preview-max-height"));
        const overscan = chunked ? 4 : 8;
        const poolSize = Math.min(rowCount, Math.ceil(maxHeight / height) + 1 + 2 * overscan);
        table.classList.add("is-virtual");
        table.setAttribute("aria-rowcount", String(rowCount + 1));
        table.tHead.rows[0].setAttribute("aria-rowindex", "1");
        setSourceColumnWidths(table, source);

        const top = addSourceSpacer(body, source.headers.length);
        const pool = Array.from({length: poolSize}, () => addSourceRow(body, source.headers.length));
        const bottom = addSourceSpacer(body, source.headers.length);
        let first = -1;
        let displayed = 0;
        let frame = 0;
        let timer = 0;

        function setSpacer(row, rowCount) {
            row.hidden = rowCount === 0;
            row.style.height = `${rowCount * height}px`;
        }

        function setStatus(message, busy = false) {
            if (status.textContent === message) return;
            status.textContent = message;
            status.hidden = !message;
            content.setAttribute("aria-busy", String(busy));
            table.classList.toggle("is-pending", Boolean(message));
        }

        function visibleRows() {
            const scroll = content.scrollTop;
            const start = Math.max(0, Math.min(rowCount - 1, Math.floor(scroll / height)));
            const end = Math.min(rowCount, Math.max(start + 1, Math.ceil((scroll + content.clientHeight) / height) - 1));
            return {start, end};
        }

        function render() {
            frame = 0;
            timer = 0;
            if (!isOpen()) return;
            const {start, end} = visibleRows();
            const last = first + displayed;
            if (!chunked && first >= 0 &&
                (first === 0 || start >= first + overscan / 2) &&
                (last === rowCount || end <= last - overscan / 2)) return;
            let next = Math.min(Math.max(0, start - overscan), rowCount - poolSize);
            let count = poolSize;
            if (chunked) {
                // Buffer nearby rows only within chunks the visible window needs.
                const {chunk_size: size} = source;
                next = Math.max(start - overscan, Math.floor(start / size) * size);
                const after = Math.min(end + overscan, Math.ceil(end / size) * size, rowCount);
                count = after - next;
            }
            if (next === first && count === displayed) {
                setStatus("");
                return;
            }
            let values;
            try {
                values = sourceWindow(source, chunks, next, count);
            } catch {
                setStatus("无法读取当前行");
                return;
            }
            first = next;
            displayed = count;
            setSpacer(top, first);
            for (const [offset, entry] of pool.entries()) {
                entry.row.hidden = offset >= count;
                if (entry.row.hidden) {
                    entry.row.removeAttribute("data-row");
                    fillSourceRow(entry.cells, []);
                    continue;
                }
                const index = first + offset;
                entry.row.dataset.row = String(index);
                entry.row.classList.toggle("is-striped", index % 2 === 1);
                entry.row.setAttribute("aria-rowindex", String(index + 2));
                fillSourceRow(entry.cells, values[offset]);
            }
            setSpacer(bottom, rowCount - first - displayed);
            setStatus("");
        }

        setSpacer(top, 0);
        setSpacer(bottom, rowCount);
        for (const {row} of pool) row.hidden = true;
        content.scrollTop = position.top;
        content.scrollLeft = position.left;
        let lastTop = content.scrollTop;
        let viewportHeight = content.clientHeight;

        function queueFrame() {
            if (!frame) frame = requestAnimationFrame(render);
        }

        function scroll() {
            if (!isOpen() || lastTop === content.scrollTop) return;
            lastTop = content.scrollTop;
            if (chunked) {
                cancelAnimationFrame(frame);
                frame = 0;
                clearTimeout(timer);
                timer = 0;
                const {start, end} = visibleRows();
                if (start >= first && end <= first + displayed) {
                    setStatus("");
                } else {
                    setStatus("正在加载当前行…", true);
                    timer = window.setTimeout(render, 80);
                }
            } else {
                queueFrame();
            }
        }

        const observer = chunked ? new ResizeObserver(() => {
            if (!isOpen() || viewportHeight === content.clientHeight) return;
            viewportHeight = content.clientHeight;
            if (!timer) queueFrame();
        }) : null;
        observer?.observe(content);
        content.addEventListener("scroll", scroll, {passive: true});
        if (chunked) setStatus("正在加载当前行…", true);
        queueFrame();

        return () => {
            observer?.disconnect();
            content.removeEventListener("scroll", scroll);
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            chunks.clear();
            setStatus("");
        };
    }

    function sourceFileEntry(name, tables, section) {
        const source = tables?.[name];
        const item = element("li");
        const details = element("details", "source-file");
        const summary = element("summary", "source-file-name");
        summary.append(element("span", "source-filename", name));
        const range = element("span", "source-file-range");
        if (Number.isFinite(source?.start) && Number.isFinite(source?.end)) {
            const start = element("time", "", labelTime(source.start, source.start % 1000 !== 0));
            const end = element("time", "", labelTime(source.end, source.end % 1000 !== 0));
            start.dateTime = new Date(source.start).toISOString();
            end.dateTime = new Date(source.end).toISOString();
            range.append(start, " – ", end);
        } else {
            range.textContent = "无有效时间";
        }
        summary.append(range);
        const content = element("div", "source-file-content");
        content.tabIndex = 0;
        content.setAttribute("role", "region");
        content.setAttribute("aria-label", `${name} 原始内容`);
        const status = element("p", "source-preview-status");
        status.setAttribute("role", "status");
        status.hidden = true;
        const preview = element("div", "source-preview");
        preview.append(content, status);
        details.append(summary, preview);
        item.append(details);

        const position = {top: 0, left: 0};
        const isOpen = () => details.open && section.open;
        let dispose;
        content.addEventListener("scroll", () => {
            if (isOpen() && content.firstElementChild && content.clientHeight > 0) {
                position.top = content.scrollTop;
                position.left = content.scrollLeft;
            }
        }, {passive: true});

        function populate() {
            const rowCount = source?.row_count ?? source?.rows?.length ?? 0;
            if (!rowCount && !source?.headers.length) {
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
                content.append(table);
                if (source.chunk_ids || rowCount > 100) {
                    dispose = virtualizeSourceRows(content, status, table, body, source, position, isOpen);
                } else {
                    for (const values of source.rows) {
                        const {cells} = addSourceRow(body, source.headers.length);
                        fillSourceRow(cells, values);
                    }
                    content.scrollTop = position.top;
                    content.scrollLeft = position.left;
                }
            }
        }

        function sync() {
            if (isOpen()) {
                if (!content.firstChild) populate();
            } else if (content.firstChild) {
                dispose?.();
                dispose = undefined;
                content.replaceChildren();
            }
        }

        details.addEventListener("toggle", sync);
        return {item, sync};
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
        const markersEmpty = byId("markers-empty");
        const markersList = byId("markers-list");
        const markerNotes = new Map();

        const folderParts = data.folder.split(/[\\/]+/).filter(Boolean);
        const folderName = folderParts.at(-1) ?? data.folder;
        byId("folder-name").textContent = folderName;
        if (byId("folder-path")) byId("folder-path").textContent = data.folder;
        byId("analyzer-name").textContent = data.analyzer;
        setupTitle(data.title, `${data.analyzer} · ${folderName}`);
        byId("file-count").textContent = integerFormat.format(data.files.length);
        byId("row-count").textContent = integerFormat.format(rows.length);
        const timeRange = byId("time-range");
        if (rows.length) {
            const start = labelTime(rows[0].time);
            const end = labelTime(rows.at(-1).time);
            timeRange.textContent = start.slice(0, 10) === end.slice(0, 10)
                ? `${start} – ${end.slice(11)}`
                : `${start} – ${end}`;
        }
        const sourceSection = byId("files");
        sourceSection.hidden = data.files.length === 0;
        const entries = data.files.map(name => sourceFileEntry(name, data.source_tables, sourceSection));
        byId("files-list").replaceChildren(...entries.map(entry => entry.item));
        sourceSection.addEventListener("toggle", () => {
            for (const {sync} of entries) sync();
        });
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
            markersEmpty.hidden = markerNotes.size > 0;
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
