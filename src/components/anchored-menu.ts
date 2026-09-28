interface AnchoredMenuOptions {
    align?: "start" | "end";
    maxHeight?: number;
    minWidth?: number;
    gap?: number;
    margin?: number;
    preferAbove?: boolean;
}

export function observeAnchoredMenu(
    trigger: HTMLElement,
    menu: HTMLElement,
    { align = "start", maxHeight = 280, minWidth = 0, gap = 4, margin = 8, preferAbove = false }: AnchoredMenuOptions = {},
): () => void {
    let frame = 0;
    const viewport = window.visualViewport;

    const place = () => {
        const box = trigger.getBoundingClientRect();
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
        const viewportHeight = viewport?.height ?? window.innerHeight;
        const leftEdge = viewportLeft + margin;
        const rightEdge = viewportLeft + viewportWidth - margin;
        const topEdge = viewportTop + margin;
        const bottomEdge = viewportTop + viewportHeight - margin;
        const availableWidth = Math.max(0, rightEdge - leftEdge);

        menu.style.minWidth = `${Math.min(Math.max(box.width, minWidth), availableWidth)}px`;
        menu.style.maxWidth = `${availableWidth}px`;
        menu.style.maxHeight = `${maxHeight}px`;

        // Opening animations scale the visual rectangle, not the layout box.
        const size = { width: menu.offsetWidth, height: menu.offsetHeight };
        const below = Math.max(0, bottomEdge - Math.max(box.bottom + gap, topEdge));
        const above = Math.max(0, Math.min(box.top - gap, bottomEdge) - topEdge);
        const desiredHeight = Math.min(maxHeight, size.height);
        const useAbove = preferAbove
            ? above >= desiredHeight || above >= below
            : below < desiredHeight && above > below;
        const height = Math.min(desiredHeight, useAbove ? above : below);
        const left = align === "end" ? box.right - size.width : box.left;
        const top = useAbove ? box.top - gap - height : box.bottom + gap;

        menu.style.maxHeight = `${height}px`;
        menu.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - size.width))}px`;
        menu.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
        menu.style.visibility = "visible";
    };

    const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(place);
    };
    const onScroll = (event: Event) => {
        if (event.target instanceof Node && menu.contains(event.target)) return;
        schedule();
    };

    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(trigger);
    observer.observe(menu);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    viewport?.addEventListener("resize", schedule);

    return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", schedule);
        viewport?.removeEventListener("scroll", schedule);
        viewport?.removeEventListener("resize", schedule);
    };
}
