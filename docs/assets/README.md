# Brand assets

Original CueLine artwork. Plain SVG, no external fonts, no embedded raster images, no third-party material.

| File | Use |
|---|---|
| `cueline-mark-{light,dark}.svg` | Square mark, 48×48 grid. Readable down to 16 px. |
| `cueline-wordmark-{light,dark}.svg` | Wordmark alone, for headers and docs. |
| `cueline-banner-{light,dark}.svg` | README banner, 1280×320. |
| `cueline-loop-{en,zh-TW,zh-CN,ja,ko}.svg` | The run figure, 1000×590, one per README language. |
| `cueline-architecture-{en,zh-TW,zh-CN,ja,ko}.svg` | The architecture figure, 1000×530, one per README language. |
| `cueline-states-{en,zh-TW,zh-CN,ja,ko}.svg` | The run-state ladder, 1000×424, one per README language. |

The mark, wordmark, and banner ship as a light/dark pair; pick one with a `<picture>` block so GitHub serves the right file:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cueline-banner-dark.svg">
  <img alt="CueLine" src="docs/assets/cueline-banner-light.svg">
</picture>
```

The run, architecture, and state figures are a single file per language instead: each carries its own `@media (prefers-color-scheme: dark)` block and a transparent ground, so one `<img>` serves both themes and sits directly on the reader's canvas.

## The mark

A stage manager marks a cue in the margin of the promptbook: a vertical rule down the page, a caret at the exact line where the cue lands. That is the whole product in one drawing — the controller calls the cue, the line it points at is the work, and everything around it stays quiet.

The vertical rule is the control loop. The caret is the accepted command. Three horizontal lines are the run; only the cued one is at full weight.

## The run figure

The figure is not a flowchart. It is the promptbook itself: two columns with the cue line down the middle, the controller speaking on the left, the machine working on the right, and one round per group of lines. Commands enter the line as a cue caret; observations leave it. Everything is monospaced, because the whole exchange is a printed log.

## Geometry

Everything sits on a 48-unit grid with a 3-unit stroke and butt caps. The wordmark is monoline geometric — drawn as paths, so it renders identically without a font. Cap height 32, stroke 3, uniform 10-unit letter gaps. Do not re-set the wordmark in a system font.

## Palette

| Role | Light | Dark |
|---|---|---|
| Ink | `#0F1720` | `#E6EDF3` |
| Muted | `#5B6672` | `#8B949E` |
| Rule | `#D5DBE2` | `#262C34` |
| Ground | `#FBFBFC` | `#0D1117` |
| Cue | `#C8553D` | `#E0674C` |

The cue colour is the only accent, and it is only ever applied to the caret and the single cue tick. It is a tally-light red held back to a print vermilion. If a second accent is ever needed, the answer is no.

## Not this

Gradients, glow, glass, neon, circuitry, brains, robots, isometric clouds, decorative emoji. CueLine is a control surface, not a launch page.
