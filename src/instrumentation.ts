export async function register() {
    // Imports inside this block stay out of the edge build, which cannot bundle node:crypto.
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { registerNode } = await import("./instrumentation-node");
        await registerNode();
    }
}
