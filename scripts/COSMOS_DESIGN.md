---
name: Knowledge Cosmos
description: Scoped visual and interaction contract for the existing knowledge graph.
colors:
  background: "#05060a"
  text: "#e8ecf8"
  muted: "#8b93ad"
  panel: "rgba(11,13,22,0.82)"
  panel-solid: "#0b0d16"
  border: "rgba(126,141,184,0.18)"
  sources: "#ffb545"
  concepts: "#6ba7ff"
  entities: "#45e0a8"
  synthesis: "#c07bff"
---

# Knowledge Cosmos refinement

## Overview

This records the implemented `/graph` refinement as of 23/09/2026. It preserves the existing Zuychin identity and semantic category colours. It does not define a new global design system or advance the deferred Council V4 work.

The selected direction blends cinematic realism with a scientific atlas. The cosmos remains an interactive map for finding and reading knowledge: pages are distant stars; an opened page becomes a system whose planets represent sections and whose moons represent deeper headings. Detailed materials and restrained stellar light support immersion; numbered section labels, predictable selection and a readable outline support orientation. Usability and successful reading remain acceptance criteria for the visual work.

Source authority: `src/app/graph/page.tsx`, `cosmos/{palette,scene,textures,stellar,orbits,clearance,navigation,labels,sections,model,styles}.ts` and `panels/page-panel.tsx`, relative to `src/app/graph/` for the latter paths. This document records source behaviour; the verification boundary below distinguishes it from tested behaviour.

## Colors

The incumbent dark cosmos palette remains independent of the app theme. Near-black space supports restrained nebulae, luminous page stars and legible panels. The category tokens above remain semantic: sources are amber, concepts blue, entities green and synthesis violet. Trust, health and other lenses retain their existing mappings in `palette.ts`.

Planet surfaces use deterministic natural material variation. Their shading is separate from category identity, which remains visible in page stars, category controls and badges. Warm light originates at the selected root star; highlights must communicate that common light source.

## Typography

The interface inherits the existing app font through `--font-family`; paths and editing use `--font-mono`. The compact hierarchy uses a 13px interface base, 14px page title and 15px reader title. Document text is 14px with 1.7 line height. Heading levels remain semantic, with a restrained 14–19px visual scale.

Visible focus outlines, wrapping document text and scrollable code/table content support reading. Small metadata styles are incumbent local styles, not a new global typography standard.

## Layout

Desktop canvas bounds reserve space for visible side rails. Below 760px, one bottom dock holds either the selected page or controls; selection takes precedence. The mobile canvas also reserves the measured toolbar and, when the dock is closed, the system banner. The toolbar stays on one row on mobile, and the system controls remain available after closing the reader.

The renderer measures its own container with `ResizeObserver`. System framing considers the narrower horizontal or vertical field of view. Aspect changes preserve the current target, viewing direction and relative zoom instead of resetting the user's view. Opening or closing a rail or dock therefore changes available space without discarding navigation intent. Visible zoom and fit controls support inspecting the wider orbital spacing on small screens; they disappear when the expanded reader leaves too little canvas space.

The system title in the banner or mobile reader dock is a “Fit system” button. It and the `f` keyboard shortcut frame the current local system; outside a system, the general fit action frames the graph. Fitting uses the full orbital envelope, including moons and rings.

The reader's document navigation is sticky within its containing rail. Section jumps account for that navigation height and move the document's own scroll position without scrolling the canvas.

## Elevation & Depth

Planets and moons are actual sphere meshes with opaque standard materials. Planet maps use a 512 × 256 spherical surface, with 256 × 128 maps for moons. Terrain, craters and bump detail are deterministic; terran bodies have smoother oceans and a separate cloud shell, gas worlds have turbulent bands and storms, and molten surfaces use restrained emission. Roughness maps distinguish materials instead of applying one uniform finish. Atmosphere rims are separate transparent shells, not substitutes for solid bodies.

Opaque bodies write depth and occlude geometry behind them. Tilted rings map a 1024-sample radial texture to real ring geometry, with fine bands and wider gaps; the planet hides the rear portion. Rings are deterministically assigned to two of five eligible hash buckets for banded or icy sections longer than 400 characters. This eligibility rule does not promise that 40% of every displayed system has rings.

Distant page stars retain sprite cores and coronas, with clearer background pinpoints. The focused root adds an opaque procedural photosphere with granular activity and limb shading. Warm root light, cool ambient light and hemisphere fill preserve both material depth and readable unlit surfaces. Bloom remains an optional effect, not the source of the bodies' shape. Panels retain the existing translucent dark fill, thin border and blur.

## Shapes

The sphere, orbit and tilted ring are the scene's functional forms. Bodies use a 1.5× detail display scale, with orbits inclined around 0.70 radians and slight variation between sections. This makes surfaces and orbital separation readable rather than claiming astronomical scale accuracy. Sections remain outside the force graph's node simulation.

`orbits.ts` calculates each planet's complete radial envelope, including its outer ring, every moon orbit and hover enlargement. Moon orbits clear the parent or ring and each preceding moon envelope; planet envelopes clear the sun halo and one another. Default inner, inter-planet and inter-moon gaps are respectively 0.50, 0.32 and 0.075 times the sun halo radius. All parsed sections and subsections remain represented; the layout does not cap planet or moon counts.

Neighbouring movable page stars use a soft outward force plus a hard boundary after each simulation tick. The boundary from the root is the system's outer radius plus `max(60, 0.15 × outer radius)` plus the neighbouring star's base halo radius. Existing explicit node pins are preserved. Root-connected links target at least `1.3 × outer radius + 72`, or the configured link distance when larger. Background stars start at 0.85 of their normal size; a minimum apparent halo diameter of 22px on narrow canvases and 28px on wider ones keeps them discoverable as the camera moves. These are world-space separation guarantees: perspective can still place physically separate objects in front of one another on screen.

Interface panels retain rounded 14px corners and compact controls generally use 10px corners. These are incumbent component values, not a mandate for other app surfaces.

## Components

### Planet selection and motion

- A planet or moon activates its exact document heading. Its captured `pointerup` is marked consumed before ForceGraph dispatches, preventing a second selection of a neighbouring page underneath it.
- Movement beyond the gesture threshold remains a camera drag, even if the pointer returns to its starting point. Cancelled and additional pointers do not become section clicks.
- Picking favours visible body discs and nearer depth before expanded screen targets. Hover enlarges the body slightly, shows its title and pauses orbital movement for selection.
- Orbits are slowed and explicitly pauseable. Reduced-motion preferences stop orbital movement and remove animated camera transitions. Elapsed-time clamping prevents a large jump after inactivity.
- The focused root is temporarily fixed in the simulation so the reading target cannot drift while neighbours settle. Its previous fixed coordinates are restored on exit, and graph-node dragging is disabled inside a system. Camera dragging remains available.
- Simulation reheating waits for the engine's first tick and populated nodes, avoiding the startup race between system setup and force initialisation.

### Atlas labels

The first 16 main sections are eligible for numbered canvas labels. These are selectable HTML buttons, including keyboard activation, and use the same exact section action as the planet. Hover or focus pauses orbital movement. Labels respect the labels toggle and hide when bodies are too small, the canvas is too short, the label falls outside the visible area or labels collide. Hiding a label does not remove its heading or section: the complete document outline remains available.

Idle background page-star labels are hidden in system view so the section atlas stays readable. Explicitly requested labels, such as a hovered or routed page, retain their priority. This label budget does not limit the underlying bodies or document headings.

### Document reader

`documentHeadings()` parses the same transformed Markdown and CommonMark/GFM structure used by the reader. Stable, duplicate-safe IDs are assigned across all six heading levels, including formatted, Unicode and setext headings. The body hierarchy, rendered heading IDs and keyboard outline share this identity. Selection never uses a title substring as its target. A sole leading H1 is treated as the document title even when its wording differs from metadata; multiple H1 sections remain representable. The reader outline still includes the title heading.

The sticky “In this document” control exposes every heading as a keyboard-operable button. Activating an entry closes the outline, marks the current section, scrolls the exact heading into view and transfers focus to it. Planet selection uses the same reader action.

### Filters, routes and editing

Category state round-trips through the URL: absent `cat` means all enabled, while an empty `cat` preserves all disabled. An empty filtered graph explains the state and offers “Reset filters”; an empty vault has its own message.

Routes use only currently visible real connections. Hidden endpoints or filtered intermediate nodes cannot produce an invisible route. A delayed save response updates the saved page's cache but only exits editing if the selected page and current draft still match that request. These behaviours are source guarantees; browser mutation coverage is not implied.

## Do's and Don'ts

- Do treat successful reading, predictable camera control and recoverable filters as acceptance criteria alongside visual quality.
- Do preserve exact heading identity, opaque body occlusion, semantic category colours and the distinction between a page star and its sections.
- Do keep the reader, pause control, fit action and exit-system action usable in both desktop rails and the mobile dock.
- Don't promote local cosmos styling into a new global identity or use decorative motion as the only way to discover a section.
- Don't canonise inherited small metadata text or other unrelated incumbent styling as new design rules.

### Verification record

At the time of this record:

- `npm run cosmos:test` passed after the spacing correction: six model tests, 21 section assertions, navigation regressions, seven orbital-layout cases and clearance checks. Orbital cases cover all counts through 100 planets and a parent with 100 moons. Clearance uses 180 ticks of the installed force engine with deliberately short links and strong centre pull, then verifies that exiting releases the constraint.
- Full lint passed, followed by focused lint checks on the final changes. Final TypeScript and production build checks passed. The independent review of the final desktop and mobile captures and sampled source found no remaining material issues. Its runtime conclusions rely on the local checks recorded here.
- Local browser checks exercised actual root and section selection on desktop and a 390 × 844 mobile viewport, keyboard subsection jumps, camera drags without selection, category persistence after reload, all-off reset, effects toggling, paused orbits, and reader closure retaining system controls and fit. Checks after the graphical refinement also verified a desktop planet selection, keyboard activation of a new canvas section label, and repeated mobile jumps between two sections with correct focus and scroll position. After the spacing correction, desktop planet selection was checked again and the local screenshot evidence was refreshed.
- Physical devices, actual touchscreen gestures, long-running performance, a GPU/browser matrix and hosted deployment remain unverified. A resized local browser is not physical-device evidence. No private document content or vault screenshots belong in this record.

Repeat from the repository root:

```powershell
npm run cosmos:test
npm run lint
npx tsc --noEmit
npm run build
```

For browser regression, run `npm run dev`, use its reported local URL and open `/graph`. Repeat the listed interactions at desktop size and 390 × 844, including keyboard canvas-label activation, opening and closing the dock, scrolling before using the sticky outline, changing viewport aspect after manual zoom, and enabling reduced motion. Exercise “Fit system” and `f` after zooming into a large system. Verify that the root stays fixed during reading, neighbouring stars remain outside the orbital envelope, and exiting restores normal graph behaviour. Test editing races only with an explicitly authorised disposable page.
