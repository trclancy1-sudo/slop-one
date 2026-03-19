"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

class ColumnSettingsCard extends FormattingSettingsCard {
    fill = new formattingSettings.ColorPicker({
        name: "fill",
        displayName: "Default Column Color",
        value: { value: "#4682B4" }
    });

    borderColor = new formattingSettings.ColorPicker({
        name: "borderColor",
        displayName: "Border Color",
        value: { value: "#333333" }
    });

    borderWidth = new formattingSettings.NumUpDown({
        name: "borderWidth",
        displayName: "Border Width",
        value: 0
    });

    showDataLabels = new formattingSettings.ToggleSwitch({
        name: "showDataLabels",
        displayName: "Show Data Labels",
        value: false
    });

    dataLabelFontSize = new formattingSettings.NumUpDown({
        name: "dataLabelFontSize",
        displayName: "Data Label Font Size",
        value: 10
    });

    dataLabelColor = new formattingSettings.ColorPicker({
        name: "dataLabelColor",
        displayName: "Data Label Color",
        value: { value: "#ffffff" }
    });

    name: string = "columnSettings";
    displayName: string = "Column Settings";
    slices: Array<FormattingSettingsSlice> = [
        this.fill, this.borderColor, this.borderWidth,
        this.showDataLabels, this.dataLabelFontSize, this.dataLabelColor
    ];
}

class LineSettingsCard extends FormattingSettingsCard {
    fill = new formattingSettings.ColorPicker({
        name: "fill",
        displayName: "Default Line Color",
        value: { value: "#FF6347" }
    });

    strokeWidth = new formattingSettings.NumUpDown({
        name: "strokeWidth",
        displayName: "Line Width",
        value: 2
    });

    showMarkers = new formattingSettings.ToggleSwitch({
        name: "showMarkers",
        displayName: "Show Data Points",
        value: true
    });

    markerSize = new formattingSettings.NumUpDown({
        name: "markerSize",
        displayName: "Marker Size",
        value: 4
    });

    showDataLabels = new formattingSettings.ToggleSwitch({
        name: "showDataLabels",
        displayName: "Show Data Labels",
        value: false
    });

    dataLabelFontSize = new formattingSettings.NumUpDown({
        name: "dataLabelFontSize",
        displayName: "Data Label Font Size",
        value: 10
    });

    dataLabelColor = new formattingSettings.ColorPicker({
        name: "dataLabelColor",
        displayName: "Data Label Color",
        value: { value: "#333333" }
    });

    lineStyle = new formattingSettings.ItemDropdown({
        name: "lineStyle",
        displayName: "Line Style",
        items: [
            { value: "solid", displayName: "Solid" },
            { value: "dashed", displayName: "Dashed" },
            { value: "dotted", displayName: "Dotted" }
        ],
        value: { value: "solid", displayName: "Solid" }
    });

    name: string = "lineSettings";
    displayName: string = "Line Settings";
    slices: Array<FormattingSettingsSlice> = [
        this.fill, this.strokeWidth, this.lineStyle,
        this.showMarkers, this.markerSize,
        this.showDataLabels, this.dataLabelFontSize, this.dataLabelColor
    ];
}

class LegendSettingsCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Legend",
        value: true
    });

    position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        items: [
            { value: "bottom", displayName: "Bottom" },
            { value: "top", displayName: "Top" },
            { value: "left", displayName: "Left" },
            { value: "right", displayName: "Right" }
        ],
        value: { value: "bottom", displayName: "Bottom" }
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text Size",
        value: 11
    });

    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Font Color",
        value: { value: "#444444" }
    });

    name: string = "legend";
    displayName: string = "Legend";
    slices: Array<FormattingSettingsSlice> = [this.show, this.position, this.fontSize, this.fontColor];
}

class GridlinesCard extends FormattingSettingsCard {
    showHorizontal = new formattingSettings.ToggleSwitch({
        name: "showHorizontal",
        displayName: "Show Horizontal Gridlines",
        value: true
    });

    showVertical = new formattingSettings.ToggleSwitch({
        name: "showVertical",
        displayName: "Show Vertical Gridlines",
        value: false
    });

    color = new formattingSettings.ColorPicker({
        name: "color",
        displayName: "Gridline Color",
        value: { value: "#e0e0e0" }
    });

    strokeWidth = new formattingSettings.NumUpDown({
        name: "strokeWidth",
        displayName: "Gridline Width",
        value: 1
    });

    lineStyle = new formattingSettings.ItemDropdown({
        name: "lineStyle",
        displayName: "Gridline Style",
        items: [
            { value: "solid", displayName: "Solid" },
            { value: "dashed", displayName: "Dashed" },
            { value: "dotted", displayName: "Dotted" }
        ],
        value: { value: "dashed", displayName: "Dashed" }
    });

    name: string = "gridlines";
    displayName: string = "Gridlines";
    slices: Array<FormattingSettingsSlice> = [
        this.showHorizontal, this.showVertical, this.color, this.strokeWidth, this.lineStyle
    ];
}

class XAxisSettingsCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show X Axis",
        value: true
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text Size",
        value: 11
    });

    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Font Color",
        value: { value: "#666666" }
    });

    title = new formattingSettings.TextInput({
        name: "title",
        displayName: "Axis Title",
        value: "",
        placeholder: "Enter axis title"
    });

    name: string = "xAxis";
    displayName: string = "X Axis";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontSize, this.fontColor, this.title];
}

class YAxisSettingsCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Y Axis",
        value: true
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text Size",
        value: 11
    });

    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Font Color",
        value: { value: "#666666" }
    });

    leftTitle = new formattingSettings.TextInput({
        name: "leftTitle",
        displayName: "Left Axis Title",
        value: "",
        placeholder: "Column values axis"
    });

    rightTitle = new formattingSettings.TextInput({
        name: "rightTitle",
        displayName: "Right Axis Title",
        value: "",
        placeholder: "Line values axis"
    });

    name: string = "yAxis";
    displayName: string = "Y Axis";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontSize, this.fontColor, this.leftTitle, this.rightTitle];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    columnSettingsCard = new ColumnSettingsCard();
    lineSettingsCard = new LineSettingsCard();
    legendCard = new LegendSettingsCard();
    gridlinesCard = new GridlinesCard();
    xAxisCard = new XAxisSettingsCard();
    yAxisCard = new YAxisSettingsCard();

    cards = [
        this.columnSettingsCard, this.lineSettingsCard,
        this.legendCard, this.gridlinesCard,
        this.xAxisCard, this.yAxisCard
    ];
}
