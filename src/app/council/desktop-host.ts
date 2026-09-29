"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HostExitReason, HostHealthV1, HostLogLevel } from "@/lib/council/supervisor";

export interface DesktopHostStatus {
    phase: "stopped" | "starting" | "running" | "stopping" | "failed";
    owned: boolean;
    restartSafe: boolean;
    health: Omit<HostHealthV1, "v" | "type" | "at"> | null;
    logs: { atMs: number; level: HostLogLevel; message: string }[];
    error: string | null;
    lastExit: {
        code: number | null;
        reason: HostExitReason | null;
        clean: boolean;
        forced: boolean;
        draining: boolean | null;
    } | null;
}

export function isDesktopHostAvailable(): boolean {
    return typeof window !== "undefined" && isTauri();
}

export function readDesktopHostStatus(): Promise<DesktopHostStatus> {
    return invoke<DesktopHostStatus>("council_desktop_status");
}

export function startDesktopHost(): Promise<DesktopHostStatus> {
    return invoke<DesktopHostStatus>("council_desktop_start");
}

export function stopDesktopHost(): Promise<DesktopHostStatus> {
    return invoke<DesktopHostStatus>("council_desktop_stop");
}

export function restartDesktopHost(): Promise<DesktopHostStatus> {
    return invoke<DesktopHostStatus>("council_desktop_restart");
}
