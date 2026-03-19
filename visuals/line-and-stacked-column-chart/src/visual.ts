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

import { VisualFormattingSettingsModel } from "./settings";

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

const DEFAULT_COLUMN_COLORS = ["#4682B4", "#5B9BD5", "#2E75B6", "#7FAADC", "#A9C4E8", "#1F4E79"];
const DEFAULT_LINE_COLORS = ["#FF6347", "#E84C30", "#FF8C69", "#CD5C5C"];

function getDashArray(style: string, width: number): string {
    switch (style) {
        case "dashed": return `${width * 4},${width * 3}`;
        case "dotted": return `${width},${width * 2}`;
        default: return "none";
    }
}

/**
 * Auto-format a numeric value using its Power BI format string.
 * Falls back to smart formatting (K/M/B) if no format is available.
 */
function autoFormatValue(value: number, formatString: string): string {
    if (formatString) {
        const isPercent = formatString.includes("%");
        const isCurrency = formatString.includes("$") || formatString.includes("£") || formatString.includes("€");
        // Extract decimal places from format string like "0.00" or "#,##0.0"
        const decMatch = formatString.match(/\.(0+|#+)/);
        const decimals = decMatch ? decMatch[1].length : (isPercent ? 1 : 0);

        if (isPercent) {
            // Power BI stores percentages as decimals (0.5 = 50%)
            return (value * 100).toFixed(decimals) + "%";
        }

        const currSymbol = isCurrency
            ? (formatString.includes("£") ? "£" : formatString.includes("€") ? "€" : "$")
            : "";

        if (isCurrency) {
            return currSymbol + compactNumber(value, decimals > 0 ? decimals : 2);
        }

        // Has explicit format but not % or $: use decimal precision from format
        if (decMatch) {
            return compactNumber(value, decimals);
        }
    }

    // No format string — smart compact formatting
    return compactNumber(value, 1);
}

function compactNumber(value: number, decimals: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e9) return (value / 1e9).toFixed(decimals) + "B";
    if (abs >= 1e6) return (value / 1e6).toFixed(decimals) + "M";
    if (abs >= 1e3) return (value / 1e3).toFixed(decimals) + "K";
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(decimals);
}

/**
 * Create a d3 axis tick formatter that auto-formats based on the range of values.
 */
function axisFormatter(formatString: string): (value: number) => string {
    return (value: number) => autoFormatValue(value, formatString);
}

/**
 * Draw a rectangle with only the top corners rounded (for stacked bars).
 * Returns an SVG path string.
 */
function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
    r = Math.min(r, w / 2, h);
    if (r <= 0 || h <= 0) {
        return `M${x},${y}h${w}v${h}h${-w}Z`;
    }
    return `M${x},${y + r}`
        + `a${r},${r} 0 0 1 ${r},${-r}`
        + `h${w - 2 * r}`
        + `a${r},${r} 0 0 1 ${r},${r}`
        + `v${h - r}`
        + `h${-w}`
        + `Z`;
}

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost;
    private selectionManager: ISelectionManager;
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private chartGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
    private tooltipDiv: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

    private static readonly ANIMATION_DURATION = 800;
    private static readonly ANIMATION_STAGGER = 80;

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

        // Tooltip div
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

        // Clear selection on background click
        this.svg.on("click", () => {
            this.selectionManager.clear();
            this.chartGroup.selectAll(".column-bar").style("opacity", 0.85);
            this.chartGroup.selectAll(".line-path").style("opacity", 1);
            this.chartGroup.selectAll(".line-marker").style("opacity", 1);
        });
    }

    public update(options: VisualUpdateOptions) {
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
            VisualFormattingSettingsModel,
            options.dataViews?.[0]
        );

        const dataView = options.dataViews?.[0];
        if (!dataView?.categorical?.categories?.[0]) {
            this.svg.selectAll("g.chart-group > *").remove();
            return;
        }

        const width = options.viewport.width;
        const height = options.viewport.height;

        this.svg
            .attr("width", width)
            .attr("height", height);

        const showLegend = this.formattingSettings.legendCard.show.value;
        const legendPos = this.formattingSettings.legendCard.position.value?.value || "bottom";

        const legendSpace = showLegend ? 40 : 0;
        const margin = { top: 20, right: 50, bottom: 50, left: 50 };

        if (showLegend) {
            if (legendPos === "top") margin.top += legendSpace;
            else if (legendPos === "bottom") margin.bottom += legendSpace;
            else if (legendPos === "left") margin.left += legendSpace + 60;
            else if (legendPos === "right") margin.right += legendSpace + 60;
        }

        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;

        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${margin.left},${margin.top})`);

        const { data, series, columnFormat, lineFormat } = this.parseData(dataView.categorical);

        this.render(data, series, plotWidth, plotHeight, margin, columnFormat, lineFormat);
    }

    private parseData(categorical: DataViewCategorical): {
        data: ChartDataPoint[];
        series: SeriesInfo[];
        columnFormat: string;
        lineFormat: string;
    } {
        const categories = categorical.categories[0];
        const catValues = categories.values as string[];
        const values = categorical.values;
        const series: SeriesInfo[] = [];

        const userColumnColor = this.formattingSettings.columnSettingsCard.fill.value.value;
        const userLineColor = this.formattingSettings.lineSettingsCard.fill.value.value;

        const columnMeasures: DataViewValueColumn[] = [];
        const lineMeasures: DataViewValueColumn[] = [];

        let columnFormat = "";
        let lineFormat = "";

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

        const data: ChartDataPoint[] = catValues.map((cat, i) => {
            const selectionId = this.host.createSelectionIdBuilder()
                .withCategory(categories, i)
                .createSelectionId();

            return {
                category: String(cat),
                selectionId,
                columnValues: columnMeasures.map((col, ci) => ({
                    name: col.source.displayName,
                    value: Number(col.values[i]) || 0,
                    color: ci === 0
                        ? userColumnColor
                        : DEFAULT_COLUMN_COLORS[ci % DEFAULT_COLUMN_COLORS.length],
                    format: col.source.format || ""
                })),
                lineValues: lineMeasures.map((col, li) => ({
                    name: col.source.displayName,
                    value: Number(col.values[i]) || 0,
                    color: li === 0
                        ? userLineColor
                        : DEFAULT_LINE_COLORS[li % DEFAULT_LINE_COLORS.length],
                    format: col.source.format || ""
                }))
            };
        });

        return { data, series, columnFormat, lineFormat };
    }

    private render(
        data: ChartDataPoint[],
        series: SeriesInfo[],
        plotWidth: number,
        plotHeight: number,
        margin: { top: number; right: number; bottom: number; left: number },
        columnFormat: string,
        lineFormat: string
    ) {
        this.chartGroup.selectAll("*").remove();

        if (data.length === 0) return;

        const tooltipDiv = this.tooltipDiv;
        const selectionManager = this.selectionManager;

        // Scales
        const xScale = d3.scaleBand()
            .domain(data.map(d => d.category))
            .range([0, plotWidth])
            .padding(0.3);

        const maxColumnStack = d3.max(data, d =>
            d.columnValues.reduce((sum, v) => sum + v.value, 0)
        ) || 0;

        const maxLineValue = d3.max(data, d =>
            d3.max(d.lineValues, v => v.value) || 0
        ) || 0;

        const yScaleLeft = d3.scaleLinear()
            .domain([0, maxColumnStack * 1.1 || 1])
            .nice()
            .range([plotHeight, 0]);

        const yScaleRight = d3.scaleLinear()
            .domain([0, maxLineValue * 1.1 || 1])
            .nice()
            .range([plotHeight, 0]);

        // Gridlines
        const gridSettings = this.formattingSettings.gridlinesCard;
        const gridColor = gridSettings.color.value.value;
        const gridWidth = gridSettings.strokeWidth.value;
        const gridStyle = String(gridSettings.lineStyle.value?.value || "dashed");
        const gridDash = getDashArray(gridStyle, gridWidth);

        if (gridSettings.showHorizontal.value) {
            const gridGroup = this.chartGroup.append("g").classed("gridlines-h", true);
            yScaleLeft.ticks(6).forEach(t => {
                gridGroup.append("line")
                    .attr("x1", 0).attr("x2", plotWidth)
                    .attr("y1", yScaleLeft(t)).attr("y2", yScaleLeft(t))
                    .attr("stroke", gridColor).attr("stroke-width", gridWidth)
                    .attr("stroke-dasharray", gridDash);
            });
        }

        if (gridSettings.showVertical.value) {
            const gridGroup = this.chartGroup.append("g").classed("gridlines-v", true);
            data.forEach(d => {
                const x = xScale(d.category)! + xScale.bandwidth() / 2;
                gridGroup.append("line")
                    .attr("x1", x).attr("x2", x)
                    .attr("y1", 0).attr("y2", plotHeight)
                    .attr("stroke", gridColor).attr("stroke-width", gridWidth)
                    .attr("stroke-dasharray", gridDash);
            });
        }

        // Axes
        const showXAxis = this.formattingSettings.xAxisCard.show.value;
        const showYAxis = this.formattingSettings.yAxisCard.show.value;
        const xFontSize = this.formattingSettings.xAxisCard.fontSize.value;
        const yFontSize = this.formattingSettings.yAxisCard.fontSize.value;
        const xFontColor = this.formattingSettings.xAxisCard.fontColor.value.value;
        const yFontColor = this.formattingSettings.yAxisCard.fontColor.value.value;
        const xTitle = this.formattingSettings.xAxisCard.title.value;
        const yLeftTitle = this.formattingSettings.yAxisCard.leftTitle.value;
        const yRightTitle = this.formattingSettings.yAxisCard.rightTitle.value;

        if (showXAxis) {
            const xAxis = this.chartGroup.append("g")
                .classed("axis x-axis", true)
                .attr("transform", `translate(0,${plotHeight})`)
                .call(d3.axisBottom(xScale));

            xAxis.selectAll("text")
                .style("font-size", `${xFontSize}px`)
                .style("fill", xFontColor)
                .attr("transform", "rotate(-35)")
                .style("text-anchor", "end");

            if (xTitle) {
                this.chartGroup.append("text")
                    .classed("axis-title", true)
                    .attr("x", plotWidth / 2)
                    .attr("y", plotHeight + margin.bottom - 10)
                    .attr("text-anchor", "middle")
                    .style("font-size", `${xFontSize + 1}px`)
                    .style("fill", xFontColor)
                    .text(xTitle);
            }
        }

        if (showYAxis) {
            if (data.some(d => d.columnValues.length > 0)) {
                this.chartGroup.append("g")
                    .classed("axis y-axis-left", true)
                    .call(
                        d3.axisLeft(yScaleLeft)
                            .ticks(6)
                            .tickFormat(d => axisFormatter(columnFormat)(d as number))
                    )
                    .selectAll("text")
                    .style("font-size", `${yFontSize}px`)
                    .style("fill", yFontColor);

                if (yLeftTitle) {
                    this.chartGroup.append("text")
                        .classed("axis-title", true)
                        .attr("transform", "rotate(-90)")
                        .attr("x", -plotHeight / 2)
                        .attr("y", -margin.left + 14)
                        .attr("text-anchor", "middle")
                        .style("font-size", `${yFontSize + 1}px`)
                        .style("fill", yFontColor)
                        .text(yLeftTitle);
                }
            }

            if (data.some(d => d.lineValues.length > 0)) {
                this.chartGroup.append("g")
                    .classed("axis y-axis-right", true)
                    .attr("transform", `translate(${plotWidth},0)`)
                    .call(
                        d3.axisRight(yScaleRight)
                            .ticks(6)
                            .tickFormat(d => axisFormatter(lineFormat)(d as number))
                    )
                    .selectAll("text")
                    .style("font-size", `${yFontSize}px`)
                    .style("fill", yFontColor);

                if (yRightTitle) {
                    this.chartGroup.append("text")
                        .classed("axis-title", true)
                        .attr("transform", "rotate(90)")
                        .attr("x", plotHeight / 2)
                        .attr("y", -plotWidth - margin.right + 14)
                        .attr("text-anchor", "middle")
                        .style("font-size", `${yFontSize + 1}px`)
                        .style("fill", yFontColor)
                        .text(yRightTitle);
                }
            }
        }

        // Column settings
        const colBorderColor = this.formattingSettings.columnSettingsCard.borderColor.value.value;
        const colBorderWidth = this.formattingSettings.columnSettingsCard.borderWidth.value;
        const colShowLabels = this.formattingSettings.columnSettingsCard.showDataLabels.value;
        const colLabelFontSize = this.formattingSettings.columnSettingsCard.dataLabelFontSize.value;
        const colLabelColor = this.formattingSettings.columnSettingsCard.dataLabelColor.value.value;
        const cornerRadius = this.formattingSettings.columnSettingsCard.cornerRadius.value;

        // Draw stacked columns
        if (data[0].columnValues.length > 0) {
            const columnGroup = this.chartGroup.append("g").classed("columns", true);
            const numSegments = data[0].columnValues.length;

            data.forEach((d, catIndex) => {
                let yOffset = 0;
                d.columnValues.forEach((cv, segIndex) => {
                    const barHeight = yScaleLeft(0) - yScaleLeft(cv.value);
                    const finalY = yScaleLeft(yOffset + cv.value);
                    const barX = xScale(d.category)!;
                    const barW = xScale.bandwidth();

                    // Only apply corner radius to the topmost segment
                    const isTopSegment = segIndex === numSegments - 1;
                    const r = isTopSegment ? cornerRadius : 0;

                    if (r > 0 && isTopSegment) {
                        // Use path for rounded top corners
                        const bar = columnGroup.append("path")
                            .classed("column-bar", true)
                            .attr("d", roundedTopRect(barX, plotHeight, barW, 0, 0))
                            .attr("fill", cv.color);

                        if (colBorderWidth > 0) {
                            bar.attr("stroke", colBorderColor).attr("stroke-width", colBorderWidth);
                        }

                        bar.on("click", function (event: MouseEvent) {
                            event.stopPropagation();
                            selectionManager.select(d.selectionId, event.ctrlKey || event.metaKey);
                            highlightSelection(d.selectionId);
                        })
                        .on("mouseover", function (event: MouseEvent) {
                            tooltipDiv.style("display", "block")
                                .html(`<strong>${d.category}</strong><br/>${cv.name}: ${autoFormatValue(cv.value, cv.format)}`);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });

                        bar.transition()
                            .duration(Visual.ANIMATION_DURATION)
                            .delay(catIndex * Visual.ANIMATION_STAGGER)
                            .ease(d3.easeCubicOut)
                            .attr("d", roundedTopRect(barX, finalY, barW, barHeight, r));
                    } else {
                        // Use rect for non-rounded segments
                        const rect = columnGroup.append("rect")
                            .classed("column-bar", true)
                            .attr("x", barX).attr("y", plotHeight)
                            .attr("width", barW).attr("height", 0)
                            .attr("fill", cv.color);

                        if (colBorderWidth > 0) {
                            rect.attr("stroke", colBorderColor).attr("stroke-width", colBorderWidth);
                        }

                        rect.on("click", function (event: MouseEvent) {
                            event.stopPropagation();
                            selectionManager.select(d.selectionId, event.ctrlKey || event.metaKey);
                            highlightSelection(d.selectionId);
                        })
                        .on("mouseover", function (event: MouseEvent) {
                            tooltipDiv.style("display", "block")
                                .html(`<strong>${d.category}</strong><br/>${cv.name}: ${autoFormatValue(cv.value, cv.format)}`);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });

                        rect.transition()
                            .duration(Visual.ANIMATION_DURATION)
                            .delay(catIndex * Visual.ANIMATION_STAGGER)
                            .ease(d3.easeCubicOut)
                            .attr("y", finalY).attr("height", barHeight);
                    }

                    // Data label on column segment
                    if (colShowLabels && cv.value > 0) {
                        columnGroup.append("text")
                            .classed("data-label", true)
                            .attr("x", barX + barW / 2)
                            .attr("y", finalY + barHeight / 2 + colLabelFontSize / 3)
                            .attr("text-anchor", "middle")
                            .style("font-size", `${colLabelFontSize}px`)
                            .style("fill", colLabelColor)
                            .style("pointer-events", "none")
                            .style("opacity", 0)
                            .text(autoFormatValue(cv.value, cv.format))
                            .transition()
                            .duration(Visual.ANIMATION_DURATION)
                            .delay(catIndex * Visual.ANIMATION_STAGGER)
                            .style("opacity", 1);
                    }

                    yOffset += cv.value;
                });
            });
        }

        // Highlight helper for selection
        const chartGroup = this.chartGroup;
        function highlightSelection(selectedId: ISelectionId) {
            const hasSelection = selectionManager.hasSelection();
            chartGroup.selectAll(".column-bar").style("opacity", function () {
                return hasSelection ? 0.3 : 0.85;
            });
            if (hasSelection) {
                // Find bars belonging to the selected category and highlight them
                data.forEach((d, catIdx) => {
                    if (d.selectionId === selectedId) {
                        chartGroup.selectAll(".column-bar")
                            .filter(function (_d: unknown, i: number) {
                                const numSegs = data[0].columnValues.length;
                                const startIdx = catIdx * numSegs;
                                return i >= startIdx && i < startIdx + numSegs;
                            })
                            .style("opacity", 0.85);
                    }
                });
            }
        }

        // Line settings
        const lineWidth = this.formattingSettings.lineSettingsCard.strokeWidth.value;
        const showMarkers = this.formattingSettings.lineSettingsCard.showMarkers.value;
        const markerSize = this.formattingSettings.lineSettingsCard.markerSize.value;
        const lineStyleVal = String(this.formattingSettings.lineSettingsCard.lineStyle.value?.value || "solid");
        const lineDash = getDashArray(lineStyleVal, lineWidth);
        const lineShowLabels = this.formattingSettings.lineSettingsCard.showDataLabels.value;
        const lineLabelFontSize = this.formattingSettings.lineSettingsCard.dataLabelFontSize.value;
        const lineLabelColor = this.formattingSettings.lineSettingsCard.dataLabelColor.value.value;
        const lineDuration = Visual.ANIMATION_DURATION + data.length * Visual.ANIMATION_STAGGER;

        // Draw lines
        if (data[0].lineValues.length > 0) {
            const lineGroup = this.chartGroup.append("g").classed("lines", true);

            const numLineSeries = data[0].lineValues.length;
            for (let li = 0; li < numLineSeries; li++) {
                const color = data[0].lineValues[li].color;
                const fmt = data[0].lineValues[li].format;

                const lineGen = d3.line<ChartDataPoint>()
                    .x(d => xScale(d.category)! + xScale.bandwidth() / 2)
                    .y(d => yScaleRight(d.lineValues[li].value))
                    .curve(d3.curveMonotoneX);

                const path = lineGroup.append("path")
                    .datum(data)
                    .classed("line-path", true)
                    .attr("d", lineGen)
                    .attr("stroke", color)
                    .attr("stroke-width", lineWidth);

                if (lineDash !== "none") {
                    path.attr("stroke-dasharray", lineDash);
                } else {
                    const pathNode = path.node() as SVGPathElement;
                    const totalLength = pathNode.getTotalLength();
                    path
                        .attr("stroke-dasharray", totalLength)
                        .attr("stroke-dashoffset", totalLength)
                        .transition()
                        .duration(lineDuration)
                        .ease(d3.easeLinear)
                        .attr("stroke-dashoffset", 0);
                }

                if (showMarkers) {
                    data.forEach((d, i) => {
                        const cx = xScale(d.category)! + xScale.bandwidth() / 2;
                        const cy = yScaleRight(d.lineValues[li].value);

                        const marker = lineGroup.append("circle")
                            .classed("line-marker", true)
                            .attr("cx", cx).attr("cy", cy)
                            .attr("r", 0).attr("fill", color);

                        marker.on("click", function (event: MouseEvent) {
                            event.stopPropagation();
                            selectionManager.select(d.selectionId, event.ctrlKey || event.metaKey);
                        })
                        .on("mouseover", function (event: MouseEvent) {
                            tooltipDiv.style("display", "block")
                                .html(`<strong>${d.category}</strong><br/>${d.lineValues[li].name}: ${autoFormatValue(d.lineValues[li].value, fmt)}`);
                        })
                        .on("mousemove", function (event: MouseEvent) {
                            tooltipDiv.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY - 28}px`);
                        })
                        .on("mouseout", function () { tooltipDiv.style("display", "none"); });

                        marker.transition()
                            .duration(200)
                            .delay((i / (data.length - 1 || 1)) * lineDuration)
                            .ease(d3.easeBackOut)
                            .attr("r", markerSize);
                    });
                }

                if (lineShowLabels) {
                    data.forEach((d, i) => {
                        lineGroup.append("text")
                            .classed("data-label", true)
                            .attr("x", xScale(d.category)! + xScale.bandwidth() / 2)
                            .attr("y", yScaleRight(d.lineValues[li].value) - markerSize - 4)
                            .attr("text-anchor", "middle")
                            .style("font-size", `${lineLabelFontSize}px`)
                            .style("fill", lineLabelColor)
                            .style("pointer-events", "none")
                            .style("opacity", 0)
                            .text(autoFormatValue(d.lineValues[li].value, fmt))
                            .transition()
                            .duration(200)
                            .delay((i / (data.length - 1 || 1)) * lineDuration)
                            .style("opacity", 1);
                    });
                }
            }
        }

        // Legend
        const showLegend = this.formattingSettings.legendCard.show.value;
        if (showLegend && series.length > 0) {
            const legendFontSize = this.formattingSettings.legendCard.fontSize.value;
            const legendFontColor = this.formattingSettings.legendCard.fontColor.value.value;
            const legendPos = this.formattingSettings.legendCard.position.value?.value || "bottom";

            const legendGroup = this.chartGroup.append("g").classed("legend", true);

            if (legendPos === "bottom") {
                legendGroup.attr("transform", `translate(0,${plotHeight + margin.bottom - 15})`);
                this.renderHorizontalLegend(legendGroup, series, legendFontSize, legendFontColor);
            } else if (legendPos === "top") {
                legendGroup.attr("transform", `translate(0,${-margin.top + 10})`);
                this.renderHorizontalLegend(legendGroup, series, legendFontSize, legendFontColor);
            } else if (legendPos === "left") {
                legendGroup.attr("transform", `translate(${-margin.left + 5},0)`);
                this.renderVerticalLegend(legendGroup, series, legendFontSize, legendFontColor);
            } else if (legendPos === "right") {
                legendGroup.attr("transform", `translate(${plotWidth + 40},0)`);
                this.renderVerticalLegend(legendGroup, series, legendFontSize, legendFontColor);
            }
        }
    }

    private renderHorizontalLegend(
        legendGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
        series: SeriesInfo[], fontSize: number, fontColor: string
    ) {
        let xOffset = 0;
        series.forEach(s => {
            const item = legendGroup.append("g")
                .classed("legend-item", true)
                .attr("transform", `translate(${xOffset},0)`);

            if (s.type === "column") {
                item.append("rect")
                    .attr("width", 12).attr("height", 12).attr("y", -10)
                    .attr("fill", s.color);
            } else {
                item.append("line")
                    .attr("x1", 0).attr("x2", 12).attr("y1", -4).attr("y2", -4)
                    .attr("stroke", s.color).attr("stroke-width", 2);
            }

            const text = item.append("text")
                .classed("legend-text", true)
                .attr("x", 16).attr("y", 0)
                .style("font-size", `${fontSize}px`)
                .style("fill", fontColor)
                .text(s.name);

            const textWidth = (text.node() as SVGTextElement).getComputedTextLength?.() || s.name.length * 7;
            xOffset += textWidth + 30;
        });
    }

    private renderVerticalLegend(
        legendGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
        series: SeriesInfo[], fontSize: number, fontColor: string
    ) {
        series.forEach((s, i) => {
            const yPos = i * (fontSize + 8);
            const item = legendGroup.append("g")
                .classed("legend-item", true)
                .attr("transform", `translate(0,${yPos})`);

            if (s.type === "column") {
                item.append("rect")
                    .attr("width", 10).attr("height", 10).attr("y", -8)
                    .attr("fill", s.color);
            } else {
                item.append("line")
                    .attr("x1", 0).attr("x2", 10).attr("y1", -3).attr("y2", -3)
                    .attr("stroke", s.color).attr("stroke-width", 2);
            }

            item.append("text")
                .classed("legend-text", true)
                .attr("x", 14).attr("y", 0)
                .style("font-size", `${fontSize}px`)
                .style("fill", fontColor)
                .text(s.name);
        });
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}
