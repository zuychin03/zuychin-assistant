"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

type WorkspaceLinkProps = Omit<ComponentProps<"a">, "href"> & { href: string };

export function WorkspaceLink({ href, ...props }: WorkspaceLinkProps) {
    // A document boundary lets browser Back protect drafts through beforeunload.
    if (/^\/(?:knowledge|research|study|capture|tasks|admin)(?:[/?#]|$)/.test(href)) {
        return <a href={href} {...props} data-native-navigation />;
    }
    return <Link href={href} {...props} />;
}
