import Link from "next/link";
import { ArrowLeft, BookOpen } from "lucide-react";
import styles from "./not-found.module.css";

export default function NotFound() {
    return <main className={styles.page}>
        <div className={styles.content}>
            <h1>Page not found</h1>
            <p>We couldn’t find that page. Check the address or choose a workspace below.</p>
            <nav aria-label="Page recovery" className={styles.actions}>
                <Link href="/" className={styles.primary}><ArrowLeft size={18} aria-hidden="true" />Return to chat</Link>
                <Link href="/knowledge"><BookOpen size={18} aria-hidden="true" />Open Library</Link>
            </nav>
        </div>
    </main>;
}
