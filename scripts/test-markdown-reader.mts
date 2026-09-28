import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";

interface ReaderProps {
    markdown: string;
    variant?: "document" | "answer" | "excerpt";
    onVaultLink?: (reference: string) => void;
}
interface ReferenceProps { onClick?: () => void; tabIndex?: number; role?: string }
type Anchor = (props: { href: string; children: string }) => ReactElement<ReferenceProps>;
type ReaderElement = ReactElement<{ children: ReactElement<{ components: { a: Anchor } }> }>;
const exported = {} as { MarkdownReader(props: ReaderProps): ReaderElement };
const source = readFileSync(new URL("../src/app/knowledge/markdown-reader.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
vm.runInNewContext(compiled, {
    exports: exported,
    require(name: string) {
        if (name === "react/jsx-runtime") return jsxRuntime;
        if (name === "react-markdown") return { default: ReactMarkdown, defaultUrlTransform };
        if (name === "remark-gfm") return { default: remarkGfm };
        if (name === "lucide-react") return { FileText };
        if (name.endsWith(".module.css")) return { default: { reader: "reader", vaultLink: "vaultLink" } };
        if (name.endsWith("/sections")) return { documentHeadings: () => [] };
        throw new Error(`Unmocked import: ${name}`);
    },
});

for (const variant of ["document", "answer", "excerpt"] as const) {
    test(`${variant} wiki references have no action when navigation is unavailable`, () => {
        const props = { markdown: "[[wiki/My page|Saved note]] and [[source-note]]", variant };
        const html = renderToStaticMarkup(createElement(exported.MarkdownReader, props));
        assert.match(html, /<span>Saved note<\/span>/);
        assert.match(html, /<span>source-note<\/span>/);
        assert.doesNotMatch(html, /<(?:button|a)\b|tabindex=|role="(?:button|link)"/);
        const reference = exported.MarkdownReader(props).props.children.props.components.a({ href: "vault://source-note", children: "source-note" });
        assert.equal(reference.props.onClick, undefined);
    });

    test(`${variant} wiki references retain navigation with decoded targets`, () => {
        const visited: string[] = [];
        const props = { markdown: "[[wiki/My page|Saved note]]", variant, onVaultLink: (target: string) => visited.push(target) };
        const html = renderToStaticMarkup(createElement(exported.MarkdownReader, props));
        assert.match(html, /<button type="button" class="vaultLink">/);
        assert.match(html, /Saved note<\/button>/);
        const reference = exported.MarkdownReader(props).props.children.props.components.a({ href: "vault://wiki/My%20page", children: "Saved note" });
        assert.equal(reference.type, "button");
        reference.props.onClick!();
        assert.deepEqual(visited, ["wiki/My page"]);
    });
}

test("external Markdown links retain their existing behaviour without vault navigation", () => {
    const html = renderToStaticMarkup(createElement(exported.MarkdownReader, { markdown: "[Source](https://example.test/source)" }));
    assert.match(html, /<a href="https:\/\/example\.test\/source" target="_blank" rel="noreferrer">Source<\/a>/);
});
