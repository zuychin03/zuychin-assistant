"use client";

import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import { MarkdownImage } from "@/components/markdown-image";
import styles from "./markdown-reader.module.css";
import { documentHeadings } from "../graph/cosmos/sections";
import type { ElementType, ReactNode } from "react";

interface MarkdownReaderProps {
    markdown: string;
    variant?: "document" | "answer" | "excerpt";
    onVaultLink?: (reference: string) => void;
    /** The page title shown above the reader; a leading H1 repeating it is kept only as a section anchor. */
    title?: string;
}

function prepareMarkdown(markdown: string) {
    // Keep leading lines: documentHeadings() keys sections by source line in the same frontmatter-free body.
    const withoutFrontmatter = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trimEnd();

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

export function MarkdownReader({ markdown, variant = "document", onVaultLink, title }: MarkdownReaderProps) {
    const list = documentHeadings(markdown);
    const headings = new Map(list.map((heading) => [heading.line, heading]));
    const echo = title && list[0]?.level === 1 && list[0].title.trim().toLowerCase() === title.trim().toLowerCase() ? list[0] : undefined;
    const heading = (Tag: ElementType) => function Heading({ node, children }: {
        node?: { position?: { start: { line: number } } }; children?: ReactNode;
    }) {
        const match = headings.get(node?.position?.start.line ?? -1);
        if (match && match === echo) return <span data-section-id={match.id} tabIndex={-1} />;
        return <Tag data-section-id={match?.id} tabIndex={-1}>{children}</Tag>;
    };
    const components: Components = {
        h1: heading("h1"), h2: heading("h2"), h3: heading("h3"),
        h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
        table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
        a: ({ href = "", children }) => {
            if (href.startsWith("vault://")) {
                if (!onVaultLink) return <span>{children}</span>;
                const reference = vaultReference(href);
                return <button type="button" className={styles.vaultLink} onClick={() => onVaultLink(reference)}>
                    <FileText size={13} aria-hidden="true" />{children}
                </button>;
            }

            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
        // Answers are model output; stored documents keep their images.
        ...(variant === "answer" ? { img: MarkdownImage } : {}),
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
