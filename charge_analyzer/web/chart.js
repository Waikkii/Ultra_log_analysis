(() => {
  "use strict";

  const timeSteps = [
    100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000,
    120000, 300000, 600000, 900000, 1800000, 3600000, 7200000,
    10800000, 21600000, 43200000, 86400000, 172800000, 604800000,
    1209600000, 2592000000, 7776000000, 31536000000,
  ];
  const numberFormat = new Intl.NumberFormat("en", {
    maximumSignificantDigits: 5,
    useGrouping: false,
  });

  function rowIndex(rows, time, afterEqual = false) {
    let first = 0;
    let last = rows.length;
    while (first < last) {
      const mid = Math.floor((first + last) / 2);
      if (rows[mid].time < time || (afterEqual && rows[mid].time === time)) first = mid + 1;
      else last = mid;
    }
    return first;
  }

  function interpolate(start, end, fraction) {
    if (fraction === 0) return start;
    if (fraction === 1) return end;
    const difference = end - start;
    return Number.isFinite(difference)
      ? start + difference * fraction
      : start * (1 - fraction) + end * fraction;
  }

  function axisFraction(value, min, max) {
    if (min === max) return 0.5;
    if (!Number.isFinite(max - min)) return (value / 2 - min / 2) / (max / 2 - min / 2);
    return (value - min) / (max - min);
  }

  function formatNumber(value, precision = 5) {
    const absolute = Math.abs(value);
    if (absolute >= 1e7 || (absolute > 0 && absolute < 0.001)) {
      return value.toExponential(precision - 1).replace(/\.?0+(e[+-]\d+)$/, "$1");
    }
    if (precision > 5) return Number(value.toPrecision(precision)).toString();
    return numberFormat.format(Object.is(value, -0) ? 0 : value);
  }

  function ellipsize(context, label, width) {
    if (context.measureText(label).width <= width) return label;
    let first = 0;
    let last = label.length - 1;
    while (first < last) {
      const mid = Math.ceil((first + last) / 2);
      if (context.measureText(label.slice(0, mid) + "…").width > width) last = mid - 1;
      else first = mid;
    }
    return label.slice(0, first) + "…";
  }

  class ChargeChart {
    constructor(canvas, { onFrame, onHover } = {}) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      this.frame = document.createElement("canvas");
      this.frameContext = this.frame.getContext("2d");
      this.onFrame = onFrame;
      this.onHover = onHover;
      this.rows = [];
      this.series = [];
      this.groups = [];
      this.axes = new Map();
      this.totalStart = this.start = 0;
      this.totalEnd = this.end = 1000;
      this.pointer = null;
      this.hoverRow = null;
      this.drag = null;
      this.pending = false;
      this.needsFrame = false;

      if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
      this.resizeObserver = new ResizeObserver(() => this.schedule(true));
      this.resizeObserver.observe(canvas);
      window.addEventListener("resize", () => this.schedule(true));
      canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
      canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
      canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
      canvas.addEventListener("pointercancel", (event) => this.pointerUp(event, true));
      canvas.addEventListener("lostpointercapture", (event) => this.pointerUp(event));
      canvas.addEventListener("pointerleave", () => {
        if (this.drag) return;
        this.pointer = null;
        this.schedule();
      });
      canvas.addEventListener("dblclick", () => this.resetZoom());
      canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
      canvas.addEventListener("keydown", (event) => this.keyDown(event));
    }

    update({ rows = [], series = [], groups = [] } = {}) {
      if (rows !== this.rows) {
        this.rows = rows;
        this.totalStart = rows[0]?.time ?? 0;
        this.totalEnd = rows.at(-1)?.time ?? 1000;
        if (this.totalStart === this.totalEnd) {
          this.totalStart -= 500;
          this.totalEnd += 500;
        }
        this.start = this.totalStart;
        this.end = this.totalEnd;
      }
      this.series = series;
      this.groups = groups;
      this.schedule(true);
    }

    resetZoom() {
      this.setRange(this.totalStart, this.totalEnd - this.totalStart);
    }

    zoomBy(factor, anchor = 0.5) {
      if (!this.rows.length || !Number.isFinite(factor) || factor <= 0) return;
      const span = this.end - this.start;
      const fullSpan = this.totalEnd - this.totalStart;
      const newSpan = Math.min(fullSpan, Math.max(Math.min(1000, fullSpan), span / factor));
      this.setRange(this.start + (span - newSpan) * anchor, newSpan);
    }

    panBy(fraction) {
      const span = this.end - this.start;
      this.setRange(this.start + span * fraction, span);
    }

    setRange(start, span) {
      const boundedStart = Math.max(this.totalStart, Math.min(this.totalEnd - span, start));
      const boundedEnd = boundedStart + span;
      if (boundedStart === this.start && boundedEnd === this.end) return;
      this.start = boundedStart;
      this.end = boundedEnd;
      this.schedule(true);
    }

    get zoomed() {
      return this.start > this.totalStart || this.end < this.totalEnd;
    }

    schedule(redraw = false) {
      this.needsFrame = this.needsFrame || redraw;
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        if (this.needsFrame) {
          this.needsFrame = false;
          this.drawFrame();
        }
        this.drawOverlay();
      });
    }

    pointerLocation(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    contains({ x, y }) {
      const plot = this.plot;
      return plot && x >= plot.left && x <= plot.right && y >= plot.top && y <= plot.bottom;
    }

    pointerDown(event) {
      if (event.button !== 0 || this.drag || !this.zoomed) return;
      const pointer = this.pointerLocation(event);
      if (!this.contains(pointer)) return;
      this.drag = { id: event.pointerId, x: pointer.x, start: this.start, end: this.end };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = "grabbing";
      this.schedule();
    }

    pointerMove(event) {
      this.pointer = this.pointerLocation(event);
      if (this.drag?.id === event.pointerId) {
        const span = this.drag.end - this.drag.start;
        const change = ((this.drag.x - this.pointer.x) / this.plot.width) * span;
        this.setRange(this.drag.start + change, span);
      }
      this.schedule();
    }

    pointerUp(event, cancelled = false) {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = null;
      this.canvas.style.cursor = "";
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (cancelled || event.pointerType === "touch") this.pointer = null;
      this.schedule();
    }

    wheel(event) {
      const pointer = this.pointerLocation(event);
      if (!this.contains(pointer) || !this.rows.length || !this.series.length) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      const factor = Math.exp(-Math.max(-1200, Math.min(1200, pixels)) * 0.002);
      this.pointer = pointer;
      this.zoomBy(factor, (pointer.x - this.plot.left) / this.plot.width);
      this.schedule();
    }

    keyDown(event) {
      switch (event.key) {
        case "+":
        case "=": this.zoomBy(1.5); break;
        case "-": this.zoomBy(1 / 1.5); break;
        case "ArrowLeft": this.panBy(-0.2); break;
        case "ArrowRight": this.panBy(0.2); break;
        case "Home": this.resetZoom(); break;
        default: return;
      }
      event.preventDefault();
    }

    visiblePoints(series, visit) {
      const { rows, start, end, firstVisible, afterVisible } = this;
      const boundary = (time, nextIndex) => {
        const before = rows[nextIndex - 1];
        const next = rows[nextIndex];
        if (!before || !next || before.time >= time || next.time <= time) return;
        const from = before.values[series.index];
        const to = next.values[series.index];
        if (from == null || to == null) return;
        const value = series.kind === "category"
          ? from
          : interpolate(from, to, (time - before.time) / (next.time - before.time));
        visit(time, value);
      };

      boundary(start, firstVisible);
      for (let index = firstVisible; index < afterVisible; index += 1) {
        const row = rows[index];
        visit(row.time, row.values[series.index]);
      }
      boundary(end, afterVisible);
    }

    buildAxes() {
      const selected = new Map(this.series.map((series) => [series.index, series]));
      const axes = new Map();
      const addAxis = (members, groupCategories = []) => {
        const kind = members[0].kind;
        const axis = { kind, color: members[0].color, domain: null, categories: [], levels: new Map() };
        if (kind === "number") {
          let min = Infinity;
          let max = -Infinity;
          const include = (_time, value) => {
            if (!Number.isFinite(value)) return;
            min = Math.min(min, value);
            max = Math.max(max, value);
          };
          for (const member of members) this.visiblePoints(member, include);
          if (min !== Infinity) axis.domain = { min, max };
        } else {
          const unique = new Set(groupCategories);
          for (const member of members) {
            for (const label of member.categories ?? []) unique.add(label);
          }
          axis.categories = [...unique];
          axis.levels = new Map(axis.categories.map((label, index) => [label, index]));
        }
        for (const member of members) axes.set(member.index, axis);
      };

      for (const group of this.groups) {
        const members = group.indices.map((index) => selected.get(index)).filter(Boolean);
        if (!members.length || members.some((member) => axes.has(member.index) || member.kind !== members[0].kind)) continue;
        addAxis(members, group.categories);
      }
      for (const series of this.series) {
        if (!axes.has(series.index)) addAxis([series]);
      }
      return axes;
    }

    drawFrame() {
      const { canvas, frame, frameContext: ctx } = this;
      const { width, height } = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      this.width = width;
      this.height = height;
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * this.pixelRatio);
      const pixelHeight = Math.round(height * this.pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      if (frame.width !== pixelWidth || frame.height !== pixelHeight) {
        frame.width = pixelWidth;
        frame.height = pixelHeight;
      }

      const css = getComputedStyle(canvas);
      const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      this.style = {
        grid: token("--chart-grid", "#e7edf4"),
        strong: token("--chart-grid-strong", "#d5e0ed"),
        text: token("--chart-text", "#52637a"),
        crosshair: token("--chart-crosshair", "#93a4ba"),
        font: token("--chart-font", "system-ui, sans-serif"),
      };
      this.plot = { left: 13, right: width - 13, top: 20, bottom: height - 37, height: height - 57 };
      this.firstVisible = rowIndex(this.rows, this.start);
      this.afterVisible = rowIndex(this.rows, this.end, true);
      this.axes = this.buildAxes();
      const uniqueAxes = [...new Set(this.axes.values())];

      ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `11px ${this.style.font}`;
      const axisLayouts = this.layoutAxes(uniqueAxes);

      if (this.plot.width > 0 && this.plot.height > 0) {
        this.drawAxes(axisLayouts);
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.plot.left - 3, this.plot.top - 3, this.plot.width + 6, this.plot.height + 6);
        ctx.clip();
        let hasPoints = false;
        for (const series of this.series) {
          if (this.drawSeries(series)) hasPoints = true;
        }
        ctx.restore();

        if (!hasPoints && this.rows.length && this.series.length) {
          ctx.font = `13px ${this.style.font}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = this.style.text;
          ctx.fillText("当前时间范围内没有数据", (this.plot.left + this.plot.right) / 2, (this.plot.top + this.plot.bottom) / 2);
        }
      }

      const domains = new Map();
      const categoryLevels = new Map();
      for (const [index, axis] of this.axes) {
        if (axis.domain) domains.set(index, axis.domain);
        if (axis.kind === "category") categoryLevels.set(index, axis.categories);
      }
      this.onFrame?.({
        domains, categoryLevels, start: this.start, end: this.end, zoomed: this.zoomed,
        totalStart: this.totalStart, totalEnd: this.totalEnd, relativeScale: axisLayouts[0].relative,
      });
    }

    axisTicks(axis, relative = false) {
      const numericDomain = axis?.domain;
      const defaultTicks = [0, 0.25, 0.5, 0.75, 1];

      if (numericDomain && numericDomain.min !== numericDomain.max) {
        const { min, max } = numericDomain;
        const gap = (max - min) / 4;
        const digits = Math.ceil(Math.log10(Math.max(Math.abs(min), Math.abs(max))) - Math.log10(gap)) + 1;
        const precision = Math.min(17, Math.max(5, digits));
        return defaultTicks.map((fraction) => ({
          fraction,
          label: formatNumber(interpolate(min, max, fraction), precision),
        }));
      }
      if (numericDomain) return [{ fraction: 0.5, label: formatNumber(numericDomain.min) }];
      if (axis?.categories.length) {
        const last = axis.categories.length - 1;
        const stride = Math.max(1, Math.ceil(last / Math.max(1, Math.floor(this.plot.height / 37))));
        const ticks = [];
        for (let index = 0; index < last; index += stride) {
          if (index !== 0 && last - index < stride / 2) break;
          ticks.push({ fraction: axisFraction(index, 0, last), label: axis.categories[index] });
        }
        ticks.push({ fraction: axisFraction(last, 0, last), label: axis.categories[last] });
        return ticks;
      }
      return defaultTicks.map((fraction) => ({
        fraction, label: relative ? `${Math.round(fraction * 100)}%` : "",
      }));
    }

    layoutAxes(axes) {
      const { frameContext: ctx, plot, width } = this;
      const maximumWidth = axes.length > 1 ? 115 : Math.max(42, width * 0.26);
      const makeLayout = (axis, index, relative = false) => {
        const ticks = this.axisTicks(axis, relative);
        const labelWidth = Math.max(0, ...ticks.map(({ label }) => ctx.measureText(label).width));
        return {
          width: Math.min(maximumWidth, Math.max(30, Math.ceil(labelWidth) + 13)),
          direction: index % 2 === 0 ? -1 : 1,
          color: axis?.color ?? this.style.text,
          ticks,
          relative,
        };
      };
      let layouts = axes.length > 4 ? [] : axes.map((axis, index) => makeLayout(axis, index));
      const combinedWidth = layouts.reduce((sum, layout) => sum + layout.width, 0);
      if (!layouts.length || (axes.length > 1 && plot.right - plot.left - combinedWidth < Math.max(198, width * 0.58))) {
        layouts = [makeLayout(null, 0, axes.length > 1)];
      }
      for (const layout of layouts) {
        if (layout.direction < 0) plot.left += layout.width;
        else plot.right -= layout.width;
      }
      plot.width = plot.right - plot.left;

      let left = plot.left;
      let right = plot.right;
      for (const layout of layouts) {
        if (layout.direction < 0) {
          layout.x = left;
          left -= layout.width;
        } else {
          layout.x = right;
          right += layout.width;
        }
      }
      return layouts;
    }

    drawAxes(layouts) {
      const ctx = this.frameContext;
      const { left, right, top, bottom, width, height } = this.plot;
      const drawY = (fraction) => bottom - fraction * height;

      ctx.lineWidth = 1;
      ctx.fillStyle = this.style.text;
      ctx.strokeStyle = this.style.grid;
      ctx.beginPath();
      const gridFractions = layouts[0].ticks.length > 1
        ? layouts[0].ticks.map(({ fraction }) => fraction)
        : [0, 0.25, 0.5, 0.75, 1];
      for (const fraction of gridFractions) {
        const y = Math.round(drawY(fraction)) + 0.5;
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
      }
      ctx.stroke();

      if (this.rows.length) {
        const span = this.end - this.start;
        const multipleDays = Math.floor(this.start / 86400000) !== Math.floor(this.end / 86400000);
        const spacing = multipleDays ? 123 : 82;
        const targetStep = span / Math.max(1, Math.floor(width / spacing));
        const step = timeSteps.find((candidate) => candidate >= targetStep) ?? targetStep;
        const ticks = [];
        for (let time = Math.ceil(this.start / step) * step; time <= this.end; time += step) ticks.push(time);
        if (!ticks.length) ticks.push((this.start + this.end) / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.beginPath();
        for (const time of ticks) {
          const x = this.x(time);
          ctx.moveTo(Math.round(x) + 0.5, top);
          ctx.lineTo(Math.round(x) + 0.5, bottom);
          const iso = new Date(time).toISOString();
          let label = iso.slice(11, 19);
          if (span >= 86400000 * 3) label = iso.slice(0, 10);
          else if (multipleDays) label = iso.slice(5, 10) + " " + label;
          else if (step < 1000) label = iso.slice(11, 23);
          const labelWidth = ctx.measureText(label).width;
          const labelX = Math.max(left - 5, Math.min(right - labelWidth + 2, x - labelWidth / 2));
          ctx.fillText(label, labelX, bottom + 10);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = this.style.strong;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(bottom) + 0.5);
      ctx.lineTo(right, Math.round(bottom) + 0.5);
      ctx.stroke();

      ctx.textBaseline = "middle";
      for (const layout of layouts) {
        const { x, color, direction, ticks } = layout;
        const axisX = Math.round(x) + 0.5;
        ctx.textAlign = direction < 0 ? "right" : "left";
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(axisX, top);
        ctx.lineTo(axisX, bottom);
        for (const { fraction, label } of ticks) {
          if (!label) continue;
          const y = Math.round(drawY(fraction)) + 0.5;
          ctx.moveTo(axisX, y);
          ctx.lineTo(axisX + direction * 4, y);
          ctx.fillText(ellipsize(ctx, label, layout.width - 9), axisX + direction * 8, y);
        }
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    x(time) {
      return this.plot.left + ((time - this.start) / (this.end - this.start)) * this.plot.width;
    }

    y(index, value) {
      if (value == null) return null;
      const axis = this.axes.get(index);
      let fraction;
      if (axis.kind === "category") {
        const level = axis.levels.get(value);
        if (level === undefined) return null;
        fraction = axisFraction(level, 0, axis.categories.length - 1);
      } else {
        if (!axis.domain || !Number.isFinite(value)) return null;
        fraction = axisFraction(value, axis.domain.min, axis.domain.max);
      }
      return this.plot.bottom - fraction * this.plot.height;
    }

    drawSeries(series) {
      const ctx = this.frameContext;
      const isCategory = series.kind === "category";
      const singletons = [];
      let hasPoints = false;
      let count = 0;
      let lastX = 0;
      let lastY = 0;
      let bucket = null;

      const flushBucket = () => {
        if (!bucket) return;
        const points = [bucket.first, bucket.upper, bucket.lower, bucket.last];
        points.sort((left, right) => left.order - right.order);
        let previous = -1;
        for (const point of points) {
          if (point.order === previous) continue;
          ctx.lineTo(point.x, point.y);
          previous = point.order;
        }
        bucket = null;
      };

      const finishRun = () => {
        if (count === 1) singletons.push([lastX, lastY]);
        else if (count > 1 && isCategory) ctx.lineTo(lastX, lastY);
        flushBucket();
        count = 0;
      };

      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = series.color;
      ctx.beginPath();
      this.visiblePoints(series, (time, value) => {
        const y = this.y(series.index, value);
        if (y === null) {
          finishRun();
          return;
        }
        hasPoints = true;
        const x = this.x(time);
        if (!count) {
          ctx.moveTo(x, y);
        } else if (isCategory) {
          if (y !== lastY) {
            ctx.lineTo(x, lastY);
            ctx.lineTo(x, y);
          }
        } else {
          const column = Math.floor(x);
          const point = { x, y, order: count };
          if (column !== bucket?.column) {
            flushBucket();
            bucket = { column, first: point, last: point, upper: point, lower: point };
          } else {
            bucket.last = point;
            if (y < bucket.upper.y) bucket.upper = point;
            if (y > bucket.lower.y) bucket.lower = point;
          }
        }
        count += 1;
        lastX = x;
        lastY = y;
      });
      finishRun();
      ctx.stroke();

      ctx.fillStyle = series.color;
      ctx.beginPath();
      for (const [x, y] of singletons) {
        ctx.moveTo(x + 2.8, y);
        ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      }
      ctx.fill();
      return hasPoints;
    }

    drawOverlay() {
      if (!this.style) return;
      const ctx = this.context;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.frame, 0, 0);

      const pointer = this.pointer;
      if (!pointer || this.drag || !this.contains(pointer) || !this.series.length || this.firstVisible === this.afterVisible) {
        if (this.hoverRow !== null) this.onHover?.(null);
        this.hoverRow = null;
        return;
      }
      const time = this.start + ((pointer.x - this.plot.left) / this.plot.width) * (this.end - this.start);
      let index = Math.min(this.afterVisible - 1, rowIndex(this.rows, time));
      if (index > this.firstVisible && time - this.rows[index - 1].time <= this.rows[index].time - time) index -= 1;
      const row = this.rows[index];
      const x = this.x(row.time);

      ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      ctx.strokeStyle = this.style.crosshair;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, this.plot.top);
      ctx.lineTo(Math.round(x) + 0.5, this.plot.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const series of this.series) {
        const y = this.y(series.index, row.values[series.index]);
        if (y === null) continue;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      this.hoverRow = row;
      this.onHover?.({ row, x, y: pointer.y });
    }
  }

  window.ChargeChart = ChargeChart;
})();
