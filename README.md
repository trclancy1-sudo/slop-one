# slop-one

Power BI custom visuals monorepo.

## Visuals

| Visual | Description |
|--------|-------------|
| [line-and-stacked-column-chart](visuals/line-and-stacked-column-chart) | A combined line and stacked column chart |

## Getting Started

Each visual is an independent Power BI custom visual project. To work on a visual:

```bash
cd visuals/<visual-name>
npm install
pbiviz start     # Start dev server
pbiviz package   # Build .pbiviz package
```

## Prerequisites

- Node.js 18+
- [powerbi-visuals-tools](https://www.npmjs.com/package/powerbi-visuals-tools) (`npm install -g powerbi-visuals-tools`)
