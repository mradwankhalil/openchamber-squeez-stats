/**
 * Fails when changes that reach users arrive without a higher `version`, so
 * OpenChamber would never offer them as an update.
 *
 *   node scripts/check-release.mjs <base-ref>     compare HEAD with base-ref
 *
 * Used by CI with the commit before a push (or a pull request's base).
 * Exit 0: no shipped change, or the version went up. Exit 1: shipped change
 * without a version bump, or the version went down.
 */
import { compareVersions, capture, isShipped, shippedManifest } from "./lib.mjs"

const base = process.argv[2]
if (!base || /^0+$/.test(base)) {
    console.log("check-release: no base commit (new branch); nothing to compare")
    process.exit(0)
}

function pkgAt(ref) {
    try {
        return JSON.parse(capture("git", ["show", `${ref}:package.json`]))
    } catch {
        return null
    }
}

const before = pkgAt(base)
const after = pkgAt("HEAD")
if (!after) {
    console.error("check-release: HEAD has no readable package.json")
    process.exit(1)
}
if (!before) {
    console.log(`check-release: ${base} has no package.json; first release ${after.version}`)
    process.exit(0)
}

const changed = capture("git", ["diff", "--name-only", `${base}`, "HEAD"]).split(/\r?\n/).filter(Boolean)
const shipped = changed.filter(isShipped)
if (shippedManifest(before) !== shippedManifest(after)) shipped.push("package.json (manifest or dependencies)")

const order = compareVersions(after.version, before.version)
if (order < 0) {
    console.error(`check-release: version went down: ${before.version} -> ${after.version}`)
    process.exit(1)
}
if (shipped.length === 0) {
    console.log(`check-release: no change reaches users (${changed.length} file(s) changed); version ${after.version}`)
    process.exit(0)
}
if (order === 0) {
    console.error(
        `check-release: these changes reach users but version is still ${after.version}, so OpenChamber will not offer an update:\n` +
            shipped.map((f) => `  ${f}`).join("\n") +
            "\nRun `bun run release patch` (or minor/major) and push again.",
    )
    process.exit(1)
}
console.log(`check-release: ${shipped.length} shipped change(s), version ${before.version} -> ${after.version}`)
