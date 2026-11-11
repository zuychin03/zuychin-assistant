"use client";

import { useSyncExternalStore } from "react";
import { documentDestination } from "@/lib/document-navigation";

const subscribe = () => () => {};

/** documentDestination() for render paths: the remembered location lives in sessionStorage, which the server render cannot see. */
export function useDocumentDestination(surface: "/" | "/knowledge" | "/graph"): string {
    return useSyncExternalStore(subscribe, () => documentDestination(surface), () => surface);
}
