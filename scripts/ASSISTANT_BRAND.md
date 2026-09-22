# Assistant brand assets

Approved on 22/09/2026: angular Z frame, connected robot side blocks and one open optical lens. No aperture blades or literal eye shape. The existing live Zuychin/Assistant text remains the wordmark.

## Source and assets

`public/zuychin-agent-master.svg` is the authoritative vector. Its lens ring and reflection are transparent cut-outs, so the mark works as an existing CSS mask in both themes. Preserve its geometry when making variants.

`scripts/generate-brand.cjs` produces nine assets from this source:

- Navigation SVG and system-themed SVG favicon.
- Opaque Apple 180 px and PWA 192/512 px icons.
- Maskable 512 px icon with the mark inside the central 80% safe circle.
- Transparent, white 72 px notification badge.
- Existing Windows desktop PNG and four-frame ICO source assets.

Light foreground is black. Reversed foreground is `#f8fafc` on the existing `#0f172a` dark background. The ivory background in the approved presentation is not an app theme change. Header dimensions remain 46×36 px and 35×27 px.

## Regeneration

Use an already installed Sharp module, without adding a runtime dependency. The accepted outputs use Sharp 0.35.4.

```powershell
$env:BRAND_SHARP_MODULE = 'C:/Users/kduy1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'
node scripts/generate-brand.cjs --sharp-module $env:BRAND_SHARP_MODULE
node scripts/generate-brand.cjs --sharp-module $env:BRAND_SHARP_MODULE --check
node --test --test-isolation=none scripts/brand-assets.test.cjs
```

## Verification and limits

Ten focused asset tests, exact regeneration, scoped ESLint, project TypeScript and `git diff --check` passed. An independent Astra review rendered the actual assets and source-derived header masks in Chrome 153, light and dark, with zero browser errors. The 16 px favicon retains the silhouette but its fine lens detail is dense.

The approved raster and prompt remain in the sibling Arcade repository at `docs/design/assistant-logo-concepts/10-bare-lens-agent.png` and `bare-lens-prompt.json`. Browser evidence is in that repository at `.tmp-qa-evidence/2026-09-22/assistant-brand/review-02/`. These are review records, not runtime dependencies.

This validation covers local asset integration. Full-app, installed-PWA and native desktop acceptance remain unverified. No desktop rebuild was performed. Deferred Council implementation and configuration are outside this brand change.
