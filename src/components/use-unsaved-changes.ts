"use client";

import { useEffect } from "react";

export function installUnsavedChangesGuard(browser: Window, document: Document, isDirty: () => boolean) {
    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (!isDirty()) return;
        event.preventDefault();
        event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
        if (!isDirty() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!link || link.hasAttribute("download") || link.hasAttribute("data-native-navigation") || (link.target && link.target !== "_self")) return;
        const destination = new URL(link.href, browser.location.href), current = new URL(browser.location.href);
        if (destination.origin !== current.origin || !["http:", "https:"].includes(destination.protocol) || (destination.pathname === current.pathname && destination.search === current.search)) return;
        if (!browser.confirm("You have unsaved changes. Discard them and leave this page?")) { event.preventDefault(); event.stopPropagation(); }
    };
    browser.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => { browser.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", click, true); };
}

export function useUnsavedChanges(isDirty: () => boolean) {
    useEffect(() => {
        if (!isDirty()) return;
        return installUnsavedChangesGuard(window, document, isDirty);
    }, [isDirty]);
}
