"use client";

import Link from "next/link";
import type { Message } from "@/lib/types";
import { matchingPrefixCount, type BranchComparison, type BranchComparisonSide } from "@/lib/conversations/branches";
import styles from "./branches.module.css";

function MessageRecord({ message, index }: { message: Message; index: number }) {
    const models = message.metadata?.historicalModels;
    const identity = Array.isArray(models) ? models.flatMap((model) =>
        model && typeof model.providerId === "string" && typeof model.modelId === "string" ? [`${model.providerId} / ${model.modelId}`] : []) : [];
    return <li className={styles.message}>
        <header><strong>{message.role === "assistant" ? "Assistant" : message.role === "user" ? "You" : "System record"}</strong><span>Message {index + 1}</span></header>
        {!!identity.length && <small>Copied historical model: {identity.join(", ")}</small>}
        {!!message.metadata?.knowledgeOnly && <small>Saved sources only</small>}
        {message.metadata?.replyTo && <blockquote className={styles.quote}>Replying to {message.metadata.replyTo.role}: {message.metadata.replyTo.content}</blockquote>}
        <div className={styles.content}>{message.content}</div>
        {message.imageUrl && <small>Image attachment preserved in chat.</small>}
    </li>;
}
function ConversationColumn({ side, shared }: { side: BranchComparisonSide; shared: number }) {
    return <section className={styles.column} aria-label={side.conversation.title}>
        <header className={styles.columnHeader}>
            <div><p>{side.conversation.parentConversationId ? "Branch" : "Original conversation"}</p><h2>{side.conversation.title}</h2></div>
            <Link className={styles.button} href={`/?${new URLSearchParams({ c: side.conversation.id })}`}>Continue here</Link>
        </header>
        {shared > 0 && <details className={styles.shared}><summary>{shared} matching earlier {shared === 1 ? "message" : "messages"}</summary>
            <ol className={styles.messages}>{side.messages.slice(0, shared).map((message, index) => <MessageRecord key={message.id} message={message} index={index} />)}</ol>
        </details>}
        {side.messages.length === shared ? <p className={styles.empty}>No different messages yet. Continue this conversation to explore another prompt or model.</p>
            : <ol className={styles.messages} start={shared + 1}>{side.messages.slice(shared).map((message, index) => <MessageRecord key={message.id} message={message} index={shared + index} />)}</ol>}
    </section>;
}
export function BranchComparisonContent({ result }: { result: BranchComparison }) {
    const shared = matchingPrefixCount(result.left.messages, result.right.messages);
    return <div className={styles.comparison}><ConversationColumn side={result.left} shared={shared} /><ConversationColumn side={result.right} shared={shared} /></div>;
}
