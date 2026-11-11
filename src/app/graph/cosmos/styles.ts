import type { CSSProperties } from "react";
import { COSMOS } from "./palette";

// Atlas dark values for the chrome. Literal because the graph stays dark under
// either app theme; COSMOS keeps the drawing's own colours.
export const CHROME = {
    page: "#0f1115",
    surface: "#1a1d22",
    raised: "#24272e",
    line: "#31353c",
    lineStrong: "#484c54",
    ink: "#f2f3f5",
    ink2: "#d7d9dc",
    muted: "#afb2b7",
    faint: "#7b7e85",
    accent: "#d93a30",
    accentText: "#ff7368",
    onAccent: "#ffffff",
    focus: "#b6b9be",
    success: "#56d1a0",
    warning: "#edc26b",
    danger: "#ff8fa3",
    scrollThumb: "#3b3e45",
    shadow: "0 2px 4px -1px rgba(0,0,0,.4), 0 14px 36px -10px rgba(0,0,0,.7)",
} as const;

export const COSMOS_CSS = `
.cosmos-root{color-scheme:dark}
.graph-markdown h1,.graph-markdown h2,.graph-markdown h3,.graph-markdown h4,.graph-markdown h5,.graph-markdown h6{font-size:15px;font-weight:650;line-height:1.45;margin:22px 0 9px;color:${CHROME.ink};scroll-margin-top:14px;border-radius:6px}
.graph-markdown h1{font-size:18px;letter-spacing:-.01em}
.graph-markdown h2{font-size:16.5px;letter-spacing:-.01em}
.graph-markdown h4,.graph-markdown h5,.graph-markdown h6{font-size:14px}
.graph-markdown [data-focused]{background:${CHROME.raised};box-shadow:0 0 0 6px ${CHROME.raised};color:${CHROME.ink}}
.graph-markdown p{margin:0 0 12px}
.graph-markdown ul,.graph-markdown ol{margin:0 0 12px;padding-left:20px}
.graph-markdown li{margin:5px 0}
.graph-markdown code{background:rgba(255,255,255,.07);padding:2px 5px;border-radius:5px;font-family:var(--font-mono,ui-monospace,monospace);font-size:.86em}
.graph-markdown pre{background:#0b0d10;border:1px solid ${CHROME.line};padding:12px;border-radius:8px;overflow-x:auto;margin:0 0 12px}
.graph-markdown pre code{background:transparent;padding:0}
.graph-markdown a{color:${CHROME.accentText};text-decoration-thickness:1px;text-underline-offset:3px}
.graph-markdown a:hover{text-decoration-thickness:2px}
.graph-markdown table{border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;margin:0 0 12px;display:block;overflow-x:auto}
.graph-markdown th,.graph-markdown td{border:1px solid ${CHROME.line};padding:6px 8px}
.graph-markdown th{color:${CHROME.muted};font-weight:600;border-color:${CHROME.lineStrong}}
.graph-markdown blockquote{margin:0 0 12px;padding-left:12px;border-left:1px solid ${CHROME.lineStrong};color:${CHROME.muted}}
.graph-markdown hr{border:0;border-top:1px solid ${CHROME.line};margin:14px 0}
.graph-markdown img{max-width:100%;height:auto}
.graph-markdown{overflow-wrap:anywhere}
.cosmos-rail::-webkit-scrollbar{width:7px}
.cosmos-rail::-webkit-scrollbar-thumb{background:${CHROME.scrollThumb};border-radius:99px}
.cosmos-rail::-webkit-scrollbar-track{background:transparent}
.cosmos-rail>*{pointer-events:auto}
.cosmos-root ::selection{color:${CHROME.ink};background:rgba(255,115,104,.28)}
.cosmos-root input,.cosmos-root textarea{caret-color:${CHROME.accentText}}
.cosmos-root input::placeholder,.cosmos-root textarea::placeholder{color:${CHROME.muted};opacity:1}
.cosmos-root button:focus-visible,.cosmos-root a:focus-visible,.cosmos-root input:focus-visible,.graph-markdown [tabindex]:focus-visible{outline:2px solid ${CHROME.focus}!important;outline-offset:2px}
.cosmos-field input:focus-visible{outline:none!important}
.cosmos-field:focus-within,.cosmos-root textarea:focus-visible{border-color:${CHROME.focus}!important;box-shadow:0 0 0 1px ${CHROME.focus}}
.cosmos-root textarea:focus-visible{outline:none!important}
.cosmos-root button:disabled{opacity:.45;cursor:default}
@media(hover:hover){.cosmos-root button:enabled:hover{box-shadow:inset 0 0 0 100vmax rgba(255,255,255,.06)}.cosmos-root a[href]:not(.graph-markdown a):hover{box-shadow:inset 0 0 0 100vmax rgba(255,255,255,.06)}}
@media(max-width:759px),(pointer:coarse),(max-width:1000px) and (max-height:480px){.cosmos-root{--cosmos-icon-size:44px}.cosmos-root button,.cosmos-root a{min-height:44px}}
@media(max-width:759px){.graph-markdown{max-height:55dvh!important;font-size:14px!important}.cosmos-root input:not([type="range"]),.cosmos-root textarea{font-size:16px!important}.cosmos-timeline{display:grid!important;grid-template-columns:44px minmax(0,1fr) auto 44px;gap:8px!important;padding:8px 10px!important}.cosmos-timeline input{grid-row:2;grid-column:1 / -1;min-width:0}.cosmos-timeline button:last-child{grid-row:1;grid-column:4}.cosmos-timeline>span{grid-row:1;grid-column:3}}
@media(prefers-reduced-motion:reduce){.cosmos-root *{transition:none!important;scroll-behavior:auto!important;animation:none!important}}
`;

const card: CSSProperties = {
    background: CHROME.surface,
    border: `1px solid ${CHROME.line}`,
    borderRadius: 10,
    boxShadow: CHROME.shadow,
    color: CHROME.ink,
};

// Longhand borders, not the `border` shorthand: the active variants below override
// borderColor, and mixing the two makes React drop the property on rerender.
const controlBase: CSSProperties = {
    font: "inherit",
    color: CHROME.ink,
    background: CHROME.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: CHROME.lineStrong,
    borderRadius: 8,
    cursor: "pointer",
    transition: "background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
};

const ghostIcon: CSSProperties = {
    ...controlBase,
    width: "var(--cosmos-icon-size, 32px)",
    height: "var(--cosmos-icon-size, 32px)",
    display: "grid",
    placeItems: "center",
    color: CHROME.muted,
    background: "transparent",
    borderColor: "transparent",
    flexShrink: 0,
};

const scrollbar: CSSProperties = {
    scrollbarWidth: "thin",
    scrollbarColor: `${CHROME.scrollThumb} transparent`,
};

export const styles: Record<string, CSSProperties> = {
    root: {
        position: "fixed",
        inset: 0,
        overflow: "clip",
        background: COSMOS.background,
        color: CHROME.ink,
        fontFamily: "var(--font-family, system-ui)",
        fontSize: 13,
    },
    // Explicit edges rather than `inset`, because the mobile split overrides top and
    // bottom inline and a shorthand would fight it. The renderer is sized from this
    // element's own box, so the camera centres on what is actually visible.
    canvas: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },

    topBar: {
        position: "absolute",
        top: 14,
        left: 16,
        right: 16,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        columnGap: 10,
        flexWrap: "wrap",
        rowGap: 8,
        pointerEvents: "none",
    },
    topBarGroup: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 6,
        minWidth: 0,
        pointerEvents: "auto",
        ...card,
    },
    topBarSpacer: { flex: 1, minWidth: 0 },
    backBtn: { ...ghostIcon, textDecoration: "none" },
    titleStack: { display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0, paddingRight: 8 },
    pageTitle: { fontSize: 15, fontWeight: 700, letterSpacing: "-0.005em", whiteSpace: "nowrap" },
    counts: { padding: "0 4px 0 6px", fontSize: 12.5, color: CHROME.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
    staleDot: {
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12.5,
        color: CHROME.warning,
        whiteSpace: "nowrap",
    },
    iconBtn: ghostIcon,
    iconBtnActive: {
        color: CHROME.ink,
        background: CHROME.raised,
        borderColor: CHROME.lineStrong,
    },
    viewControls: {
        display: "flex",
        gap: 2,
        padding: 4,
        ...card,
    },

    // The rails are rounded scroll viewports: a card taller than the rail then gets
    // clipped on a curve instead of ending in a hard flat edge. scrollbarColor is the
    // standard property: Chromium ignores ::-webkit-scrollbar once it is set, so the
    // dark thumb here is what actually renders.
    //
    // pointerEvents none on the rail itself, auto on its cards (.cosmos-rail > *):
    // the width clamps to calc(100vw - 32px), so on a phone a rail spans nearly the
    // whole viewport and its EMPTY area below the last card would otherwise swallow
    // every tap and drag meant for the canvas.
    leftRail: {
        position: "absolute",
        top: 68,
        left: 16,
        bottom: 92,
        width: "min(292px, calc(100vw - 32px))",
        zIndex: 9,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflowY: "auto",
        overflowX: "hidden",
        paddingRight: 4,
        borderRadius: 10,
        pointerEvents: "none",
        ...scrollbar,
    },
    rightRail: {
        position: "absolute",
        top: 68,
        right: 16,
        bottom: 92,
        width: "min(380px, calc(100vw - 32px))",
        zIndex: 9,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflowY: "auto",
        overflowX: "hidden",
        paddingRight: 4,
        borderRadius: 10,
        pointerEvents: "none",
        ...scrollbar,
    },

    // Phones get a docked region rather than a floating overlay. Two earlier attempts
    // failed for the same reason: whatever height the overlay took, the canvas stayed
    // window-sized, so flyTo centred the selected star in the middle of the WINDOW,
    // which is behind the panel. The dock claims real space and the canvas shrinks to
    // what is left, so the star it framed is centred in the visible half.
    mobileDock: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 12,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: CHROME.surface,
        borderTop: `1px solid ${CHROME.line}`,
        borderTopLeftRadius: 10,
        borderTopRightRadius: 10,
        boxShadow: "0 -2px 4px -1px rgba(0,0,0,.4), 0 -14px 36px -10px rgba(0,0,0,.7)",
        color: CHROME.ink,
    },
    // One row replacing three overlapping things: the snap handle, the floating system
    // banner and a second close affordance.
    mobileDockHeader: {
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        borderBottom: `1px solid ${CHROME.line}`,
    },
    mobileDockLabel: {
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 13.5,
        fontWeight: 600,
    },
    mobileDockBody: {
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflowY: "auto",
        overflowX: "hidden",
        padding: 10,
        ...scrollbar,
    },
    mobileGrip: ghostIcon,

    panel: { ...card, padding: 14, flexShrink: 0 },
    panelHeader: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 },
    panelIcon: {
        width: 28,
        height: 28,
        borderRadius: 8,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        color: CHROME.muted,
        background: CHROME.raised,
        border: `1px solid ${CHROME.line}`,
    },
    panelTitle: { margin: 0, fontSize: 14, fontWeight: 650, lineHeight: 1.35 },
    panelSubtle: { margin: "2px 0 0", fontSize: 12.5, lineHeight: 1.4, color: CHROME.muted },
    sectionLabel: {
        margin: "16px 0 8px",
        fontSize: 12.5,
        fontWeight: 600,
        color: CHROME.muted,
    },

    searchRow: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 34,
        padding: "0 10px",
        borderRadius: 8,
        background: CHROME.page,
        border: `1px solid ${CHROME.lineStrong}`,
        color: CHROME.muted,
        transition: "border-color 0.15s ease, box-shadow 0.15s ease",
    },
    searchInput: {
        flex: 1,
        minWidth: 0,
        height: 32,
        background: "none",
        border: "none",
        outline: "none",
        font: "inherit",
        fontSize: 13.5,
        color: CHROME.ink,
    },
    clearBtn: {
        width: 24,
        height: 24,
        flexShrink: 0,
        border: "none",
        borderRadius: 6,
        background: "none",
        color: CHROME.muted,
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        padding: 0,
    },
    resultList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 8 },
    resultRow: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 8,
        border: "none",
        background: "none",
        color: CHROME.ink,
        font: "inherit",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
    },
    resultRowActive: { background: CHROME.raised },
    resultTitle: {
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    resultScore: { fontSize: 12, color: CHROME.muted, fontVariantNumeric: "tabular-nums", flexShrink: 0 },

    chipRow: { display: "flex", flexWrap: "wrap", gap: 6 },
    chip: {
        ...controlBase,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 28,
        padding: "0 10px",
        fontSize: 12.5,
        fontWeight: 500,
        color: CHROME.muted,
        background: "transparent",
        borderColor: CHROME.line,
    },
    chipActive: { color: CHROME.ink, background: CHROME.raised, borderColor: CHROME.lineStrong },
    chipDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },

    lensGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
    lensBtn: {
        ...controlBase,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        minHeight: 32,
        padding: "0 7px 0 10px",
        fontSize: 13,
        fontWeight: 500,
        color: CHROME.ink2,
        background: "transparent",
        borderColor: CHROME.line,
        textAlign: "left",
    },
    keycap: {
        display: "inline-grid",
        placeItems: "center",
        minWidth: 18,
        height: 18,
        padding: "0 4px",
        flexShrink: 0,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: CHROME.muted,
        background: CHROME.page,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: CHROME.line,
    },
    lensBtnActive: {
        color: CHROME.ink,
        fontWeight: 600,
        background: CHROME.raised,
        borderColor: CHROME.lineStrong,
    },
    legendRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: CHROME.ink2, padding: "3px 0" },

    statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 },
    statCard: {
        padding: "8px 10px",
        borderRadius: 8,
        background: CHROME.raised,
        border: `1px solid ${CHROME.line}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
    },
    statValue: { fontSize: 16, fontWeight: 650, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" },
    statLabel: { fontSize: 12, color: CHROME.muted, fontVariantNumeric: "tabular-nums" },

    switchRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "5px 0",
        fontSize: 13,
        color: CHROME.ink,
    },
    switchLabel: { display: "flex", alignItems: "center", gap: 8, color: CHROME.ink2, fontSize: 13 },
    switch: {
        ...controlBase,
        width: 38,
        height: 21,
        borderRadius: 999,
        padding: 2,
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        background: "transparent",
        borderColor: CHROME.faint,
    },
    switchOn: { background: CHROME.ink, borderColor: CHROME.ink },
    switchKnob: {
        width: 15,
        height: 15,
        borderRadius: "50%",
        background: CHROME.faint,
        transition: "transform 0.16s ease, background-color 0.16s ease",
    },
    switchKnobOn: { background: CHROME.page },

    sliderRow: { display: "flex", flexDirection: "column", gap: 4, padding: "5px 0" },
    sliderHead: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: CHROME.ink2, fontVariantNumeric: "tabular-nums" },
    slider: { width: "100%", accentColor: CHROME.ink2 },

    listRow: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 8px",
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: CHROME.ink,
        font: "inherit",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
    },
    listRowActive: {
        background: CHROME.raised,
        boxShadow: `inset 0 0 0 1px ${CHROME.lineStrong}`,
    },
    listRowLead: {
        width: 20,
        fontSize: 12,
        color: CHROME.muted,
        fontVariantNumeric: "tabular-nums",
        flexShrink: 0,
    },
    listRowMeta: { fontSize: 12, color: CHROME.muted, flexShrink: 0, fontVariantNumeric: "tabular-nums" },
    listStack: { display: "flex", flexDirection: "column", gap: 2 },

    pagePanelTitle: { margin: 0, fontSize: 16, fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.3, overflowWrap: "anywhere" },
    pagePath: {
        marginTop: 2,
        fontSize: 12,
        color: CHROME.muted,
        wordBreak: "break-all",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
    },
    badgeRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 },
    badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 600,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "transparent",
    },
    markdown: {
        maxHeight: "min(52dvh, 560px)",
        minHeight: 120,
        overflowY: "auto",
        overscrollBehavior: "contain",
        fontSize: 14,
        lineHeight: 1.7,
        color: CHROME.ink2,
        marginTop: 10,
        padding: "8px 10px 18px 7px",
        ...scrollbar,
    },
    documentNav: {
        position: "sticky", top: 0, zIndex: 2, background: CHROME.surface,
        marginTop: 16, borderTop: `1px solid ${CHROME.line}`, padding: "7px 0 10px",
    },
    documentMeta: { display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 5, marginTop: 12, color: CHROME.muted, fontSize: 12.5, fontVariantNumeric: "tabular-nums" },
    outlineToggle: {
        ...controlBase, width: "100%", display: "flex", alignItems: "center", gap: 8,
        background: "transparent", borderColor: "transparent", padding: "9px 0", fontSize: 13, fontWeight: 500,
    },
    outline: { display: "flex", flexDirection: "column", maxHeight: 240, overflowY: "auto", padding: "4px 0" },
    outlineItem: {
        ...controlBase, borderColor: "transparent", background: "transparent", color: CHROME.ink2, textAlign: "left",
        padding: "8px 10px", fontSize: 13, lineHeight: 1.45, borderRadius: 6,
    },
    outlineItemActive: { background: CHROME.raised, color: CHROME.ink },
    sectionFocus: {
        display: "flex", alignItems: "center", gap: 8, margin: "8px 0 0", padding: "8px 10px",
        color: CHROME.ink, background: CHROME.raised, border: `1px solid ${CHROME.line}`, borderRadius: 8,
        fontSize: 12.5, lineHeight: 1.4,
    },
    editArea: {
        width: "100%",
        minHeight: 260,
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        background: CHROME.page,
        border: `1px solid ${CHROME.lineStrong}`,
        color: CHROME.ink,
        font: "inherit",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: 12.5,
        lineHeight: 1.55,
        resize: "vertical",
        outline: "none",
        ...scrollbar,
    },
    actionRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 },
    action: {
        ...controlBase,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 30,
        padding: "0 10px",
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: "nowrap",
    },
    actionPrimary: {
        color: CHROME.onAccent,
        fontWeight: 600,
        background: CHROME.accent,
        borderColor: CHROME.accent,
    },
    actionDanger: { color: CHROME.danger },

    timelineWrap: {
        position: "absolute",
        left: 20,
        right: 20,
        bottom: "max(18px, env(safe-area-inset-bottom, 0px))",
        margin: "0 auto",
        zIndex: 10,
        maxWidth: 760,
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        ...card,
    },
    timelineMeta: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flexShrink: 0 },
    timelineDate: { fontSize: 13, fontWeight: 650, fontVariantNumeric: "tabular-nums" },
    timelineNote: { fontSize: 12, color: CHROME.muted },
    timelineEnd: { fontSize: 12, color: CHROME.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },

    toast: {
        position: "absolute",
        left: 20,
        right: 20,
        width: "max-content",
        margin: "0 auto",
        bottom: 96,
        zIndex: 20,
        padding: "9px 14px",
        fontSize: 13,
        maxWidth: "min(520px, calc(100vw - 40px))",
        textAlign: "center",
        ...card,
    },
    banner: {
        position: "absolute",
        top: 68,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 6px 4px 12px",
        fontSize: 13,
        // width:max-content WITH a cap, not a cap alone. Anchored at left:50% the box is
        // shrink-to-fit, and a nowrap child's minimum content width then wins over the
        // available space, which is how it ended up hanging off the right edge. Giving
        // the width a definite basis is also what makes the label's ellipsis fire.
        width: "max-content",
        maxWidth: "min(560px, calc(100vw - 32px))",
        ...card,
    },
    bannerLabel: {
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    overlay: {
        position: "absolute",
        top: 0, right: 0, bottom: 0, left: 0,
        zIndex: 30,
        display: "grid",
        placeItems: "center",
        alignContent: "center",
        background: "rgba(15,17,21,0.76)",
        color: CHROME.muted,
        fontSize: 13.5,
        gap: 10,
    },
    errorText: { color: CHROME.danger },
    empty: { fontSize: 12.5, lineHeight: 1.5, color: CHROME.muted, padding: "8px 2px" },
    contextMenu: {
        position: "absolute",
        zIndex: 40,
        minWidth: 190,
        padding: 4,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        ...card,
    },
    contextItem: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 6,
        border: "none",
        background: "none",
        color: CHROME.ink,
        font: "inherit",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
    },
};
