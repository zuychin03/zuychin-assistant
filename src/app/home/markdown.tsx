"use client";

import { isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { Components } from "react-markdown";

// react-markdown hands `pre` a React tree, not the source text, so the copy
// button has to reassemble it from the rendered children.
export function textOf(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
    return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            // Trailing newline is an artifact of the fence, not of the code.
            await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard denied (insecure origin or permission); leave the icon unchanged
            // rather than claiming a copy that did not happen.
        }
    };

    return (
        <div className="code-block">
            <button
                type="button"
                className="code-copy"
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy code"}
                title={copied ? "Copied" : "Copy code"}
            >
                {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <pre>{children}</pre>
        </div>
    );
}

export const chatMarkdownComponents: Components = {
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    // A wide table must scroll inside the bubble instead of compressing its
    // columns to fit, the same way a long code line already does.
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};
