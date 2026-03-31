"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import DataViewCategorical = powerbi.DataViewCategorical;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionId = powerbi.visuals.ISelectionId;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import VisualUpdateType = powerbi.VisualUpdateType;

import { VisualFormattingSettingsModel, SeriesColorsCard } from "./settings";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

// ── Types ──────────────────────────────────────────────────────────

interface ChartDataPoint {
    category: string;
    selectionId: ISelectionId;
    columnValues: { name: string; value: number; color: string; format: string }[];
    lineValues: { name: string; value: number; color: string; format: string }[];
    tooltipValues: { name: string; value: number; format: string }[];
}

interface SeriesInfo {
    name: string;
    color: string;
    type: "column" | "line";
}

type AnimationStyle = "growUp" | "fadeIn" | "spring" | "slideLeft" | "bounce" | "expandCenter" | "none";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_COLUMN_COLORS = ["#4682B4", "#5B9BD5", "#2E75B6", "#7FAADC", "#A9C4E8", "#1F4E79"];
const DEFAULT_LINE_COLORS = ["#FF6347", "#E84C30", "#FF8C69", "#CD5C5C"];

const DEFAULT_STAGGER = 80;

// ── Helpers ────────────────────────────────────────────────────────

function getDashArray(style: string, width: number): string {
    switch (style) {
        case "dashed": return `${width * 4},${width * 3}`;
        case "dotted": return `${width},${width * 2}`;
        default: return "none";
    }
}

interface FormatInfo { isPercent: boolean; isCurrency: boolean; currSymbol: string; }

function parseFormatInfo(fs: string): FormatInfo {
    const isPercent = fs.includes("%");
    const isCurrency = fs.includes("$") || fs.includes("£") || fs.includes("€");
    const currSymbol = isCurrency ? (fs.includes("£") ? "£" : fs.includes("€") ? "€" : "$") : "";
    return { isPercent, isCurrency, currSymbol };
}

function compactNumber(value: number, maxDec: number): string {
    const abs = Math.abs(value);
    let scaled: number, suffix: string;
    if (abs >= 1e9) { scaled = value / 1e9; suffix = "B"; }
    else if (abs >= 1e6) { scaled = value / 1e6; suffix = "M"; }
    else if (abs >= 1e3) { scaled = value / 1e3; suffix = "K"; }
    else { scaled = value; suffix = ""; }
    const fixed = scaled.toFixed(maxDec);
    const trimmed = suffix ? fixed.replace(/\.?0+$/, "") : fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return trimmed + suffix;
}

function formatDataLabel(value: number, fs: string): string {
    const info = parseFormatInfo(fs);
    if (info.isPercent) return (value * 100).toFixed(1).replace(/\.0$/, "") + "%";
    if (info.isCurrency) return info.currSymbol + compactNumber(value, 2);
    return compactNumber(value, 1);
}

function formatAxisTick(value: number, fs: string): string {
    const info = parseFormatInfo(fs);
    if (info.isPercent) {
        const p = value * 100;
        return (Number.isInteger(p) ? p.toString() : p.toFixed(1)) + "%";
    }
    if (info.isCurrency) return info.currSymbol + compactNumber(value, 1);
    return compactNumber(value, 1);
}

function smartTickCount(axisLength: number, fontSize: number): number {
    const ppt = Math.max(30, fontSize * 2.5);
    return Math.max(2, Math.min(Math.floor(axisLength / ppt), 10));
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
    if (h <= 0) return "M0,0";
    r = Math.min(r, w / 2, h);
    if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return `M${x},${y + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}h${-w}Z`;
}

/**
 * Custom elastic easing: overshoots then settles with wobble.
 * amplitude ~1.3, oscillations ~2.
 */
function easeSpring(t: number): number {
    if (t === 0 || t === 1) return t;
    const p = 0.35;
    const a = 1.3;
    const s = p / (2 * Math.PI) * Math.asin(1 / a);
    return a * Math.pow(2, -10 * t) * Math.sin((t - s) * (2 * Math.PI) / p) + 1;
}

/**
 * Bounce easing: ball-drop style bouncing at the end.
 */
function easeBounce(t: number): number {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
    if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
    t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
}

// ── Visual ─────────────────────────────────────────────────────────

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost;
    private selectionManager: ISelectionManager;
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private chartGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
    private tooltipDiv: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

    // Animation state tracking
    private isFirstRender = true;
    private previousCategories: Set<string> = new Set();
    private previousValueKey = "";
    private previousHighlightKey = "";

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();
        this.target = options.element;

        this.svg = d3.select(this.target)
            .append("svg")
            .classed("line-and-stacked-column-chart", true);

        this.chartGroup = this.svg.append("g")
            .classed("chart-group", true);

        this.tooltipDiv = d3.select(this.target)
            .append("div")
            .classed("chart-tooltip", true)
            .style("position", "absolute")
            .style("display", "none")
            .style("background", "rgba(0,0,0,0.8)")
            .style("color", "#fff")
            .style("padding", "6px 10px")
            .style("border-radius", "4px")
            .style("font-size", "12px")
            .style("pointer-events", "none")
            .style("z-index", "10")
            .style("white-space", "nowrap");

        this.svg.on("click", () => {
            this.selectionManager.clear();
            this.chartGroup.selectAll(".column-bar").style("opacity", 0.85);
            this.chartGroup.selectAll(".line-path").style("opacity", 1);
            this.chartGroup.selectAll(".line-marker").style("opacity", 1);
        });
    }

    /**
     * Determine which animation style to use for this update.
     * Returns the user-chosen style from settings, or "none" for non-data updates.
     */
    /**
     * Check if one set is a subset of another.
     */
    private static isSubset(a: Set<string>, b: Set<string>): boolean {
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
    }

    private resolveAnimationStyle(
        updateType: VisualUpdateType, currentCategories: Set<string>,
        valueKey: string, highlightKey: string
    ): AnimationStyle {
        const entrStyle = (this.formattingSettings.animationCard.entranceStyle.value?.value || "growUp") as AnimationStyle;
        const cfStyle = (this.formattingSettings.animationCard.crossFilterStyle.value?.value || "spring") as AnimationStyle;

        if (this.isFirstRender) return entrStyle;

        const isDataUpdate = (updateType & VisualUpdateType.Data) !== 0;
        if (!isDataUpdate) return "none";

        // Highlights changed → cross-filter (highlight mode)
        if (highlightKey !== this.previousHighlightKey) return cfStyle;

        // Check if categories changed
        const prev = this.previousCategories;
        const sameCategories = currentCategories.size === prev.size && Visual.isSubset(currentCategories, prev);

        if (!sameCategories) {
            // If new categories are a subset of previous (filter applied)
            // or previous are a subset of new (filter cleared), it's cross-filter
            const isFilter = Visual.isSubset(currentCategories, prev) || Visual.isSubset(prev, currentCategories);
            return isFilter ? cfStyle : entrStyle;
        }

        // Same categories, values changed (e.g. new measure added)
        if (valueKey !== this.previousValueKey) return cfStyle;

        return "none";
    }

    public update(options: VisualUpdateOptions) {
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
            VisualFormattingSettingsModel,
            options.dataViews?.[0]
        );

        const dataView = options.dataViews?.[0];
        if (!dataView?.categorical?.categories?.[0]) {
            this.svg.selectAll("g.chart-group > *").remove();
            this.isFirstRender = true;
            this.previousCategories = new Set();
            this.previousValueKey = "";
            this.previousHighlightKey = "";
            return;
        }

        const width = options.viewport.width;
        const height = options.viewport.height;
        this.svg.attr("width", width).attr("height", height);

        const { data, series, columnFormat, lineFormat } = this.parseData(dataView.categorical);

        // ── Dynamic margin calculation ──
        // Each section declares how much space it needs; chart area gets the remainder.
        const showLegend = this.formattingSettings.legendCard.show.value;
        const legendPos = this.formattingSettings.legendCard.position.value?.value || "bottom";
        const legFS = this.formattingSettings.legendCard.fontSize.value;
        const showXA = this.formattingSettings.xAxisCard.show.value;
        const showYA = this.formattingSettings.yAxisCard.show.value;
        const xFS = this.formattingSettings.xAxisCard.fontSize.value;
        const yFS = this.formattingSettings.yAxisCard.fontSize.value;
        const xTitle = this.formattingSettings.xAxisCard.title.value;
        const yLT = this.formattingSettings.yAxisCard.leftTitle.value;
        const yRT = this.formattingSettings.yAxisCard.rightTitle.value;
        const hasColumns = data.some(d => d.columnValues.length > 0);
        const hasLines = data.some(d => d.lineValues.length > 0);

        // Legend space calculation
        let legendH = 0, legendW = 0;
        if (showLegend && series.length > 0) {
            if (legendPos === "top" || legendPos === "bottom") {
                // Estimate rows needed based on available width
                const availLegW = Math.max(100, width - 20);
                const rowH = legFS + 10;
                let rowX = 0, rows = 1;
                series.forEach(s => {
                    const itemW = 16 + s.name.length * legFS * 0.55 + 30;
                    if (rowX + itemW > availLegW && rowX > 0) { rows++; rowX = itemW; } else { rowX += itemW; }
                });
                legendH = rows * rowH;
            } else {
                // Vertical: one row per series
                legendH = series.length * (legFS + 8);
                // Width: estimate from longest name
                const maxNameLen = Math.max(...series.map(s => s.name.length));
                legendW = 14 + maxNameLen * legFS * 0.55 + 8;
            }
        }

        // X-axis label height: rotated at -35°, estimate from longest category label
        let xAxisH = 0;
        if (showXA) {
            const maxCatLen = Math.max(...data.map(d => d.category.length), 1);
            const charW = xFS * 0.55;
            const labelW = maxCatLen * charW;
            // Height contribution of rotated text: labelW * sin(35°) + fontSize * cos(35°)
            xAxisH = labelW * Math.sin(35 * Math.PI / 180) + xFS * Math.cos(35 * Math.PI / 180);
            xAxisH = Math.min(xAxisH, height * 0.3); // cap at 30% of visual height
            xAxisH += 6; // tick mark + padding
            if (xTitle) xAxisH += xFS + 6;
        }

        // Y-axis tick label width estimate
        let yLeftW = 0, yRightW = 0;
        if (showYA) {
            if (hasColumns) {
                yLeftW = yFS * 3.5 + 6; // typical formatted number width + tick + padding
                if (yLT) yLeftW += yFS + 4;
            }
            if (hasLines) {
                yRightW = yFS * 3.5 + 6;
                if (yRT) yRightW += yFS + 4;
            }
        }

        // Assemble margins — each edge accounts for its sections with explicit gaps
        const PAD = 4; // base padding from visual edge
        const GAP = 6; // gap between adjacent sections
        const margin = { top: PAD, right: PAD, bottom: PAD, left: PAD };

        // Bottom: x-axis labels + gap + legend (if bottom)
        margin.bottom += xAxisH;
        if (showLegend && legendPos === "bottom") {
            margin.bottom += GAP + 10 + legendH;
        }

        // Top: legend (if top) — include icon overhang (10px above baseline)
        if (showLegend && legendPos === "top") {
            margin.top += 10 + legendH + GAP;
        }

        // Left: y-axis left + legend (if left)
        margin.left += yLeftW;
        if (showLegend && legendPos === "left") {
            margin.left += legendW + GAP;
        }

        // Right: y-axis right + legend (if right)
        margin.right += yRightW;
        if (showLegend && legendPos === "right") {
            margin.right += legendW + GAP;
        }

        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${margin.left},${margin.top})`);

        // Build fingerprints for animation detection
        const currentCategories = new Set(data.map(d => d.category));
        const valueKey = data.map(d =>
            d.columnValues.map(v => v.value).join(",") + ";" + d.lineValues.map(v => v.value).join(",")
        ).join("|");

        // Build highlight fingerprint from raw DataView (cross-filtering sets highlights on value columns)
        const dvValues = dataView.categorical.values;
        let highlightKey = "";
        if (dvValues) {
            const parts: string[] = [];
            for (let i = 0; i < dvValues.length; i++) {
                const hl = dvValues[i].highlights;
                parts.push(hl ? hl.map(h => h ?? "null").join(",") : "none");
            }
            highlightKey = parts.join("|");
        }

        const animStyle = this.resolveAnimationStyle(options.type, currentCategories, valueKey, highlightKey);

        // Update tracking state
        this.previousCategories = currentCategories;
        this.previousValueKey = valueKey;
        this.previousHighlightKey = highlightKey;
        this.isFirstRender = false;

        this.render(data, series, plotWidth, plotHeight, margin, columnFormat, lineFormat, animStyle);
    }

    private parseData(categorical: DataViewCategorical): {
        data: ChartDataPoint[]; series: SeriesInfo[]; columnFormat: string; lineFormat: string;
    } {
        const categories = categorical.categories[0];
        const catValues = categories.values as string[];
        const values = categorical.values;
        const series: SeriesInfo[] = [];
        const userColumnColor = this.formattingSettings.columnSettingsCard.fill.value.value;
        const userLineColor = this.formattingSettings.lineSettingsCard.fill.value.value;
        const columnMeasures: DataViewValueColumn[] = [];
        const lineMeasures: DataViewValueColumn[] = [];
        const tooltipMeasures: DataViewValueColumn[] = [];
        let columnFormat = "", lineFormat = "";

        // Detect whether a Column Legend grouping is active
        const hasLegend = values && values.source && values.source.roles?.["columnLegend"];

        // Build a map of group color overrides from the grouped() API
        const groupColorOverrides = new Map<string, string>();
        if (hasLegend && values && typeof values.grouped === "function") {
            const groups = values.grouped();
            for (const group of groups) {
                const overrideColor = (group.objects as any)?.colorSelector?.fill?.solid?.color;
                if (overrideColor && group.name != null) {
                    groupColorOverrides.set(String(group.name), overrideColor);
                }
            }
        }

        // Dynamic series color card slices
        const seriesColorSlices: formattingSettings.ColorPicker[] = [];

        if (values) {
            for (let i = 0; i < values.length; i++) {
                const col = values[i];
                const roleName = col.source.roles;
                if (roleName?.["columnValues"]) {
                    columnMeasures.push(col);
                    if (!columnFormat && col.source.format) columnFormat = col.source.format;

                    // Series name: use groupName when legend is active, otherwise displayName
                    const seriesName = hasLegend && col.source.groupName != null
                        ? String(col.source.groupName)
                        : col.source.displayName;

                    // Check for per-series color override from objects
                    const objOverride = (col.source.objects as any)?.colorSelector?.fill?.solid?.color
                        || groupColorOverrides.get(seriesName);

                    // Color priority: user override > host palette (legend) > default color / user setting
                    let color: string;
                    if (objOverride) {
                        color = objOverride;
                    } else if (hasLegend && col.source.groupName != null) {
                        color = this.host.colorPalette.getColor(String(col.source.groupName)).value;
                    } else if (columnMeasures.length === 1) {
                        color = userColumnColor;
                    } else {
                        color = DEFAULT_COLUMN_COLORS[(columnMeasures.length - 1) % DEFAULT_COLUMN_COLORS.length];
                    }

                    series.push({ name: seriesName, color, type: "column" });

                    // Build a color picker slice for this series
                    const selector = hasLegend && col.source.groupName != null
                        ? { data: [{ roles: { columnLegend: true }, key: String(col.source.groupName) }] }
                        : col.source.queryName ? { metadata: col.source.queryName } : undefined;
                    seriesColorSlices.push(new formattingSettings.ColorPicker({
                        name: "fill",
                        displayName: seriesName,
                        value: { value: color },
                        selector: selector as any
                    }));
                } else if (roleName?.["lineValues"]) {
                    lineMeasures.push(col);
                    if (!lineFormat && col.source.format) lineFormat = col.source.format;

                    const objOverride = (col.source.objects as any)?.colorSelector?.fill?.solid?.color;
                    let color: string;
                    if (objOverride) {
                        color = objOverride;
                    } else if (lineMeasures.length === 1) {
                        color = userLineColor;
                    } else {
                        color = DEFAULT_LINE_COLORS[(lineMeasures.length - 1) % DEFAULT_LINE_COLORS.length];
                    }
                    series.push({ name: col.source.displayName, color, type: "line" });

                    const selector = col.source.queryName ? { metadata: col.source.queryName } : undefined;
                    seriesColorSlices.push(new formattingSettings.ColorPicker({
                        name: "fill",
                        displayName: col.source.displayName,
                        value: { value: color },
                        selector: selector as any
                    }));
                } else if (roleName?.["tooltips"]) {
                    tooltipMeasures.push(col);
                }
            }
        }

        // Populate the dynamic series colors card
        this.formattingSettings.seriesColorsCard.slices = seriesColorSlices;

        const data: ChartDataPoint[] = catValues.map((cat, i) => ({
            category: String(cat),
            selectionId: this.host.createSelectionIdBuilder().withCategory(categories, i).createSelectionId(),
            columnValues: columnMeasures.map((col, ci) => {
                const seriesEntry = series.find(s => s.type === "column" &&
                    s.name === (hasLegend && col.source.groupName != null
                        ? String(col.source.groupName)
                        : col.source.displayName));
                return {
                    name: seriesEntry?.name || col.source.displayName,
                    value: Number(col.values[i]) || 0,
                    color: seriesEntry?.color || DEFAULT_COLUMN_COLORS[ci % DEFAULT_COLUMN_COLORS.length],
                    format: col.source.format || ""
                };
            }),
            lineValues: lineMeasures.map((col, li) => {
                const seriesEntry = series.find(s => s.type === "line" && s.name === col.source.displayName);
                return {
                    name: col.source.displayName,
                    value: Number(col.values[i]) || 0,
                    color: seriesEntry?.color || (li === 0 ? userLineColor : DEFAULT_LINE_COLORS[li % DEFAULT_LINE_COLORS.length]),
                    format: col.source.format || ""
                };
            }),
            tooltipValues: tooltipMeasures.map(col => ({
                name: col.source.displayName,
                value: Number(col.values[i]) || 0,
                format: col.source.format || ""
            }))
        }));

        return { data, series, columnFormat, lineFormat };
    }

    private render(
        data: ChartDataPoint[], series: SeriesInfo[],
        plotWidth: number, plotHeight: number,
        margin: { top: number; right: number; bottom: number; left: number },
        columnFormat: string, lineFormat: string,
        animStyle: AnimationStyle
    ) {
        this.chartGroup.selectAll("*").remove();
        if (data.length === 0) return;

        const tooltipDiv = this.tooltipDiv;
        const selectionManager = this.selectionManager;
        const animDuration = this.formattingSettings.animationCard.duration.value || 800;
        const fontFamily = this.formattingSettings.fontSettingsCard.fontFamily.value?.value || "Segoe UI";

        // Apply font family to the entire SVG
        this.svg.style("font-family", `"${fontFamily}", sans-serif`);

        // ── Scales ──
        const xScale = d3.scaleBand().domain(data.map(d => d.category)).range([0, plotWidth]).padding(0.3);
        const maxColStack = d3.max(data, d => d.columnValues.reduce((s, v) => s + v.value, 0)) || 0;
        const maxLineVal = d3.max(data, d => d3.max(d.lineValues, v => v.value) || 0) || 0;
        const yL = d3.scaleLinear().domain([0, maxColStack * 1.1 || 1]).nice().range([plotHeight, 0]);
        const yR = d3.scaleLinear().domain([0, maxLineVal * 1.1 || 1]).nice().range([plotHeight, 0]);

        // ── Gridlines ──
        const gs = this.formattingSettings.gridlinesCard;
        const gColor = gs.color.value.value, gW = gs.strokeWidth.value;
        const gDash = getDashArray(String(gs.lineStyle.value?.value || "dashed"), gW);
        const yFS = this.formattingSettings.yAxisCard.fontSize.value;

        if (gs.showHorizontal.value) {
            const g = this.chartGroup.append("g").classed("gridlines-h", true);
            yL.ticks(smartTickCount(plotHeight, yFS)).forEach(t => {
                g.append("line").attr("x1", 0).attr("x2", plotWidth)
                    .attr("y1", yL(t)).attr("y2", yL(t))
                    .attr("stroke", gColor).attr("stroke-width", gW).attr("stroke-dasharray", gDash);
            });
        }
        if (gs.showVertical.value) {
            const g = this.chartGroup.append("g").classed("gridlines-v", true);
            data.forEach(d => {
                const x = xScale(d.category)! + xScale.bandwidth() / 2;
                g.append("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", plotHeight)
                    .attr("stroke", gColor).attr("stroke-width", gW).attr("stroke-dasharray", gDash);
            });
        }

        // ── Axes ──
        const showXA = this.formattingSettings.xAxisCard.show.value;
        const showYA = this.formattingSettings.yAxisCard.show.value;
        const xFS = this.formattingSettings.xAxisCard.fontSize.value;
        const xFC = this.formattingSettings.xAxisCard.fontColor.value.value;
        const xFF = this.formattingSettings.xAxisCard.fontFamily.value?.value || "Segoe UI";
        const yFC = this.formattingSettings.yAxisCard.fontColor.value.value;
        const xTitle = this.formattingSettings.xAxisCard.title.value;
        const yLT = this.formattingSettings.yAxisCard.leftTitle.value;
        const yRT = this.formattingSettings.yAxisCard.rightTitle.value;

        if (showXA) {
            const xLabelMaxW = this.formattingSettings.xAxisCard.maxWidth.value || Math.max(xScale.bandwidth(), 60);
            const xa = this.chartGroup.append("g").classed("axis x-axis", true)
                .attr("transform", `translate(0,${plotHeight})`).call(d3.axisBottom(xScale));
            // Power BI-style: cap font size (min 9px), then truncate with ellipsis
            const minFontSize = 9;
            const effectiveXFS = Math.max(minFontSize, Math.min(xFS, xLabelMaxW / 0.55 / 2));
            xa.selectAll(".tick text").each(function () {
                const textEl = d3.select(this);
                const fullText = textEl.text();
                textEl.text(null).style("font-size", `${effectiveXFS}px`).style("fill", xFC)
                    .style("font-family", `"${xFF}", sans-serif`)
                    .attr("transform", "rotate(-35)").style("text-anchor", "end");

                const charW = effectiveXFS * 0.55;
                const maxChars = Math.max(1, Math.floor(xLabelMaxW / charW));
                let displayText = fullText;
                if (fullText.length > maxChars) {
                    displayText = fullText.substring(0, Math.max(1, maxChars - 1)) + "\u2026";
                }
                textEl.append("tspan").attr("x", 0).attr("dy", "0.71em").text(displayText);
            });
            if (xTitle) {
                this.chartGroup.append("text").classed("axis-title", true)
                    .attr("x", plotWidth / 2).attr("y", plotHeight + margin.bottom - 5)
                    .attr("text-anchor", "middle").style("font-size", `${xFS + 1}px`).style("fill", xFC).text(xTitle);
            }
        }

        if (showYA) {
            const tc = smartTickCount(plotHeight, yFS);
            if (data.some(d => d.columnValues.length > 0)) {
                this.chartGroup.append("g").classed("axis y-axis-left", true)
                    .call(d3.axisLeft(yL).ticks(tc).tickFormat(d => formatAxisTick(d as number, columnFormat)))
                    .selectAll("text").style("font-size", `${yFS}px`).style("fill", yFC);
                if (yLT) {
                    this.chartGroup.append("text").classed("axis-title", true).attr("transform", "rotate(-90)")
                        .attr("x", -plotHeight / 2).attr("y", -margin.left + 14)
                        .attr("text-anchor", "middle").style("font-size", `${yFS + 1}px`).style("fill", yFC).text(yLT);
                }
            }
            if (data.some(d => d.lineValues.length > 0)) {
                this.chartGroup.append("g").classed("axis y-axis-right", true)
                    .attr("transform", `translate(${plotWidth},0)`)
                    .call(d3.axisRight(yR).ticks(tc).tickFormat(d => formatAxisTick(d as number, lineFormat)))
                    .selectAll("text").style("font-size", `${yFS}px`).style("fill", yFC);
                if (yRT) {
                    this.chartGroup.append("text").classed("axis-title", true).attr("transform", "rotate(90)")
                        .attr("x", plotHeight / 2).attr("y", -plotWidth - margin.right + 14)
                        .attr("text-anchor", "middle").style("font-size", `${yFS + 1}px`).style("fill", yFC).text(yRT);
                }
            }
        }

        // ── Column settings ──
        const cBC = this.formattingSettings.columnSettingsCard.borderColor.value.value;
        const cBW = this.formattingSettings.columnSettingsCard.borderWidth.value;
        const cSL = this.formattingSettings.columnSettingsCard.showDataLabels.value;
        const cLFS = this.formattingSettings.columnSettingsCard.dataLabelFontSize.value;
        const cLC = this.formattingSettings.columnSettingsCard.dataLabelColor.value.value;
        const cR = this.formattingSettings.columnSettingsCard.cornerRadius.value;

        // ── Draw stacked columns ──
        if (data[0].columnValues.length > 0) {
            const colG = this.chartGroup.append("g").classed("columns", true);
            const nSeg = data[0].columnValues.length;

            data.forEach((d, catIdx) => {
                let yOff = 0;
                d.columnValues.forEach((cv, segIdx) => {
                    const bH = yL(0) - yL(cv.value);
                    const fY = yL(yOff + cv.value);
                    const bX = xScale(d.category)!;
                    const bW = xScale.bandwidth();
                    const isTop = segIdx === nSeg - 1;
                    const r = isTop ? cR : 0;

                    // Shared interaction setup
                    const setupInteractions = (el: d3.Selection<SVGElement, unknown, null, undefined>) => {
                        el.on("click", function (event: MouseEvent) {
                            event.stopPropagation();
                            selectionManager.select(d.selectionId, event.ctrlKey || event.metaKey);
                            highlightSelection(d.selectionId);
                        })
                        .on("mouseover", function () {
                            let html = `<strong>${d.category}</strong><br/>${cv.name}: ${formatDataLabel(cv.value, cv.format)}`;
                            d.tooltipValues.forEach(tv => {
                                html += `<br/>${tv.name}: ${formatDataLabel(tv.value, tv.format)}`;
                            });
                            tooltipDiv.style("display", "block").html(html);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });
                    };

                    // Base y position for this segment (top of the segment below)
                    const baseY = yL(yOff);

                    // Helper to animate a bar element (path or rect) based on the chosen style
                    const animateBar = (el: d3.Selection<any, unknown, null, undefined>, isPath: boolean) => {
                        const delay = catIdx * DEFAULT_STAGGER;
                        if (animStyle === "growUp") {
                            if (isPath) {
                                el.attr("d", roundedTopRect(bX, baseY, bW, 0, 0)).style("opacity", 0)
                                    .transition().duration(animDuration).delay(delay)
                                    .ease(d3.easeCubicOut).style("opacity", 0.85)
                                    .attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            } else {
                                el.attr("y", baseY).attr("height", 0).style("opacity", 0)
                                    .transition().duration(animDuration).delay(delay)
                                    .ease(d3.easeCubicOut).style("opacity", 0.85)
                                    .attr("y", fY).attr("height", bH);
                            }
                        } else if (animStyle === "spring") {
                            if (isPath) el.attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            else el.attr("y", fY).attr("height", bH);
                            el.style("opacity", 0.85)
                                .attr("transform", `translate(0, ${bH * 0.15})`)
                                .transition().duration(animDuration * 0.6)
                                .ease(easeSpring).attr("transform", "translate(0, 0)");
                        } else if (animStyle === "fadeIn") {
                            if (isPath) el.attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            else el.attr("y", fY).attr("height", bH);
                            el.style("opacity", 0)
                                .transition().duration(animDuration).delay(delay)
                                .style("opacity", 0.85);
                        } else if (animStyle === "slideLeft") {
                            if (isPath) el.attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            else el.attr("y", fY).attr("height", bH);
                            el.style("opacity", 0.85)
                                .attr("transform", `translate(${-plotWidth}, 0)`)
                                .transition().duration(animDuration).delay(delay)
                                .ease(d3.easeCubicOut).attr("transform", "translate(0, 0)");
                        } else if (animStyle === "bounce") {
                            if (isPath) {
                                el.attr("d", roundedTopRect(bX, baseY, bW, 0, 0)).style("opacity", 0)
                                    .transition().duration(animDuration).delay(delay)
                                    .ease(easeBounce).style("opacity", 0.85)
                                    .attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            } else {
                                el.attr("y", baseY).attr("height", 0).style("opacity", 0)
                                    .transition().duration(animDuration).delay(delay)
                                    .ease(easeBounce).style("opacity", 0.85)
                                    .attr("y", fY).attr("height", bH);
                            }
                        } else if (animStyle === "expandCenter") {
                            // Columns expand from horizontal center
                            const centerX = bX + bW / 2;
                            if (isPath) el.attr("d", roundedTopRect(centerX, fY, 0, bH, 0));
                            else el.attr("x", centerX).attr("width", 0).attr("y", fY).attr("height", bH);
                            el.style("opacity", 0.85)
                                .transition().duration(animDuration).delay(delay)
                                .ease(d3.easeCubicOut)
                                .attr(isPath ? "d" : "x", isPath ? roundedTopRect(bX, fY, bW, bH, r) : bX);
                            if (!isPath) el.transition().duration(animDuration).delay(delay)
                                .ease(d3.easeCubicOut).attr("x", bX).attr("width", bW);
                        } else {
                            if (isPath) el.attr("d", roundedTopRect(bX, fY, bW, bH, r));
                            else el.attr("y", fY).attr("height", bH);
                            el.style("opacity", 0.85);
                        }
                    };

                    if (r > 0 && isTop) {
                        const bar = colG.append("path").classed("column-bar", true).attr("fill", cv.color);
                        if (cBW > 0) bar.attr("stroke", cBC).attr("stroke-width", cBW);
                        setupInteractions(bar as unknown as d3.Selection<SVGElement, unknown, null, undefined>);
                        animateBar(bar, true);
                    } else {
                        const rect = colG.append("rect").classed("column-bar", true)
                            .attr("x", bX).attr("width", bW).attr("fill", cv.color);
                        if (cBW > 0) rect.attr("stroke", cBC).attr("stroke-width", cBW);
                        setupInteractions(rect as unknown as d3.Selection<SVGElement, unknown, null, undefined>);
                        animateBar(rect, false);
                    }

                    // Data labels — repositioned to avoid cutoff at edges
                    if (cSL && cv.value > 0) {
                        let lblX = bX + bW / 2;
                        let lblAnchor = "middle";
                        // Prevent cutoff at right edge
                        if (lblX + cLFS * 2 > plotWidth) {
                            lblX = bX + bW - 2;
                            lblAnchor = "end";
                        }
                        // Prevent cutoff at left edge
                        if (lblX - cLFS * 2 < 0) {
                            lblX = bX + 2;
                            lblAnchor = "start";
                        }
                        const lbl = colG.append("text").classed("data-label", true)
                            .attr("x", lblX).attr("y", fY + bH / 2 + cLFS / 3)
                            .attr("text-anchor", lblAnchor).style("font-size", `${cLFS}px`)
                            .style("fill", cLC).style("pointer-events", "none")
                            .text(formatDataLabel(cv.value, cv.format));

                        if (animStyle !== "none") {
                            lbl.style("opacity", 0).transition().duration(animDuration)
                                .delay(catIdx * DEFAULT_STAGGER).style("opacity", 1);
                        }
                    }

                    yOff += cv.value;
                });
            });
        }

        // Selection highlight helper
        const chartGroup = this.chartGroup;
        function highlightSelection(selectedId: ISelectionId) {
            const has = selectionManager.hasSelection();
            chartGroup.selectAll(".column-bar").style("opacity", () => has ? 0.3 : 0.85);
            if (has) {
                data.forEach((d, ci) => {
                    if (d.selectionId === selectedId) {
                        const nS = data[0].columnValues.length;
                        chartGroup.selectAll(".column-bar")
                            .filter((_: unknown, i: number) => i >= ci * nS && i < ci * nS + nS)
                            .style("opacity", 0.85);
                    }
                });
            }
        }

        // ── Line settings ──
        const lW = this.formattingSettings.lineSettingsCard.strokeWidth.value;
        const showM = this.formattingSettings.lineSettingsCard.showMarkers.value;
        const mSize = this.formattingSettings.lineSettingsCard.markerSize.value;
        const lSV = String(this.formattingSettings.lineSettingsCard.lineStyle.value?.value || "solid");
        const lDash = getDashArray(lSV, lW);
        const lSL = this.formattingSettings.lineSettingsCard.showDataLabels.value;
        const lLFS = this.formattingSettings.lineSettingsCard.dataLabelFontSize.value;
        const lLC = this.formattingSettings.lineSettingsCard.dataLabelColor.value.value;
        const entrLineD = animDuration + data.length * DEFAULT_STAGGER;

        // ── Draw lines ──
        if (data[0].lineValues.length > 0) {
            const lineG = this.chartGroup.append("g").classed("lines", true);
            const nLS = data[0].lineValues.length;

            for (let li = 0; li < nLS; li++) {
                const color = data[0].lineValues[li].color;
                const fmt = data[0].lineValues[li].format;

                const lineGen = d3.line<ChartDataPoint>()
                    .x(d => xScale(d.category)! + xScale.bandwidth() / 2)
                    .y(d => yR(d.lineValues[li].value))
                    .curve(d3.curveMonotoneX);

                const path = lineG.append("path").datum(data).classed("line-path", true)
                    .attr("d", lineGen).attr("stroke", color).attr("stroke-width", lW);

                if (lDash !== "none") {
                    path.attr("stroke-dasharray", lDash);
                } else if (animStyle === "growUp" || animStyle === "slideLeft") {
                    // Line draw effect — stroke progressively reveals
                    const node = path.node() as SVGPathElement;
                    const len = node.getTotalLength();
                    path.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
                        .transition().duration(entrLineD).ease(d3.easeLinear).attr("stroke-dashoffset", 0);
                } else if (animStyle === "bounce") {
                    const node = path.node() as SVGPathElement;
                    const len = node.getTotalLength();
                    path.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
                        .transition().duration(entrLineD).ease(easeBounce).attr("stroke-dashoffset", 0);
                } else if (animStyle === "fadeIn" || animStyle === "expandCenter") {
                    path.style("opacity", 0).transition().duration(animDuration).style("opacity", 1);
                }

                if (showM) {
                    data.forEach((d, i) => {
                        const cx = xScale(d.category)! + xScale.bandwidth() / 2;
                        const cy = yR(d.lineValues[li].value);

                        const marker = lineG.append("circle").classed("line-marker", true)
                            .attr("cx", cx).attr("fill", color);

                        marker.on("click", function (event: MouseEvent) {
                            event.stopPropagation();
                            selectionManager.select(d.selectionId, event.ctrlKey || event.metaKey);
                        })
                        .on("mouseover", function () {
                            let html = `<strong>${d.category}</strong><br/>${d.lineValues[li].name}: ${formatDataLabel(d.lineValues[li].value, fmt)}`;
                            d.tooltipValues.forEach(tv => {
                                html += `<br/>${tv.name}: ${formatDataLabel(tv.value, tv.format)}`;
                            });
                            tooltipDiv.style("display", "block").html(html);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });

                        const mDelay = (i / (data.length - 1 || 1)) * entrLineD;
                        if (animStyle === "growUp" || animStyle === "expandCenter") {
                            marker.attr("cy", cy).attr("r", 0)
                                .transition().duration(200).delay(mDelay)
                                .ease(d3.easeBackOut).attr("r", mSize);
                        } else if (animStyle === "spring") {
                            marker.attr("cy", cy - 20).attr("r", mSize)
                                .transition().duration(animDuration * 0.6)
                                .ease(easeSpring).attr("cy", cy);
                        } else if (animStyle === "fadeIn") {
                            marker.attr("cy", cy).attr("r", mSize).style("opacity", 0)
                                .transition().duration(animDuration).delay(mDelay)
                                .style("opacity", 1);
                        } else if (animStyle === "slideLeft") {
                            marker.attr("cy", cy).attr("r", mSize)
                                .attr("cx", -mSize)
                                .transition().duration(animDuration).delay(mDelay)
                                .ease(d3.easeCubicOut).attr("cx", cx);
                        } else if (animStyle === "bounce") {
                            marker.attr("cy", cy).attr("r", 0)
                                .transition().duration(300).delay(mDelay)
                                .ease(easeBounce).attr("r", mSize);
                        } else {
                            marker.attr("cy", cy).attr("r", mSize);
                        }
                    });
                }

                if (lSL) {
                    data.forEach((d, i) => {
                        let lblX = xScale(d.category)! + xScale.bandwidth() / 2;
                        let lblY = yR(d.lineValues[li].value) - mSize - 4;
                        let lblAnchor = "middle";
                        // Prevent cutoff at right edge
                        if (lblX + lLFS * 2 > plotWidth) { lblAnchor = "end"; }
                        // Prevent cutoff at left edge
                        if (lblX - lLFS * 2 < 0) { lblAnchor = "start"; }
                        // Prevent cutoff at top
                        if (lblY < lLFS) { lblY = yR(d.lineValues[li].value) + mSize + lLFS; }

                        const lbl = lineG.append("text").classed("data-label", true)
                            .attr("x", lblX).attr("y", lblY)
                            .attr("text-anchor", lblAnchor).style("font-size", `${lLFS}px`)
                            .style("fill", lLC).style("pointer-events", "none")
                            .text(formatDataLabel(d.lineValues[li].value, fmt));

                        if (animStyle !== "none") {
                            lbl.style("opacity", 0).transition().duration(200)
                                .delay((i / (data.length - 1 || 1)) * entrLineD).style("opacity", 1);
                        }
                    });
                }
            }
        }

        // ── Legend ──
        // Legend is positioned within its reserved margin space, never overlapping the chart or axes.
        const showLeg = this.formattingSettings.legendCard.show.value;
        if (showLeg && series.length > 0) {
            const legFS = this.formattingSettings.legendCard.fontSize.value;
            const legFC = this.formattingSettings.legendCard.fontColor.value.value;
            const legPos = this.formattingSettings.legendCard.position.value?.value || "bottom";
            const legG = this.chartGroup.append("g").classed("legend", true);
            const legRowH = legFS + 10;

            // Compute actual legend height for bottom positioning
            let legTotalH = legRowH;
            if (legPos === "bottom" || legPos === "top") {
                let rowX = 0, rows = 1;
                series.forEach(s => {
                    const itemW = 16 + s.name.length * legFS * 0.55 + 30;
                    if (rowX + itemW > plotWidth && rowX > 0) { rows++; rowX = itemW; } else { rowX += itemW; }
                });
                legTotalH = rows * legRowH;
            }

            if (legPos === "bottom") {
                legG.attr("transform", `translate(${-margin.left + 4},${plotHeight + margin.bottom - legTotalH})`);
                this.renderHLegend(legG, series, legFS, legFC, plotWidth + margin.left + margin.right - 8);
            } else if (legPos === "top") {
                legG.attr("transform", `translate(${-margin.left + 4},${-margin.top + legRowH})`);
                this.renderHLegend(legG, series, legFS, legFC, plotWidth + margin.left + margin.right - 8);
            } else if (legPos === "left") {
                legG.attr("transform", `translate(${-margin.left + 4},${legFS})`);
                this.renderVLegend(legG, series, legFS, legFC);
            } else if (legPos === "right") {
                // Right of right y-axis
                const rightAxisW = this.formattingSettings.yAxisCard.show.value ? yFS * 3.5 + 6 : 0;
                legG.attr("transform", `translate(${plotWidth + rightAxisW + 8},${legFS})`);
                this.renderVLegend(legG, series, legFS, legFC);
            }
        }
    }

    private renderHLegend(g: d3.Selection<SVGGElement, unknown, null, undefined>,
        series: SeriesInfo[], fs: number, fc: string, maxWidth: number) {
        let xOff = 0;
        let row = 0;
        const rowH = fs + 10;
        series.forEach(s => {
            const estItemW = 16 + s.name.length * fs * 0.55 + 30;
            if (xOff + estItemW > maxWidth && xOff > 0) {
                row++;
                xOff = 0;
            }
            const item = g.append("g").classed("legend-item", true)
                .attr("transform", `translate(${xOff},${row * rowH})`);
            if (s.type === "column") {
                item.append("rect").attr("width", 12).attr("height", 12).attr("y", -10).attr("fill", s.color);
            } else {
                item.append("line").attr("x1", 0).attr("x2", 12).attr("y1", -4).attr("y2", -4)
                    .attr("stroke", s.color).attr("stroke-width", 2);
            }
            const t = item.append("text").classed("legend-text", true).attr("x", 16).attr("y", 0)
                .style("font-size", `${fs}px`).style("fill", fc).text(s.name);
            const textW = (t.node() as SVGTextElement).getComputedTextLength?.() || s.name.length * fs * 0.55;
            xOff += textW + 30;
        });
    }

    private renderVLegend(g: d3.Selection<SVGGElement, unknown, null, undefined>,
        series: SeriesInfo[], fs: number, fc: string) {
        series.forEach((s, i) => {
            const item = g.append("g").classed("legend-item", true).attr("transform", `translate(0,${i * (fs + 8)})`);
            if (s.type === "column") {
                item.append("rect").attr("width", 10).attr("height", 10).attr("y", -8).attr("fill", s.color);
            } else {
                item.append("line").attr("x1", 0).attr("x2", 10).attr("y1", -3).attr("y2", -3)
                    .attr("stroke", s.color).attr("stroke-width", 2);
            }
            item.append("text").classed("legend-text", true).attr("x", 14).attr("y", 0)
                .style("font-size", `${fs}px`).style("fill", fc).text(s.name);
        });
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}
