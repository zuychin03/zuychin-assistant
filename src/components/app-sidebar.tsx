"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronsDown, ChevronsUp, GraduationCap, Inbox, LayoutDashboard, Library, ListChecks, MessageSquare, Monitor, Moon, PanelLeft, PanelLeftClose, Search, SquarePen, Sun, Telescope, UsersRound, X } from "lucide-react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import styles from "./app-sidebar.module.css";

export type Destination = "chat" | "library" | "research" | "study" | "capture" | "tasks" | "dashboard" | "council" | "cosmos";

const PRIMARY = [
    { id: "chat", href: "/", label: "Chat", icon: MessageSquare },
    { id: "library", href: "/knowledge", label: "Library", icon: Library },
    { id: "research", href: "/research", label: "Research", icon: Telescope },
    { id: "study", href: "/study", label: "Study", icon: GraduationCap },
    { id: "capture", href: "/capture", label: "Capture", icon: Inbox },
    { id: "tasks", href: "/tasks", label: "Tasks", icon: ListChecks },
    { id: "dashboard", href: "/admin", label: "Dashboard", icon: LayoutDashboard },
] as const;

export function ZuychinMark({ size = 22, className }: { size?: number; className?: string }) {
    return <span aria-hidden="true" className={`${styles.mark} ${className ?? ""}`} style={{ width: Math.round(size * 1.28), height: size }} />;
}

export function CosmosIcon({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="2.6" cy="11.6" r="1.9" fill="var(--fam-source)" />
        <circle cx="6.2" cy="4.6" r="1.55" fill="var(--fam-concept)" />
        <circle cx="10.3" cy="8.7" r="1.75" fill="var(--fam-entity)" />
        <circle cx="13.6" cy="3.1" r="1.3" fill="var(--fam-synthesis)" />
        <circle cx="12.4" cy="13.4" r="1.05" fill="currentColor" />
    </svg>;
}

type ThemePreference = "light" | "dark" | "system";
const THEME_KEY = "zuychin-theme";
const themeListeners = new Set<() => void>();

function readThemePreference(): ThemePreference {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        return stored === "light" || stored === "dark" ? stored : "system";
    } catch { return "system"; }
}

function applyTheme(preference: ThemePreference) {
    const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function subscribeTheme(onChange: () => void) {
    themeListeners.add(onChange);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => { if (readThemePreference() === "system") applyTheme("system"); onChange(); };
    media.addEventListener("change", onSystem);
    window.addEventListener("storage", onSystem);
    return () => {
        themeListeners.delete(onChange);
        media.removeEventListener("change", onSystem);
        window.removeEventListener("storage", onSystem);
    };
}

export function setThemePreference(preference: ThemePreference) {
    // The boot script in the root layout treats a missing key as "follow the system".
    try {
        if (preference === "system") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, preference);
    } catch { /* The choice still applies to this page. */ }
    applyTheme(preference);
    themeListeners.forEach((listener) => listener());
}

const THEME_OPTIONS = [
    { id: "light", label: "Light theme", icon: Sun },
    { id: "dark", label: "Dark theme", icon: Moon },
    { id: "system", label: "Match system theme", icon: Monitor },
] as const;

export function ThemeControl() {
    const preference = useSyncExternalStore(subscribeTheme, readThemePreference, () => "system" as ThemePreference);
    return <div role="radiogroup" aria-label="Theme" className={styles.theme}>
        {THEME_OPTIONS.map(({ id, label, icon: Icon }) => <button
            key={id} type="button" role="radio" aria-checked={preference === id} aria-label={label} title={label}
            onClick={() => setThemePreference(id)}
        ><Icon size={14} aria-hidden="true" /></button>)}
    </div>;
}

export function useMediaQuery(query: string, serverValue = true) {
    return useSyncExternalStore(
        (onChange) => {
            const media = window.matchMedia(query);
            media.addEventListener("change", onChange);
            return () => media.removeEventListener("change", onChange);
        },
        () => window.matchMedia(query).matches,
        () => serverValue,
    );
}

export function trapTab(event: KeyboardEvent, container: HTMLElement) {
    const controls = Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
        .filter((element) => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}

export const SIDEBAR_DOCKED_QUERY = "(min-width: 900px)";

const storedListeners = new Map<string, Set<() => void>>();
const storedFallback = new Map<string, boolean>();

function readStoredFlag(key: string, value: string) {
    try { return localStorage.getItem(key) === value; } catch { return storedFallback.get(key) ?? false; }
}

/** A boolean remembered in localStorage as `key=value`; absent means false. */
export function useStoredFlag(key: string, value: string) {
    const subscribe = useCallback((onChange: () => void) => {
        const listeners = storedListeners.get(key) ?? new Set<() => void>();
        storedListeners.set(key, listeners);
        listeners.add(onChange);
        window.addEventListener("storage", onChange);
        return () => { listeners.delete(onChange); window.removeEventListener("storage", onChange); };
    }, [key]);
    const flag = useSyncExternalStore(subscribe, () => readStoredFlag(key, value), () => false);
    const setFlag = useCallback((next: boolean) => {
        storedFallback.set(key, next);
        try {
            if (next) localStorage.setItem(key, value);
            else localStorage.removeItem(key);
        } catch { /* The fallback keeps the choice for this page. */ }
        storedListeners.get(key)?.forEach((listener) => listener());
    }, [key, value]);
    return [flag, setFlag] as const;
}

export function useSidebarState() {
    const docked = useMediaQuery(SIDEBAR_DOCKED_QUERY);
    const [collapsed, setCollapsed] = useStoredFlag("zuychin-sidebar", "collapsed");
    const [drawerOpen, setDrawerOpen] = useState(false);
    const open = docked ? !collapsed : drawerOpen;
    const setOpen = useCallback((next: boolean) => {
        if (docked) setCollapsed(!next);
        else setDrawerOpen(next);
    }, [docked, setCollapsed]);
    const close = useCallback(() => setOpen(false), [setOpen]);
    return { docked, open, setOpen, close };
}

export function SidebarToggle({ open, onToggle, controls = "app-sidebar", className }: { open: boolean; onToggle: () => void; controls?: string; className?: string }) {
    const label = open ? "Hide sidebar" : "Show sidebar";
    return <button type="button" className={`${styles.iconButton} ${className ?? ""}`} onClick={onToggle} aria-expanded={open} aria-controls={controls} aria-label={label} title={label}>
        <PanelLeft size={18} aria-hidden="true" />
    </button>;
}

export function AppSidebar({
    id = "app-sidebar", current, hrefs, onNewChat, newChatDisabled, search, onSearch, docked, open, onClose, footer, children,
}: {
    id?: string;
    current: Destination | null;
    hrefs?: Partial<Record<Destination, string>>;
    onNewChat?: () => void;
    newChatDisabled?: boolean;
    search: string;
    onSearch: (value: string) => void;
    docked: boolean;
    open: boolean;
    onClose: () => void;
    footer?: ReactNode;
    children?: ReactNode;
}) {
    const panel = useRef<HTMLElement>(null);
    const hidden = !open;
    const modal = !docked && open;
    const [historyFlag, setHistoryExpanded] = useStoredFlag("zuychin-history", "expanded");
    const historyExpanded = !!children && historyFlag;

    useEffect(() => {
        if (!modal) return;
        const previous = document.activeElement as HTMLElement | null;
        panel.current?.querySelector<HTMLElement>("a, button, input")?.focus({ preventScroll: true });
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
            else if (event.key === "Tab" && panel.current) trapTab(event, panel.current);
        };
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("keydown", onKey); previous?.focus?.({ preventScroll: true }); };
    }, [modal, onClose]);

    const link = (destination: Destination, fallback: string) => hrefs?.[destination] ?? fallback;

    return <>
        {modal && <div className={styles.scrim} onClick={onClose} aria-hidden="true" />}
        <aside
            ref={panel} id={id} className={styles.sidebar} data-docked={docked} data-open={open}
            aria-label="Zuychin navigation" aria-hidden={hidden || undefined} inert={hidden || undefined}
            role={modal ? "dialog" : undefined} aria-modal={modal || undefined}
        >
            <div className={styles.brand}>
                <Link href="/" className={styles.brandLink} aria-label="Zuychin, new chat"><ZuychinMark size={20} /><span>Zuychin</span></Link>
                <button type="button" className={styles.iconButton} onClick={onClose} aria-label={docked ? "Hide sidebar" : "Close navigation"} title={docked ? "Hide sidebar" : "Close"}>
                    {docked ? <PanelLeftClose size={17} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
                </button>
            </div>
            <div className={styles.lead}>
                {onNewChat
                    ? <button type="button" className={styles.newChat} onClick={onNewChat} disabled={newChatDisabled}><SquarePen size={16} aria-hidden="true" />New chat</button>
                    : <Link href="/" className={styles.newChat}><SquarePen size={16} aria-hidden="true" />New chat</Link>}
                <label className={styles.search}>
                    <Search size={15} aria-hidden="true" />
                    <input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search chats" aria-label="Search chats by title" />
                </label>
            </div>
            <div className={styles.workspaces} data-collapsed={historyExpanded || undefined} inert={historyExpanded || undefined}>
                <div>
                    <nav className={styles.nav} aria-label="Workspaces">
                        {PRIMARY.map(({ id: destination, href, label, icon: Icon }) => <Link key={destination} href={link(destination, href)} aria-current={current === destination ? "page" : undefined}>
                            <Icon size={16} aria-hidden="true" /><span>{label}</span>
                        </Link>)}
                    </nav>
                    <div className={styles.rule} />
                    <nav className={styles.nav} aria-label="More">
                        <Link href={link("council", "/council")} aria-current={current === "council" ? "page" : undefined}><UsersRound size={16} aria-hidden="true" /><span>Council</span></Link>
                        <Link href={link("cosmos", "/graph")} aria-current={current === "cosmos" ? "page" : undefined}><CosmosIcon /><span>Cosmos</span></Link>
                    </nav>
                    <div className={styles.rule} />
                </div>
            </div>
            {children && <button
                type="button" className={styles.historyToggle} onClick={() => setHistoryExpanded(!historyExpanded)}
                aria-expanded={historyExpanded} aria-controls={`${id}-history`} title={historyExpanded ? "Show workspaces" : "Expand history"}
            >
                <span>History</span>
                {historyExpanded ? <ChevronsDown size={15} aria-hidden="true" /> : <ChevronsUp size={15} aria-hidden="true" />}
            </button>}
            <div id={`${id}-history`} className={styles.conversations}>{children}</div>
            <div className={styles.footer}>{footer ?? <span className={styles.footerLabel}>Theme</span>}<ThemeControl /></div>
        </aside>
    </>;
}
