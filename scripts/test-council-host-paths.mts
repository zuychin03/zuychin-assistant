// Containment tests for council-host-paths.mts: MSYS drive-letter
// normalisation, the <tree>-evil boundary, symlink escape, and write targets
// that do not exist yet.
//
//   npx tsx scripts/test-council-host-paths.mts
//
// Builds its own temp tree and deletes it afterwards, including on failure.

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideWorktree, normalizeMsysDrive } from "./council-host-paths.mts";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    }
}

// C:\Users\... -> /c/Users/... (or /C/... when upper is set).
function toMsys(nativePath: string, upper = false): string {
    const letter = nativePath[0];
    if (!/^[A-Za-z]$/.test(letter) || nativePath[1] !== ":") {
        throw new Error(`not a drive-rooted path: ${nativePath}`);
    }
    const drive = upper ? letter.toUpperCase() : letter.toLowerCase();
    return `/${drive}${nativePath.slice(2).replace(/\\/g, "/")}`;
}

const win32 = process.platform === "win32";

const base = await mkdtemp(join(tmpdir(), "council-paths-"));
try {
    const tree = join(base, "tree");
    const evil = join(base, "tree-evil");
    const outside = join(base, "outside");
    await mkdir(tree);
    await mkdir(evil);
    await mkdir(outside);
    await writeFile(join(tree, "file.ts"), "// inside\n");
    await writeFile(join(evil, "file.ts"), "// evil\n");
    await writeFile(join(outside, "escaped.ts"), "// outside\n");
    // Junction on Windows needs no admin right; a real symlink elsewhere.
    await symlink(outside, join(tree, "link-out"), win32 ? "junction" : "dir");

    const treeReal = await realpath(tree);
    const evilReal = await realpath(evil);
    const outsideReal = await realpath(outside);

    console.log("normalizeMsysDrive (platform parameterised, runs anywhere)");
    check("non-win32 leaves /c/... untouched", normalizeMsysDrive("/c/Users/x", "linux") === "/c/Users/x");
    check(
        "non-win32 leaves native win path untouched",
        normalizeMsysDrive("C:\\Users\\x", "linux") === "C:\\Users\\x",
    );
    check("win32 rewrites lowercase drive", normalizeMsysDrive("/c/Users/x", "win32") === "C:/Users/x");
    check("win32 rewrites uppercase drive", normalizeMsysDrive("/C/Users/x", "win32") === "C:/Users/x");
    check("win32 leaves bare /c unchanged", normalizeMsysDrive("/c", "win32") === "/c");
    check("win32 leaves /Users/... unchanged", normalizeMsysDrive("/Users/x", "win32") === "/Users/x");
    check("win32 leaves native path unchanged", normalizeMsysDrive("C:\\Users\\x", "win32") === "C:\\Users\\x");

    if (win32) {
        console.log("insideWorktree, MSYS candidates on Windows");
        check("c1 /c/.../tree/file.ts inside", await insideWorktree(toMsys(join(treeReal, "file.ts")), tree));
        check("c2 /C/.../tree/file.ts inside", await insideWorktree(toMsys(join(treeReal, "file.ts"), true), tree));
        check("c3 /c/.../tree-evil/file.ts outside", !(await insideWorktree(toMsys(join(evilReal, "file.ts")), tree)));
        check("c4 /c/.../outside/escaped.ts outside", !(await insideWorktree(toMsys(join(outsideReal, "escaped.ts")), tree)));
        check("c4 native outside stays outside", !(await insideWorktree(join(outsideReal, "escaped.ts"), tree)));
        check("c5 C:\\... inside", await insideWorktree(join(treeReal, "file.ts"), tree));
        check("c5 C:/... inside", await insideWorktree(join(treeReal, "file.ts").replace(/\\/g, "/"), tree));
        check("c7 native junction escape outside", !(await insideWorktree(join(treeReal, "link-out", "escaped.ts"), tree)));
        check("c7 MSYS junction escape outside", !(await insideWorktree(toMsys(join(treeReal, "link-out", "escaped.ts")), tree)));
        check("c8 native nonexistent descendant inside", await insideWorktree(join(treeReal, "new-dir", "new.ts"), tree));
        check("c8 MSYS nonexistent descendant inside", await insideWorktree(toMsys(join(treeReal, "new-dir", "new.ts")), tree));
        check("c8 MSYS nonexistent under tree-evil outside", !(await insideWorktree(toMsys(join(evilReal, "new.ts")), tree)));
        check("MSYS treeDir, native candidate inside", await insideWorktree(join(treeReal, "file.ts"), toMsys(treeReal)));
    } else {
        console.log("insideWorktree, native candidates (MSYS cases are win32-only)");
        check("in-tree file inside", await insideWorktree(join(treeReal, "file.ts"), tree));
        check("tree-evil outside", !(await insideWorktree(join(evilReal, "file.ts"), tree)));
        check("genuine outside stays outside", !(await insideWorktree(join(outsideReal, "escaped.ts"), tree)));
        check("symlink escape outside", !(await insideWorktree(join(treeReal, "link-out", "escaped.ts"), tree)));
        check("nonexistent descendant inside", await insideWorktree(join(treeReal, "new-dir", "new.ts"), tree));
    }
} finally {
    await rm(base, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
