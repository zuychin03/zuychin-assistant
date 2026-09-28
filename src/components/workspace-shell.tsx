"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { ArrowLeft, BookOpen, FlaskConical, GraduationCap, Inbox, ListTodo, MessageSquare, Moon, ShieldCheck, Sun } from "lucide-react";
import styles from "./workspace-shell.module.css";

type Workspace = "library" | "research" | "study" | "capture" | "tasks" | "conversations" | "admin";
const destinations = [
    { id: "conversations", href: "/", label: "Chat", icon: MessageSquare },
    { id: "library", href: "/knowledge", label: "Library", icon: BookOpen },
    { id: "research", href: "/research", label: "Research", icon: FlaskConical },
    { id: "study", href: "/study", label: "Study", icon: GraduationCap },
    { id: "capture", href: "/capture", label: "Capture", icon: Inbox },
    { id: "tasks", href: "/tasks", label: "Tasks", icon: ListTodo },
    { id: "admin", href: "/admin", label: "Dashboard", icon: ShieldCheck },
] as const;

function subscribeTheme(onChange: () => void) {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
}

export function WorkspaceThemeButton() {
    const dark = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme === "dark", () => false);
    function toggleTheme() {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("zuychin-theme", next); } catch { /* Theme still applies for this page. */ }
    }
    return <button type="button" onClick={toggleTheme} className={styles.iconButton} aria-label={`Switch to ${dark ? "light" : "dark"} mode`} title={`${dark ? "Light" : "Dark"} mode`}>
        {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>;
}

export function WorkspaceNavigation({ current }: { current: Workspace }) {
    const navigation = useRef<HTMLElement>(null);
    useEffect(() => {
        const nav = navigation.current;
        const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
        if (!nav || !active) return;
        const revealActive = () => {
            if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.clientWidth) / 2);
        };
        revealActive();
        const observer = new ResizeObserver(revealActive);
        observer.observe(nav);
        return () => observer.disconnect();
    }, [current]);
    return <nav ref={navigation} className={styles.navigation} aria-label="Assistant workspaces">
        {destinations.map(({ id, href, label, icon: Icon }) => <Link href={href} key={id} aria-current={current === id ? "page" : undefined}>
            <Icon size={15} aria-hidden="true" /><span>{label}</span>
        </Link>)}
    </nav>;
}

export function WorkspaceShell({ current, title, description, actions, children, backHref = "/" }: {
    current: Workspace; title: string; description: string; actions?: ReactNode; children: ReactNode; backHref?: string;
}) {
    return <main className={styles.shell}>
        <a href="#workspace-content" className={styles.skip}>Skip to content</a>
        <header className={styles.header}>
            <div className={styles.titleGroup}>
                <Link href={backHref} className={styles.iconButton} aria-label="Back to chat"><ArrowLeft size={18} aria-hidden="true" /></Link>
                <div><h1>{title}</h1><p>{description}</p></div>
            </div>
            <div className={styles.actions}>{actions}<WorkspaceThemeButton /></div>
        </header>
        <WorkspaceNavigation current={current} />
        <div id="workspace-content" tabIndex={-1} className={styles.content}>{children}</div>
    </main>;
}
