"use client";

import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import styles from "./markdown-reader.module.css";

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
    const components: Components = {
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
