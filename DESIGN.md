---
name: Zuychin Assistant
description: Atlas, a printed star atlas by day and a graphite night chart after dark, for one assistant that runs the day and keeps the vault.
colors:
  page: "#ffffff"
  sidebar: "#f6f6f7"
  surface: "#ffffff"
  raised: "#f8f8f8"
  bubble: "#f0f1f2"
  hover: "#eeeff0"
  active: "#e8e9ea"
  line: "#e6e7e8"
  line-strong: "#d3d4d6"
  ink: "#22252b"
  ink-2: "#3f4246"
  muted: "#65666b"
  faint: "#96989b"
  accent: "#c2352b"
  accent-hover: "#a82d24"
  accent-text: "#b02e25"
  accent-soft: "rgba(194, 53, 43, 0.1)"
  on-accent: "#ffffff"
  focus: "#65666b"
  success: "#1a7a55"
  warning: "#8a5d00"
  danger: "#9f1d2e"
  info: "#2f63c4"
  fam-source: "#a65a12"
  fam-concept: "#2f63c4"
  fam-entity: "#1a7a55"
  fam-synthesis: "#7448c4"
  event: "#f0f1f2"
  event-line: "#d3d4d6"
  elapsed: "#f6f6f7"
  chart-frame: "#e6e7e8"
  chart-tick: "#d3d4d6"
  chart-line: "rgba(34, 37, 43, 0.32)"
  chart-line-on: "rgba(34, 37, 43, 0.78)"
  code-block: "#16191d"
  code-block-ink: "#ecedef"
  page-dark: "#0f1115"
  sidebar-dark: "#0b0d10"
  surface-dark: "#1a1d22"
  raised-dark: "#24272e"
  bubble-dark: "#262a31"
  hover-dark: "#22252b"
  active-dark: "#2a2d34"
  line-dark: "#31353c"
  line-strong-dark: "#484c54"
  ink-dark: "#f2f3f5"
  ink-2-dark: "#d7d9dc"
  muted-dark: "#afb2b7"
  faint-dark: "#7b7e85"
  accent-dark: "#d93a30"
  accent-hover-dark: "#e5483f"
  accent-text-dark: "#ff7368"
  focus-dark: "#b6b9be"
  success-dark: "#56d1a0"
  warning-dark: "#edc26b"
  danger-dark: "#ff8fa3"
  info-dark: "#7fb2ff"
  fam-source-dark: "#f2a65a"
  fam-concept-dark: "#7fb2ff"
  fam-entity-dark: "#56d1a0"
  fam-synthesis-dark: "#b78cff"
typography:
  display:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.2px"
  title:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-reply:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.62
  ui:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
  meta:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    fontFeature: "tnum"
  mono-data:
    fontFamily: "Azeret Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 14px
    letterSpacing: "-0.02em"
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  full: "999px"
spacing:
  topbar: "56px"
  sidebar-w: "264px"
  panel-w: "320px"
  column-w: "720px"
  gutter: "24px"
  panel-gutter: "20px"
  rail-inset: "10px"
  target-coarse: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-icon:
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  button-icon-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-send:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.full}"
    size: "32px"
  button-stop:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
    rounded: "{rounded.full}"
    size: "32px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "34px"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "12px 10px 8px 18px"
  nav-item:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.ink}"
  bubble-owner:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "10px 16px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "18px"
  badge-due:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.full}"
    padding: "0 6px"
    height: "18px"
  event-block:
    backgroundColor: "{colors.event}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
    padding: "4px 8px 0 9px"
---

# Design System: Zuychin Assistant

## Overview

**Creative North Star: "The Star Atlas and Almanac"**

Atlas treats the assistant as a printed star atlas held to the calm of a good chat app. What the assistant knew is plotted (each reply's sources drawn as a small constellation), and the day is drawn to scale (a time axis with a red now line). The rest of the interface stays out of the way: graphite neutrals, crisp 1px lines, plain replies with no bubble, and one red accent kept rare enough to mean "act here" or "this is now".

Density is that of a working tool. A 264px sidebar, a 56px top bar, a 720px reading column and a 320px Today panel frame every surface; controls are 32px on fine pointers and grow to 44px on touch. Light mode is a white plate with cool grey rules. Dark mode is a graphite night chart, "closer to black but not entirely black", with contrast raised after the build so muted text and lines stay readable.

Atlas rejects the generic monochrome chatbot and the dark-plus-glow AI look: no gradients, no glows, no glass, no decorative labels.

**Key Characteristics:**
- Graphite neutrals with a faint cool trace, in both themes.
- One red accent, used sparingly and never as an error colour.
- Graphite, not coloured, focus rings and composer frame.
- Data colour comes only from the four Cosmos families.
- Flat 1px structure; two shadows, each with one job.
- Tabular figures for every number; mono only for real data.

## Colors

Graphite neutrals carry the whole interface; a single red marks action and the present moment, and four spectral families carry data. Every token has a light and a dark value; the dark set is applied by `[data-theme="dark"]` on `<html>`, chosen from `localStorage` or the system preference before first paint.

### Primary
- **Atlas Red** (accent, accent-dark): fill for primary buttons, the circular send button, the now line and its time chip, and the small count badge on the Today toggle. Hover deepens in light mode and lifts in dark mode (accent-hover).
- **Atlas Red Text** (accent-text, accent-text-dark): the readable red for text: links such as "Open in Cosmos", text buttons, Due "today" meta, the in-progress agent step and the live voice tool. It is also the text caret colour.
- **Red Wash** (accent-soft): background behind the live voice tool only. The selection highlight is a separate red tint (`--selection`).

### Neutral
- **Plate White / Night Chart** (page, page-dark): the app ground behind the thread, top bar and Today panel.
- **Sidebar Grey / Deep Graphite** (sidebar, sidebar-dark): the left rail, a step quieter than the page.
- **Surface** (surface, surface-dark): buttons, fields, the composer, panels, menus and modals.
- **Raised** (raised, raised-dark): chips and hover fill on suggestion cards.
- **Owner Bubble** (bubble, bubble-dark): the owner's message bubble and source-list hover.
- **Hover / Active** (hover, active): row and icon-button hover; selected nav item, selected list row, pressed toggle.
- **Rule / Strong Rule** (line, line-strong): 1px dividers and container borders; strong rule for control borders and table heads.
- **Graphite Ink** (ink, ink-2): primary and secondary text.
- **Muted / Faint** (muted, faint): meta text, icons, placeholders; faint for separators, disabled send glyph and hovered control borders.
- **Graphite Focus** (focus, focus-dark): every focus ring and the composer and field focus frame.

### Semantic
- **Success** (success): done checks and completed agent steps.
- **Warning** (warning): cautionary meta.
- **Danger** (danger): errors, destructive actions and overdue meta. Its red sits close to the accent, so danger always arrives with an icon or explicit wording.
- **Info** (info): informational marks; shares its value with the concept family.

### Data families
- **Source / Concept / Entity / Synthesis** (fam-source orange, fam-concept blue, fam-entity green, fam-synthesis violet): the vault's four page families, shown as 7-8px dots in source lists, Library rows and Cosmos. They carry data only, never UI state.

### Chart and calendar
- **Chart ink** (chart-frame, chart-tick, chart-grat, chart-line, chart-line-on, `--chart-ko` knockout): the reply constellation and the day axis.
- **Event** (event, event-line, elapsed): calendar blocks on the Today axis; elapsed time is a quiet band above the now line.
- **Code block** (code-block, code-block-ink): fenced code is dark in both themes.

### Deprecated aliases
The `--color-*` names (`--color-primary`, `--color-background`, `--color-text-primary`, `--color-border` and the rest) and `--shadow-sm/md/lg` alias the Atlas tokens for code written before Atlas. Do not use them in new code. Note that `--color-surface` and `--color-bubble-ai` map to `--raised`, not `--surface`.

### Named Rules
**The One Red Rule.** Red appears only on primary actions, links, the now line, the text caret and selection, and small due, unread or live signals. If a screen has more red than that, something is wrong.

**The Red Is Not Error Rule.** Unreviewed, pending, queued and draft states are neutral muted, never red. Danger is told apart from the accent by icon and wording, not hue alone.

**The Graphite Frame Rule.** Focus rings and the focused composer frame are graphite (focus). A blue frame clashes with the red; a red frame reads as an error.

**The Data Colour Rule.** The four family hues mark what a vault page is. They never mark a button, a state or a section.

## Typography

**Body Font:** Hanken Grotesk (with system-ui, -apple-system, sans-serif), loaded through `next/font` as `--font-hanken`.
**Mono Font:** Azeret Mono (with ui-monospace, SF Mono, Consolas), loaded as `--font-azeret`.

**Character:** One grotesk does all the talking at modest sizes and firm weights (500, 600, 650, 700), with slight negative tracking on headings. The mono is reserved for the atlas's measured data: hour ticks, paths and ids.

### Hierarchy
- **Display** (650, 24px, -0.015em): the empty-state greeting only.
- **Headline** (700, 18px): modal titles.
- **Title** (700, 15px, -0.005em): top-bar and Today panel headings; section heads inside panels drop to 13px/700.
- **Body** (400, 16px, 1.5): owner bubbles and the composer. Replies use 16px at 1.62 with a 68ch measure; reply headings are 650 weight.
- **UI** (400-500, 14px): nav items, list rows, menus, tabs.
- **Label** (500, 13.5px): button and control labels; 600 on primary buttons and the Today toggle.
- **Meta** (400, 12.5px, tabular): times, counts, row meta.
- **Mono data** (Azeret Mono, 11-13px, -0.02em): hour ticks and the now chip at 11px, vault paths at 12px, slash-command usage at 13px.

### Named Rules
**The Tabular Rule.** Every number that can change or be compared (times, dates, counts, sizes, stats) uses tabular figures: `font-variant-numeric: tabular-nums`, or the global `time, .num` rule.

**The Real Data Mono Rule.** Mono is for real data: paths, ids, hour ticks, command syntax. Never for labels, headings or decoration.

**The No Kicker Rule.** No eyebrow or kicker labels, no uppercase tracked micro-labels above headings. A heading stands on its own.

## Layout

The app is a three-pane frame. The left sidebar (`--sidebar-w`, 264px) docks at 900px and up and collapses to zero width; below 900px it becomes a drawer (`min(86vw, 320px)`) over a scrim. The main pane has a sticky 56px top bar with a 24px left gutter, holding the page title, workspace tabs and labelled actions. A container query on the top bar folds labelled actions to 32px icon buttons when the bar is 1080px or narrower; the label stays as the accessible name. Under 720px the top bar wraps and the tabs move to their own scrolling row.

The chat thread centres a `--column-w` (720px) column with 22px between turns and 28px/24px padding; the composer floats at the bottom of the same column. Owner bubbles sit right at up to 76% (86% on phones); replies run as plain text beside a 24px mark column, which collapses above the text under 900px.

The Today panel (`--panel-w`, 320px) docks to the right with a 1px left rule; when not docked it is a bottom sheet on phones and a 360px side sheet from 640px. Its day is drawn to time scale: hour rules, a 42px mono tick gutter, events positioned by time, a red now line.

Workspace pages use a 24px page gutter, 16px gaps between panels and a 1240px max width on the dashboard. Library is a list pane (`clamp(272px, 34%, 408px)`) beside a reader.

Spacing runs on a loose 2px grid with 4, 6, 8, 10, 12, 16, 20 and 24px as the recurring steps. Panels use 20px inner gutters; the sidebar uses a 10px rail inset.

### Named Rules
**The Coarse Pointer Rule.** Under `(pointer: coarse)` every target is at least 44px: icon buttons go to 44x44, rows and nav items to a 44px minimum height, small checks gain an invisible hit area.

## Elevation & Depth

Atlas is flat and ruled. Depth comes from tonal steps (sidebar, page, surface, raised) and 1px lines, not from shadow. Exactly three shadows exist, each tied to one role, with dark-mode values that are heavier so they still read on graphite.

### Shadow Vocabulary
- **Control** (`--shadow-xs`): a 1px lift on resting controls: New chat, select triggers, the active theme segment.
- **Popover** (`--shadow-pop`): menus, modals, the slash-command menu, the mobile drawer, the Today sheet, the scroll-down button and Cosmos cards.
- **Composer** (`--shadow-composer`): the floating composer only.

### Named Rules
**The Two Shadow Rule.** Controls get `--shadow-xs`, popovers get `--shadow-pop`, and the composer has its own. Panels, cards and rows get none.

**The No Glow Rule.** No gradients, glows, glass or backdrop blur. Scrims are a flat graphite at 40-45% opacity.

## Shapes

Corners are gently rounded and scale with the size of the object: 6px (`--radius-xs`) for event blocks, file tags and small items; 8px (`--radius-sm`) for buttons, fields, nav items and rows; 10px (`--radius-md`) for panels, menus and chips; 14px (`--radius-lg`) for modals; 20px (`--radius-xl`) for the composer, owner bubbles and the top of the bottom sheet; full for the send and stop buttons, badges, switches and checks.

Rules and borders are 1px. Small round controls (checks, the Agent switch) use a 1.5px stroke. The only 2px strokes are the now line, the active tab underline (ink) and the focus outline. Family markers and checks are circles.

### Named Rules
**The Hairline Rule.** Borders and dividers are 1px. No coloured side stripes thicker than 1px on cards, rows, callouts or quotes.

## Components

### Buttons
Quiet, bordered and compact.
- **Shape:** gently rounded (8px), 32px tall, 13.5px/500 label, a muted 16px icon leading.
- **Primary:** Atlas Red fill with white text at 600; hover moves to accent-hover. One primary per view.
- **Secondary:** surface fill, 1px strong-rule border, ink text. Hover darkens the border to faint; pressed state uses the active fill.
- **Icon:** transparent, muted glyph, 32px square; hover fills with hover and lifts the glyph to ink. Expanded or pressed icon buttons use the active fill.
- **Folded top-bar actions:** when the top bar is under 1080px wide, labelled actions fold to 32px icon buttons and their label becomes a tooltip: ink fill, page-coloured 12.5px text, 6px below the button, shown after 0.3s on hover or keyboard focus. The label stays the accessible name.
- **Send / Stop:** 32px circles in the composer. Send is Atlas Red; disabled send greys to active with a faint glyph; Stop is an ink circle.
- **Text button:** accent-text at 13px/600 with underline on hover, for inline actions in panels.
- **Disabled:** 45-55% opacity.

### Chips
- **Style:** raised or surface fill, 1px rule border, 10px radius (composer context chips) or 8px (artifact chips).
- **State:** a live chip shows its icon in accent-text; everything else stays neutral.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** surface.
- **Shadow Strategy:** none; see Elevation.
- **Border:** 1px rule.
- **Internal Padding:** 18px on dashboard panels, 12-14px on the agent-run card.
- **Ledger strip:** dashboard stats sit in a single bordered strip of cells divided by 1px rules (a grid with a 1px gap over a rule-coloured ground), six across, folding to three and two by container width; values are 20px/650 tabular.

### Inputs / Fields
- **Style:** surface fill, 1px strong-rule border, 8px radius, 34px tall, 14px text, muted placeholder.
- **Focus:** border turns graphite focus plus a 1px focus ring (`box-shadow: 0 0 0 1px var(--focus)`); text inputs suppress the outline in favour of this frame.
- **Composer:** a 20px-radius surface with a strong-rule border and the composer shadow; on focus the frame turns graphite in the same way. The tools row sits under the textarea.
- **Select:** a 32px trigger with the control shadow opening a popover menu (surface, 10px radius, `--shadow-pop`) whose selected item uses the active fill.

### Navigation
- **Sidebar:** rows are 32px, 14px ink-2 text with muted icons; hover fills with hover; the current page fills with active, ink text at 600. A bordered New chat button with the control shadow and a borderless search field lead the rail. A History toggle collapses the workspace list; the theme control is a segmented pill in the footer.
- **Tabs:** muted 14px/500 labels in the top bar; the current tab turns ink at 600 with a 2px ink underline flush with the bar's bottom rule.
- **Mobile:** the sidebar becomes a drawer with focus trapped inside; the Today panel becomes a sheet.

### Today Panel
The day drawn to scale. Hour rules in line colour, a strong-rule axis, mono hour ticks in muted, events as 6px-radius blocks in event colour with a 600 title and tabular times. Past events drop to 62% opacity. The now line is a 2px Atlas Red rule with a mono time chip in red. Below the day, Due and Scheduled lists use 14px titles, 12.5px meta and right-aligned tabular dates. Due meta is accent-text for today, danger for overdue, muted otherwise. The Today toggle in the top bar carries a red count badge.

### Chat Starters
Five 44px cards under the empty-state heading, centred and wrapping on desktop, stacked full width under 900px. Live starters lead: the next timed event ("Prepare for …" with its time), the most urgent to-do due by the end of tomorrow (no more than a week overdue) with its due state, and study cards still reviewable today, which links to Study. Fixed starters fill the rest. Each card is a muted icon, a 14px label clipped at 30ch and an optional 13px tabular meta, accent-text for due today and danger for overdue, as in the Today panel. The set stays hidden, holding its space, until the live data is known (at most 2.5 seconds), then fades in once and does not change under the pointer.

### Reply Sources Constellation
The signature component. Under a reply, a muted disclosure opens a 300px star chart beside a numbered source list. The chart is a framed plate with ticks and a dotted graticule; sources are numbered points joined by thin chart-line strokes, highlighted to chart-line-on with an ink ring when their list row is hovered. Each list row shows a tabular number, a family dot and the page title; "Open in Cosmos" closes the list as an accent-text link. Under 560px of container width or 900px of viewport, the chart stacks above the list.

### Library List
Pages sit under family headers (dot, name, muted count): Sources, Concepts, Entities, Synthesis, then Raw captures and Vault files with faint dots. A segmented All / Reviewed / Unreviewed control sits under the filter field, styled like the theme control (active fill, the selected segment raised on the page colour). Each row is a family dot, a 14px title and a meta line with the review state on the left and a tabular date on the right. Reviewed and Trusted show a circled check in success; Unreviewed (untrusted or suggested) is muted with a dashed circle, and its dot is hollow. Rows are 52px on coarse pointers.

### Library Reader Actions
Wiki pages get one primary action in the reader bar, a red "Explore in Cosmos" button (orbit icon) that opens the page's local view; while the reader is on screen it replaces the top-bar Cosmos link, so there is never more than one route to Cosmos in view. Under the page text, "Possible connections" is a ruled list: a hollow family dot, the page title as a plain text button that opens it, the similarity as a tabular percentage, and a secondary Accept button. Accept shows a spinner and "Linking" while in flight, locks the other rows, reports failure inline in danger and success as a success-coloured status line.

### Library Link Chart
Above a Library page, the same plate idiom maps its links: the page is a ringed dot at the centre with its title below, pages linking in sit to the left, pages it links to sit to the right, and a two-way link is drawn once on the lighter side but counted on both. Dots are family-coloured and sized by centrality; the two most central on each side carry labels on a knockout, the rest show their title on hover or focus. Counts ("9 in", "9 out") sit in the top corners in tabular figures. Each dot is a button that opens that page. Placement is a deterministic scatter, so a page always draws the same chart. Under 520px of width only the centre label stays. Data comes from the Cosmos graph snapshot.

### Knowledge Cosmos chrome
`/graph` is dark-only. Its chrome does not read the CSS tokens; it mirrors the dark values by hand in `CHROME` in `src/app/graph/cosmos/styles.ts`. Any change to a dark token must be copied there.

## Do's and Don'ts

### Do:
- **Do** use the Atlas names (`--page`, `--surface`, `--ink`, `--accent`...) in new code, and set every colour for both themes.
- **Do** keep red to primary actions, links, the now line and small due, unread or live signals.
- **Do** show unreviewed, pending and queued states in muted neutral.
- **Do** use graphite `--focus` for every focus ring and focused frame: `outline: 2px solid var(--focus); outline-offset: 2px`.
- **Do** use tabular figures for every number and Azeret Mono only for paths, ids, hour ticks and command syntax.
- **Do** give every control a 44px target under `(pointer: coarse)`.
- **Do** honour `prefers-reduced-motion`: the global rule cuts animations and transitions; component transitions also opt out locally.
- **Do** mirror any dark token change into `CHROME` for Cosmos.

### Don't:
- **Don't** add eyebrow or kicker labels, or uppercase tracked micro-labels.
- **Don't** use coloured side stripes thicker than 1px.
- **Don't** use gradients, glows, glass or backdrop blur.
- **Don't** put shadows on panels, cards or rows; only `--shadow-xs` on controls and `--shadow-pop` on popovers.
- **Don't** use a blue or red focus ring or composer frame.
- **Don't** colour pending, unreviewed or draft states red.
- **Don't** use the family hues for UI state.
- **Don't** reach for the deprecated `--color-*` aliases in new code.
- **Don't** give Cosmos a light theme.
