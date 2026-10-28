/**
 * Cut a release: bump `version`, rebuild, verify, commit and tag. Never pushes.
 *
 *   bun run release patch      0.3.0 -> 0.3.1   fixes
 *   bun run release minor      0.3.0 -> 0.4.0   features
 *   bun run release major      0.3.0 -> 1.0.0
 *   bun run release 1.2.3      an explicit, higher version
 *   add --dry-run to check everything and change nothing
 *
 * Users who installed from the git URL see "Update" in Settings → Extensions
 * once the pushed version is higher than theirs. Push with:
 *   git push origin main --follow-tags
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bumpVersion, capture, run } from "./lib.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const kind = args.find((a) => !a.startsWith("--"))
if (!kind) {
    console.error("usage: bun run release <patch|minor|major|x.y.z> [--dry-run]")
    process.exit(2)
}

function fail(message) {
    console.error(`release: ${message}`)
    process.exit(1)
}

try {
    if (capture("git", ["status", "--porcelain"])) fail("the working tree has uncommitted changes; commit or stash them first")
    const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"])
    if (branch !== "main") console.warn(`release: note: releasing from "${branch}", not main`)

    const pkgFile = path.join(root, "package.json")
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
    const next = bumpVersion(pkg.version, kind)
    const tag = `v${next}`
    if (capture("git", ["tag", "--list", tag])) fail(`tag ${tag} already exists`)
    console.log(`release: ${pkg.version} -> ${next}${dryRun ? " (dry run)" : ""}`)

    // verify first, from the committed sources
    run("bun", ["run", "verify"])

    if (dryRun) {
        const dirty = capture("git", ["status", "--porcelain"])
        if (dirty) fail(`the build changed committed files; rebuild and commit them first:\n${dirty}`)
        console.log(`release: dry run ok; ${tag} would be committed and tagged`)
        process.exit(0)
    }

    pkg.version = next
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 4)}\n`)
    run("git", ["add", "package.json", "panel/main.js", "service/main.js"])
    run("git", ["commit", "-m", `Release ${tag}`])
    run("git", ["tag", "-a", tag, "-m", `Release ${tag}`])
    console.log(`release: committed and tagged ${tag}. Nothing was pushed. Push with:\n  git push origin main --follow-tags`)
} catch (error) {
    fail(error instanceof Error ? error.message : String(error))
}
