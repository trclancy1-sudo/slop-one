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

    name: string = "columnSettings";
    displayName: string = "Column Settings";
    slices: Array<FormattingSettingsSlice> = [this.fill];
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

    name: string = "lineSettings";
    displayName: string = "Line Settings";
    slices: Array<FormattingSettingsSlice> = [this.fill, this.strokeWidth, this.showMarkers];
}

class LegendSettingsCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Legend",
        value: true
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text Size",
        value: 11
    });

    name: string = "legend";
    displayName: string = "Legend";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontSize];
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

    name: string = "xAxis";
    displayName: string = "X Axis";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontSize];
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

    name: string = "yAxis";
    displayName: string = "Y Axis";
    slices: Array<FormattingSettingsSlice> = [this.show, this.fontSize];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    columnSettingsCard = new ColumnSettingsCard();
    lineSettingsCard = new LineSettingsCard();
    legendCard = new LegendSettingsCard();
    xAxisCard = new XAxisSettingsCard();
    yAxisCard = new YAxisSettingsCard();

    cards = [this.columnSettingsCard, this.lineSettingsCard, this.legendCard, this.xAxisCard, this.yAxisCard];
}
