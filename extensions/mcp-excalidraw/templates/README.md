# Canvas Templates

Starter templates for the Canvas Pro shell (`ui/src/ui/views/canvas-pro/`).

Each template is a JSON file with:

```jsonc
{
  "id": "ebook-cover-minimal",
  "category": "ebook",
  "name": "Ebook · Minimal cover",
  "width": 1240,
  "height": 1754,
  "background": "#ffffff",
  "scene": {
    "elements": [ /* excalidraw elements */ ],
    "appState": {},
    "files": {}
  }
}
```

The shell's `loadTemplates()` fetches `/canvas-templates/index.json`. The
build step (TODO: sibling agent) is expected to copy this directory to
the static asset root under `canvas-templates/`. Until that lands the
shell falls back to inline seed templates so the panel never renders
empty.

Categories:

- `social` — square social posts (1080×1080)
- `story` — 9:16 stories (1080×1920)
- `ebook` — A-ish page (1240×1754)
- `workbook` — exercise pages
- `planner` — daily/weekly planners
- `invoice` — A4 invoices
- `lead-magnet` — opt-in covers (1080×1350)
- `worksheet` — fill-in worksheets
- `course-thumbnail` — 16:9 course images (1280×720)
