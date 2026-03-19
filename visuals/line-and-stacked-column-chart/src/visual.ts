"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import DataView = powerbi.DataView;
import DataViewCategorical = powerbi.DataViewCategorical;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

import { VisualFormattingSettingsModel } from "./settings";

interface ChartDataPoint {
    category: string;
    columnValues: { name: string; value: number; color: string }[];
    lineValues: { name: string; value: number; color: string }[];
}

interface SeriesInfo {
    name: string;
    color: string;
    type: "column" | "line";
}

const DEFAULT_COLUMN_COLORS = ["#4682B4", "#5B9BD5", "#2E75B6", "#7FAADC", "#A9C4E8", "#1F4E79"];
const DEFAULT_LINE_COLORS = ["#FF6347", "#E84C30", "#FF8C69", "#CD5C5C"];

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost;
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private chartGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

    private margin = { top: 20, right: 40, bottom: 50, left: 50 };
    private static readonly ANIMATION_DURATION = 800;
    private static readonly ANIMATION_STAGGER = 80;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.target = options.element;

        this.svg = d3.select(this.target)
            .append("svg")
            .classed("line-and-stacked-column-chart", true);

        this.chartGroup = this.svg.append("g")
            .classed("chart-group", true);
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
        const legendHeight = showLegend ? 30 : 0;

        const plotWidth = width - this.margin.left - this.margin.right;
        const plotHeight = height - this.margin.top - this.margin.bottom - legendHeight;

        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${this.margin.left},${this.margin.top})`);

        const { data, series } = this.parseData(dataView.categorical);

        this.render(data, series, plotWidth, plotHeight, legendHeight);
    }

    private parseData(categorical: DataViewCategorical): { data: ChartDataPoint[]; series: SeriesInfo[] } {
        const categories = categorical.categories[0].values as string[];
        const values = categorical.values;
        const series: SeriesInfo[] = [];

        const columnMeasures: DataViewValueColumn[] = [];
        const lineMeasures: DataViewValueColumn[] = [];

        if (values) {
            for (let i = 0; i < values.length; i++) {
                const col = values[i];
                const roleName = col.source.roles;

                if (roleName?.["columnValues"]) {
                    columnMeasures.push(col);
                    series.push({
                        name: col.source.displayName,
                        color: DEFAULT_COLUMN_COLORS[columnMeasures.length - 1 % DEFAULT_COLUMN_COLORS.length],
                        type: "column"
                    });
                } else if (roleName?.["lineValues"]) {
                    lineMeasures.push(col);
                    series.push({
                        name: col.source.displayName,
                        color: DEFAULT_LINE_COLORS[lineMeasures.length - 1 % DEFAULT_LINE_COLORS.length],
                        type: "line"
                    });
                }
            }
        }

        const data: ChartDataPoint[] = categories.map((cat, i) => ({
            category: String(cat),
            columnValues: columnMeasures.map((col, ci) => ({
                name: col.source.displayName,
                value: Number(col.values[i]) || 0,
                color: DEFAULT_COLUMN_COLORS[ci % DEFAULT_COLUMN_COLORS.length]
            })),
            lineValues: lineMeasures.map((col, li) => ({
                name: col.source.displayName,
                value: Number(col.values[i]) || 0,
                color: DEFAULT_LINE_COLORS[li % DEFAULT_LINE_COLORS.length]
            }))
        }));

        return { data, series };
    }

    private render(data: ChartDataPoint[], series: SeriesInfo[], plotWidth: number, plotHeight: number, legendHeight: number) {
        this.chartGroup.selectAll("*").remove();

        if (data.length === 0) return;

        // Scales
        const xScale = d3.scaleBand()
            .domain(data.map(d => d.category))
            .range([0, plotWidth])
            .padding(0.3);

        // Compute max for column (stacked) and line y-axes
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

        // Draw axes
        const showXAxis = this.formattingSettings.xAxisCard.show.value;
        const showYAxis = this.formattingSettings.yAxisCard.show.value;
        const xFontSize = this.formattingSettings.xAxisCard.fontSize.value;
        const yFontSize = this.formattingSettings.yAxisCard.fontSize.value;

        if (showXAxis) {
            const xAxis = this.chartGroup.append("g")
                .classed("axis x-axis", true)
                .attr("transform", `translate(0,${plotHeight})`)
                .call(d3.axisBottom(xScale));

            xAxis.selectAll("text")
                .style("font-size", `${xFontSize}px`)
                .attr("transform", "rotate(-35)")
                .style("text-anchor", "end");
        }

        if (showYAxis) {
            // Left Y axis (columns)
            if (data.some(d => d.columnValues.length > 0)) {
                this.chartGroup.append("g")
                    .classed("axis y-axis-left", true)
                    .call(d3.axisLeft(yScaleLeft).ticks(6))
                    .selectAll("text")
                    .style("font-size", `${yFontSize}px`);
            }

            // Right Y axis (lines)
            if (data.some(d => d.lineValues.length > 0)) {
                this.chartGroup.append("g")
                    .classed("axis y-axis-right", true)
                    .attr("transform", `translate(${plotWidth},0)`)
                    .call(d3.axisRight(yScaleRight).ticks(6))
                    .selectAll("text")
                    .style("font-size", `${yFontSize}px`);
            }
        }

        // Draw stacked columns with grow-up animation staggered left to right
        if (data[0].columnValues.length > 0) {
            const columnGroup = this.chartGroup.append("g").classed("columns", true);

            data.forEach((d, catIndex) => {
                let yOffset = 0;
                d.columnValues.forEach(cv => {
                    const barHeight = yScaleLeft(0) - yScaleLeft(cv.value);
                    const finalY = yScaleLeft(yOffset + cv.value);
                    columnGroup.append("rect")
                        .classed("column-rect", true)
                        .attr("x", xScale(d.category))
                        .attr("y", plotHeight)
                        .attr("width", xScale.bandwidth())
                        .attr("height", 0)
                        .attr("fill", cv.color)
                        .transition()
                        .duration(Visual.ANIMATION_DURATION)
                        .delay(catIndex * Visual.ANIMATION_STAGGER)
                        .ease(d3.easeCubicOut)
                        .attr("y", finalY)
                        .attr("height", barHeight);
                    yOffset += cv.value;
                });
            });
        }

        // Draw lines with left-to-right draw animation
        if (data[0].lineValues.length > 0) {
            const lineGroup = this.chartGroup.append("g").classed("lines", true);
            const lineWidth = this.formattingSettings.lineSettingsCard.strokeWidth.value;
            const showMarkers = this.formattingSettings.lineSettingsCard.showMarkers.value;
            const lineDuration = Visual.ANIMATION_DURATION + data.length * Visual.ANIMATION_STAGGER;

            const numLineSeries = data[0].lineValues.length;
            for (let li = 0; li < numLineSeries; li++) {
                const color = data[0].lineValues[li].color;

                const lineGen = d3.line<ChartDataPoint>()
                    .x(d => xScale(d.category) + xScale.bandwidth() / 2)
                    .y(d => yScaleRight(d.lineValues[li].value))
                    .curve(d3.curveMonotoneX);

                const path = lineGroup.append("path")
                    .datum(data)
                    .classed("line-path", true)
                    .attr("d", lineGen)
                    .attr("stroke", color)
                    .attr("stroke-width", lineWidth);

                // Animate line drawing using stroke-dasharray
                const pathNode = path.node() as SVGPathElement;
                const totalLength = pathNode.getTotalLength();
                path
                    .attr("stroke-dasharray", totalLength)
                    .attr("stroke-dashoffset", totalLength)
                    .transition()
                    .duration(lineDuration)
                    .ease(d3.easeLinear)
                    .attr("stroke-dashoffset", 0);

                if (showMarkers) {
                    data.forEach((d, i) => {
                        lineGroup.append("circle")
                            .classed("line-marker", true)
                            .attr("cx", xScale(d.category) + xScale.bandwidth() / 2)
                            .attr("cy", yScaleRight(d.lineValues[li].value))
                            .attr("r", 0)
                            .attr("fill", color)
                            .transition()
                            .duration(200)
                            .delay((i / (data.length - 1 || 1)) * lineDuration)
                            .ease(d3.easeBackOut)
                            .attr("r", 4);
                    });
                }
            }
        }

        // Draw legend
        if (this.formattingSettings.legendCard.show.value && series.length > 0) {
            const legendFontSize = this.formattingSettings.legendCard.fontSize.value;
            const legendGroup = this.chartGroup.append("g")
                .classed("legend", true)
                .attr("transform", `translate(0,${plotHeight + this.margin.bottom - 5})`);

            let xOffset = 0;
            series.forEach(s => {
                const item = legendGroup.append("g")
                    .classed("legend-item", true)
                    .attr("transform", `translate(${xOffset},0)`);

                if (s.type === "column") {
                    item.append("rect")
                        .attr("width", 12)
                        .attr("height", 12)
                        .attr("y", -10)
                        .attr("fill", s.color);
                } else {
                    item.append("line")
                        .attr("x1", 0)
                        .attr("x2", 12)
                        .attr("y1", -4)
                        .attr("y2", -4)
                        .attr("stroke", s.color)
                        .attr("stroke-width", 2);
                }

                const text = item.append("text")
                    .classed("legend-text", true)
                    .attr("x", 16)
                    .attr("y", 0)
                    .style("font-size", `${legendFontSize}px`)
                    .text(s.name);

                const textWidth = (text.node() as SVGTextElement).getComputedTextLength?.() || s.name.length * 7;
                xOffset += textWidth + 30;
            });
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}
