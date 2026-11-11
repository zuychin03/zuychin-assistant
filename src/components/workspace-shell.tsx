"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { AppSidebar, SidebarToggle, useMediaQuery, useSidebarState, type Destination } from "@/components/app-sidebar";
import { TODAY_DOCKED_QUERY, TodayPanel, TodayToggle, useDueCount } from "@/components/today-panel";
import { ConversationList, type ConversationItem, type ProjectItem } from "@/app/home/conversation-list";
import styles from "./workspace-shell.module.css";

type Workspace = Destination | "conversations" | "admin";

const toDestination = (workspace: Workspace): Destination =>
    workspace === "conversations" ? "chat" : workspace === "admin" ? "dashboard" : workspace;

export function RecentChats({ filter }: { filter: string }) {
    const [conversations, setConversations] = useState<ConversationItem[]>([]);
    const [projects, setProjects] = useState<ProjectItem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        const read = <T,>(url: string) => fetch(url, { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<T> : Promise.reject(new Error(String(response.status))));
        Promise.allSettled([read<{ conversations?: ConversationItem[] }>("/api/conversations"), read<{ projects?: ProjectItem[] }>("/api/projects")]).then(([chats, groups]) => {
            if (controller.signal.aborted) return;
            if (chats.status === "fulfilled" && Array.isArray(chats.value.conversations)) setConversations(chats.value.conversations);
            else setFailed(true);
            if (groups.status === "fulfilled" && Array.isArray(groups.value.projects)) setProjects(groups.value.projects);
            setLoaded(true);
        });
        return () => controller.abort();
    }, []);

    if (failed) return <p className={styles.sidebarNote}>Chats could not be loaded.</p>;
    return <ConversationList conversations={conversations} projects={projects} activeConversationId={null} loaded={loaded} filter={filter} />;
}

export function WorkspaceShell({ current, title, description, actions, toolbar, children, backHref, backLabel = "Back", fill = false }: {
    current: Workspace;
    title: string;
    description?: string;
    actions?: ReactNode;
    toolbar?: ReactNode;
    children: ReactNode;
    backHref?: string;
    backLabel?: string;
    fill?: boolean;
}) {
    const sidebar = useSidebarState();
    const [search, setSearch] = useState("");
    const [todayOpen, setTodayOpen] = useState(false);
    const todayDocked = useMediaQuery(TODAY_DOCKED_QUERY, false);
    const [due, setDue] = useDueCount();
    const closeToday = useCallback(() => setTodayOpen(false), []);

    return <div className={styles.app} data-fill={fill || undefined}>
        <a href="#workspace-content" className={styles.skip}>Skip to content</a>
        <AppSidebar current={toDestination(current)} search={search} onSearch={setSearch} docked={sidebar.docked} open={sidebar.open} onClose={sidebar.close}>
            <RecentChats filter={search} />
        </AppSidebar>
        <main className={styles.main}>
            <header className={styles.topbar}>
                {(!sidebar.docked || !sidebar.open) && <SidebarToggle open={sidebar.open} onToggle={() => sidebar.setOpen(!sidebar.open)} />}
                {backHref && <Link href={backHref} className={styles.iconButton} aria-label={backLabel} title={backLabel}><ArrowLeft size={18} aria-hidden="true" /></Link>}
                <div className={styles.heading}>
                    <h1>{title}</h1>
                    {description && <p>{description}</p>}
                </div>
                {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
                <div className={styles.actions}>{actions}</div>
                <TodayToggle open={todayOpen} onToggle={() => setTodayOpen((open) => !open)} due={due} compact={!todayDocked} />
            </header>
            <div id="workspace-content" tabIndex={-1} className={styles.content}>{children}</div>
        </main>
        {todayOpen && <TodayPanel variant={todayDocked ? "docked" : "sheet"} onClose={closeToday} onDueCount={setDue} />}
    </div>;
}
