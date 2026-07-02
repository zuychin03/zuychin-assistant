// GitHub commits race on the branch ref (base tree → new head), so all vault
// writes (ingest, direct writes, lint) are serialised per server instance.
let writeQueue: Promise<unknown> = Promise.resolve();

export function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
}
