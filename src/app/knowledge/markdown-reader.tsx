"use client";

import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import styles from "./markdown-reader.module.css";
import { documentHeadings } from "../graph/cosmos/sections";
import type { ElementType, ReactNode } from "react";

interface MarkdownReaderProps {
    markdown: string;
    variant?: "document" | "answer" | "excerpt";
    onVaultLink?: (reference: string) => void;
}

function prepareMarkdown(markdown: string) {
    const withoutFrontmatter = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();

    return withoutFrontmatter.replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, _embed, target, alias) => {
        const label = (alias || target).trim();
        const href = `vault://${target.trim().replace(/ /g, "%20")}`;
        return `[${label}](${href})`;
    });
}

function vaultReference(href: string) {
    try {
        return decodeURIComponent(href.slice("vault://".length));
    } catch {
        return href.slice("vault://".length);
    }
}

export function MarkdownReader({ markdown, variant = "document", onVaultLink }: MarkdownReaderProps) {
    const headings = new Map(documentHeadings(markdown).map((heading) => [heading.line, heading]));
    const heading = (Tag: ElementType) => function Heading({ node, children }: {
        node?: { position?: { start: { line: number } } }; children?: ReactNode;
    }) {
        const match = headings.get(node?.position?.start.line ?? -1);
        return <Tag data-section-id={match?.id} tabIndex={-1}>{children}</Tag>;
    };
    const components: Components = {
        h1: heading("h1"), h2: heading("h2"), h3: heading("h3"),
        h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
        table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
        a: ({ href = "", children }) => {
            if (href.startsWith("vault://")) {
                const reference = vaultReference(href);
                return <button type="button" className={styles.vaultLink} onClick={() => onVaultLink?.(reference)}>
                    <FileText size={13} aria-hidden="true" />{children}
                </button>;
            }

            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
    };

    return <div className={styles.reader} data-variant={variant}>
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={components}
            urlTransform={(url) => url.startsWith("vault://") ? url : defaultUrlTransform(url)}
        >
            {prepareMarkdown(markdown)}
        </ReactMarkdown>
    </div>;
}
