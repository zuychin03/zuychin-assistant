export function safeVaultPath(input: string): string {
    const path = input.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.includes("\0")) throw new Error("Invalid vault path.");
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Unsafe vault path: ${input}`);
    }
    if (segments[0].toLowerCase() === ".git") throw new Error("Git metadata cannot be imported.");
    return path;
}
