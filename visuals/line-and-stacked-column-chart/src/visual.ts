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

import { VisualFormattingSettingsModel } from "./settings";

// ── Types ──────────────────────────────────────────────────────────

interface ChartDataPoint {
    category: string;
    selectionId: ISelectionId;
    columnValues: { name: string; value: number; color: string; format: string }[];
    lineValues: { name: string; value: number; color: string; format: string }[];
}

interface SeriesInfo {
    name: string;
    color: string;
    type: "column" | "line";
}

type AnimationStyle = "growUp" | "fadeIn" | "spring" | "none";

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
    private previousCategoryKey = "";
    private previousValueKey = "";

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
    private resolveAnimationStyle(updateType: VisualUpdateType, categoryKey: string, valueKey: string): AnimationStyle {
        const entrStyle = (this.formattingSettings.animationCard.entranceStyle.value?.value || "growUp") as AnimationStyle;
        const cfStyle = (this.formattingSettings.animationCard.crossFilterStyle.value?.value || "spring") as AnimationStyle;

        if (this.isFirstRender) return entrStyle;

        const isDataUpdate = (updateType & VisualUpdateType.Data) !== 0;
        if (!isDataUpdate) return "none";

        if (categoryKey !== this.previousCategoryKey) return entrStyle;
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
            this.previousCategoryKey = "";
            this.previousValueKey = "";
            return;
        }

        const width = options.viewport.width;
        const height = options.viewport.height;
        this.svg.attr("width", width).attr("height", height);

        const showLegend = this.formattingSettings.legendCard.show.value;
        const legendPos = this.formattingSettings.legendCard.position.value?.value || "bottom";
        const legendSpace = showLegend ? 24 : 0;
        const margin = { top: 8, right: 45, bottom: 40, left: 45 };

        if (showLegend) {
            if (legendPos === "top") margin.top += legendSpace;
            else if (legendPos === "bottom") margin.bottom += legendSpace;
            else if (legendPos === "left") margin.left += legendSpace + 50;
            else if (legendPos === "right") margin.right += legendSpace + 50;
        }

        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${margin.left},${margin.top})`);

        const { data, series, columnFormat, lineFormat } = this.parseData(dataView.categorical);

        // Build fingerprints for animation detection
        const categoryKey = data.map(d => d.category).join("|");
        const valueKey = data.map(d =>
            d.columnValues.map(v => v.value).join(",") + ";" + d.lineValues.map(v => v.value).join(",")
        ).join("|");

        const animStyle = this.resolveAnimationStyle(options.type, categoryKey, valueKey);

        // Update tracking state
        this.previousCategoryKey = categoryKey;
        this.previousValueKey = valueKey;
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
        let columnFormat = "", lineFormat = "";

        if (values) {
            for (let i = 0; i < values.length; i++) {
                const col = values[i];
                const roleName = col.source.roles;
                if (roleName?.["columnValues"]) {
                    columnMeasures.push(col);
                    if (!columnFormat && col.source.format) columnFormat = col.source.format;
                    const color = columnMeasures.length === 1
                        ? userColumnColor
                        : DEFAULT_COLUMN_COLORS[(columnMeasures.length - 1) % DEFAULT_COLUMN_COLORS.length];
                    series.push({ name: col.source.displayName, color, type: "column" });
                } else if (roleName?.["lineValues"]) {
                    lineMeasures.push(col);
                    if (!lineFormat && col.source.format) lineFormat = col.source.format;
                    const color = lineMeasures.length === 1
                        ? userLineColor
                        : DEFAULT_LINE_COLORS[(lineMeasures.length - 1) % DEFAULT_LINE_COLORS.length];
                    series.push({ name: col.source.displayName, color, type: "line" });
                }
            }
        }

        const data: ChartDataPoint[] = catValues.map((cat, i) => ({
            category: String(cat),
            selectionId: this.host.createSelectionIdBuilder().withCategory(categories, i).createSelectionId(),
            columnValues: columnMeasures.map((col, ci) => ({
                name: col.source.displayName,
                value: Number(col.values[i]) || 0,
                color: ci === 0 ? userColumnColor : DEFAULT_COLUMN_COLORS[ci % DEFAULT_COLUMN_COLORS.length],
                format: col.source.format || ""
            })),
            lineValues: lineMeasures.map((col, li) => ({
                name: col.source.displayName,
                value: Number(col.values[i]) || 0,
                color: li === 0 ? userLineColor : DEFAULT_LINE_COLORS[li % DEFAULT_LINE_COLORS.length],
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
        const yFC = this.formattingSettings.yAxisCard.fontColor.value.value;
        const xTitle = this.formattingSettings.xAxisCard.title.value;
        const yLT = this.formattingSettings.yAxisCard.leftTitle.value;
        const yRT = this.formattingSettings.yAxisCard.rightTitle.value;

        if (showXA) {
            const xLabelMaxW = this.formattingSettings.xAxisCard.maxWidth.value || Math.max(xScale.bandwidth(), 60);
            const xa = this.chartGroup.append("g").classed("axis x-axis", true)
                .attr("transform", `translate(0,${plotHeight})`).call(d3.axisBottom(xScale));
            // Replace default tick text with wrapped text
            xa.selectAll(".tick text").each(function () {
                const textEl = d3.select(this);
                const fullText = textEl.text();
                textEl.text(null).style("font-size", `${xFS}px`).style("fill", xFC)
                    .attr("transform", "rotate(-35)").style("text-anchor", "end");

                // Split into words and wrap
                const words = fullText.split(/\s+/);
                let line = "";
                let lineNum = 0;
                const lineHeight = xFS * 1.2;

                words.forEach((word, wi) => {
                    const testLine = line ? line + " " + word : word;
                    // Estimate width: ~0.6em per char at given font size
                    const estWidth = testLine.length * xFS * 0.55;
                    if (estWidth > xLabelMaxW && line) {
                        textEl.append("tspan")
                            .attr("x", 0).attr("dy", lineNum === 0 ? "0.71em" : `${lineHeight}px`)
                            .text(line);
                        line = word;
                        lineNum++;
                    } else {
                        line = testLine;
                    }
                    if (wi === words.length - 1) {
                        textEl.append("tspan")
                            .attr("x", 0).attr("dy", lineNum === 0 ? "0.71em" : `${lineHeight}px`)
                            .text(line);
                    }
                });
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
                            tooltipDiv.style("display", "block")
                                .html(`<strong>${d.category}</strong><br/>${cv.name}: ${formatDataLabel(cv.value, cv.format)}`);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });
                    };

                    if (r > 0 && isTop) {
                        const bar = colG.append("path").classed("column-bar", true).attr("fill", cv.color);
                        if (cBW > 0) bar.attr("stroke", cBC).attr("stroke-width", cBW);
                        setupInteractions(bar as unknown as d3.Selection<SVGElement, unknown, null, undefined>);

                        if (animStyle === "growUp") {
                            bar.attr("d", roundedTopRect(bX, plotHeight, bW, 0, 0)).style("opacity", 0)
                                .transition().duration(animDuration).delay(catIdx * DEFAULT_STAGGER)
                                .ease(d3.easeCubicOut).style("opacity", 0.85)
                                .attr("d", roundedTopRect(bX, fY, bW, bH, r));
                        } else if (animStyle === "spring") {
                            bar.attr("d", roundedTopRect(bX, fY, bW, bH, r)).style("opacity", 0.85)
                                .attr("transform", `translate(0, ${bH * 0.15})`)
                                .transition().duration(animDuration * 0.6)
                                .ease(easeSpring)
                                .attr("transform", "translate(0, 0)");
                        } else if (animStyle === "fadeIn") {
                            bar.attr("d", roundedTopRect(bX, fY, bW, bH, r)).style("opacity", 0)
                                .transition().duration(animDuration).delay(catIdx * DEFAULT_STAGGER)
                                .style("opacity", 0.85);
                        } else {
                            bar.attr("d", roundedTopRect(bX, fY, bW, bH, r)).style("opacity", 0.85);
                        }
                    } else {
                        const rect = colG.append("rect").classed("column-bar", true)
                            .attr("x", bX).attr("width", bW).attr("fill", cv.color);
                        if (cBW > 0) rect.attr("stroke", cBC).attr("stroke-width", cBW);
                        setupInteractions(rect as unknown as d3.Selection<SVGElement, unknown, null, undefined>);

                        if (animStyle === "growUp") {
                            rect.attr("y", plotHeight).attr("height", 0).style("opacity", 0)
                                .transition().duration(animDuration).delay(catIdx * DEFAULT_STAGGER)
                                .ease(d3.easeCubicOut).style("opacity", 0.85)
                                .attr("y", fY).attr("height", bH);
                        } else if (animStyle === "spring") {
                            rect.attr("y", fY).attr("height", bH).style("opacity", 0.85)
                                .attr("transform", `translate(0, ${bH * 0.15})`)
                                .transition().duration(animDuration * 0.6)
                                .ease(easeSpring)
                                .attr("transform", "translate(0, 0)");
                        } else if (animStyle === "fadeIn") {
                            rect.attr("y", fY).attr("height", bH).style("opacity", 0)
                                .transition().duration(animDuration).delay(catIdx * DEFAULT_STAGGER)
                                .style("opacity", 0.85);
                        } else {
                            rect.attr("y", fY).attr("height", bH).style("opacity", 0.85);
                        }
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
                } else if (animStyle === "growUp") {
                    const node = path.node() as SVGPathElement;
                    const len = node.getTotalLength();
                    path.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
                        .transition().duration(entrLineD).ease(d3.easeLinear).attr("stroke-dashoffset", 0);
                } else if (animStyle === "fadeIn") {
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
                            tooltipDiv.style("display", "block")
                                .html(`<strong>${d.category}</strong><br/>${d.lineValues[li].name}: ${formatDataLabel(d.lineValues[li].value, fmt)}`);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });

                        if (animStyle === "growUp") {
                            marker.attr("cy", cy).attr("r", 0)
                                .transition().duration(200)
                                .delay((i / (data.length - 1 || 1)) * entrLineD)
                                .ease(d3.easeBackOut).attr("r", mSize);
                        } else if (animStyle === "spring") {
                            marker.attr("cy", cy - 20).attr("r", mSize)
                                .transition().duration(animDuration * 0.6)
                                .ease(easeSpring).attr("cy", cy);
                        } else if (animStyle === "fadeIn") {
                            marker.attr("cy", cy).attr("r", mSize).style("opacity", 0)
                                .transition().duration(animDuration)
                                .delay((i / (data.length - 1 || 1)) * entrLineD)
                                .style("opacity", 1);
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
        const showLeg = this.formattingSettings.legendCard.show.value;
        if (showLeg && series.length > 0) {
            const legFS = this.formattingSettings.legendCard.fontSize.value;
            const legFC = this.formattingSettings.legendCard.fontColor.value.value;
            const legPos = this.formattingSettings.legendCard.position.value?.value || "bottom";
            const legG = this.chartGroup.append("g").classed("legend", true);

            if (legPos === "bottom") {
                legG.attr("transform", `translate(0,${plotHeight + margin.bottom - 8})`);
                this.renderHLegend(legG, series, legFS, legFC);
            } else if (legPos === "top") {
                legG.attr("transform", `translate(0,${-margin.top + 4})`);
                this.renderHLegend(legG, series, legFS, legFC);
            } else if (legPos === "left") {
                legG.attr("transform", `translate(${-margin.left + 5},0)`);
                this.renderVLegend(legG, series, legFS, legFC);
            } else if (legPos === "right") {
                legG.attr("transform", `translate(${plotWidth + 30},0)`);
                this.renderVLegend(legG, series, legFS, legFC);
            }
        }
    }

    private renderHLegend(g: d3.Selection<SVGGElement, unknown, null, undefined>,
        series: SeriesInfo[], fs: number, fc: string) {
        let xOff = 0;
        series.forEach(s => {
            const item = g.append("g").classed("legend-item", true).attr("transform", `translate(${xOff},0)`);
            if (s.type === "column") {
                item.append("rect").attr("width", 12).attr("height", 12).attr("y", -10).attr("fill", s.color);
            } else {
                item.append("line").attr("x1", 0).attr("x2", 12).attr("y1", -4).attr("y2", -4)
                    .attr("stroke", s.color).attr("stroke-width", 2);
            }
            const t = item.append("text").classed("legend-text", true).attr("x", 16).attr("y", 0)
                .style("font-size", `${fs}px`).style("fill", fc).text(s.name);
            xOff += ((t.node() as SVGTextElement).getComputedTextLength?.() || s.name.length * 7) + 30;
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
