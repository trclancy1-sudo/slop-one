"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

const FONT_ITEMS = [
    { value: "Segoe UI", displayName: "Segoe UI" },
    { value: "Segoe UI Light", displayName: "Segoe UI Light" },
    { value: "Segoe UI Semibold", displayName: "Segoe UI Semibold" },
    { value: "Segoe UI Bold", displayName: "Segoe UI Bold" },
    { value: "Arial", displayName: "Arial" },
    { value: "Arial Black", displayName: "Arial Black" },
    { value: "Arial Unicode MS", displayName: "Arial Unicode MS" },
    { value: "Calibri", displayName: "Calibri" },
    { value: "Calibri Light", displayName: "Calibri Light" },
    { value: "Cambria", displayName: "Cambria" },
    { value: "Candara", displayName: "Candara" },
    { value: "Comic Sans MS", displayName: "Comic Sans MS" },
    { value: "Consolas", displayName: "Consolas" },
    { value: "Constantia", displayName: "Constantia" },
    { value: "Corbel", displayName: "Corbel" },
    { value: "Courier New", displayName: "Courier New" },
    { value: "DIN", displayName: "DIN" },
    { value: "Franklin Gothic", displayName: "Franklin Gothic" },
    { value: "Franklin Gothic Book", displayName: "Franklin Gothic Book" },
    { value: "Georgia", displayName: "Georgia" },
    { value: "Impact", displayName: "Impact" },
    { value: "Lucida Console", displayName: "Lucida Console" },
    { value: "Lucida Sans Unicode", displayName: "Lucida Sans Unicode" },
    { value: "Palatino Linotype", displayName: "Palatino Linotype" },
    { value: "Tahoma", displayName: "Tahoma" },
    { value: "Times New Roman", displayName: "Times New Roman" },
    { value: "Trebuchet MS", displayName: "Trebuchet MS" },
    { value: "Verdana", displayName: "Verdana" },
    { value: "wf_standard-font", displayName: "Power BI Standard" }
];

const ANIMATION_ITEMS = [
    { value: "growUp", displayName: "Grow Up" },
    { value: "fadeIn", displayName: "Fade In" },
    { value: "spring", displayName: "Spring" },
    { value: "slideLeft", displayName: "Slide Left" },
    { value: "bounce", displayName: "Bounce" },
    { value: "expandCenter", displayName: "Expand from Center" },
    { value: "none", displayName: "None" }
];

class AnimationSettingsCard extends FormattingSettingsCard {
    entranceStyle = new formattingSettings.ItemDropdown({
        name: "entranceStyle",
        displayName: "Entrance Animation",
        description: "Animation when visual first appears (page navigation, bookmarks)",
        items: ANIMATION_ITEMS,
        value: { value: "growUp", displayName: "Grow Up" }
    });

    crossFilterStyle = new formattingSettings.ItemDropdown({
        name: "crossFilterStyle",
        displayName: "Cross-Filter Animation",
        description: "Animation when data changes via cross-filtering from another visual",
        items: ANIMATION_ITEMS,
        value: { value: "spring", displayName: "Spring" }
    });

    duration = new formattingSettings.NumUpDown({
        name: "duration",
        displayName: "Animation Duration (ms)",
        value: 800
    });

    name: string = "animation";
    displayName: string = "Animation";
    slices: Array<FormattingSettingsSlice> = [this.entranceStyle, this.crossFilterStyle, this.duration];
}

class FontSettingsCard extends FormattingSettingsCard {
    fontFamily = new formattingSettings.ItemDropdown({
        name: "fontFamily",
        displayName: "Font Family",
        items: FONT_ITEMS,
        value: { value: "Segoe UI", displayName: "Segoe UI" }
    });

    name: string = "fontSettings";
    displayName: string = "Font";
    slices: Array<FormattingSettingsSlice> = [this.fontFamily];
}

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

    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius",
        displayName: "Corner Radius",
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
        this.fill, this.borderColor, this.borderWidth, this.cornerRadius,
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

    fontFamily = new formattingSettings.ItemDropdown({
        name: "fontFamily",
        displayName: "Font Family",
        items: FONT_ITEMS,
        value: { value: "Segoe UI", displayName: "Segoe UI" }
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

    maxWidth = new formattingSettings.NumUpDown({
        name: "maxWidth",
        displayName: "Label Max Width (px)",
        description: "Maximum width for category labels before wrapping. 0 = auto (bandwidth)",
        value: 0
    });

    name: string = "xAxis";
    displayName: string = "X Axis";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontFamily, this.fontSize, this.fontColor, this.title, this.maxWidth];
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

export class SeriesColorsCard extends FormattingSettingsCard {
    name: string = "colorSelector";
    displayName: string = "Series Colors";
    slices: Array<FormattingSettingsSlice> = [];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    animationCard = new AnimationSettingsCard();
    fontSettingsCard = new FontSettingsCard();
    columnSettingsCard = new ColumnSettingsCard();
    lineSettingsCard = new LineSettingsCard();
    seriesColorsCard = new SeriesColorsCard();
    legendCard = new LegendSettingsCard();
    gridlinesCard = new GridlinesCard();
    xAxisCard = new XAxisSettingsCard();
    yAxisCard = new YAxisSettingsCard();

    cards = [
        this.animationCard, this.fontSettingsCard,
        this.columnSettingsCard, this.lineSettingsCard,
        this.seriesColorsCard,
        this.legendCard, this.gridlinesCard,
        this.xAxisCard, this.yAxisCard
    ];
}
