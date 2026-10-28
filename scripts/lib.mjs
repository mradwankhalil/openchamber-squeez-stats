/**
 * Shared by release.mjs and check-release.mjs.
 *
 * OpenChamber offers "Update" for a git-installed extension when the
 * repository's package.json `version` is higher than the installed one. These
 * helpers decide which changes reach users and compare versions.
 */
import { spawnSync } from "node:child_process"

/** Run a command, inherit output, throw on failure. */
export function run(cmd, args, options = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", ...options })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`)
}

/** Run a command and return trimmed stdout; throw on failure. */
export function capture(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: "utf8" })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}: ${r.stderr.trim()}`)
    return r.stdout.trim()
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function parseVersion(v) {
    const m = SEMVER.exec(String(v).trim())
    if (!m) throw new Error(`not a plain x.y.z version: ${v}`)
    return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** negative, zero or positive, like a sort comparator */
export function compareVersions(a, b) {
    const x = parseVersion(a)
    const y = parseVersion(b)
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
}

export function bumpVersion(current, kind) {
    if (SEMVER.test(kind)) {
        if (compareVersions(kind, current) <= 0) throw new Error(`${kind} is not higher than ${current}`)
        return kind
    }
    const [major, minor, patch] = parseVersion(current)
    if (kind === "major") return `${major + 1}.0.0`
    if (kind === "minor") return `${major}.${minor + 1}.0`
    if (kind === "patch") return `${major}.${minor}.${patch + 1}`
    throw new Error(`unknown bump "${kind}": use patch, minor, major or x.y.z`)
}

/**
 * Files whose change reaches users. OpenChamber serves the built bundles,
 * the panel page, its stylesheet and the icon; package.json matters for its
 * `openchamber` manifest and runtime dependencies (checked separately).
 * Sources (*.ts) are excluded: changing them without rebuilding is caught by
 * the fresh-build check instead.
 */
export function isShipped(file) {
    if (file === "icon.svg") return true
    if (/^panel\/.+\.(js|html|css|svg|png)$/.test(file)) return true
    if (/^service\/.+\.js$/.test(file)) return true
    return false
}

/** The part of package.json that reaches users. */
export function shippedManifest(pkg) {
    return JSON.stringify({ openchamber: pkg.openchamber ?? null, dependencies: pkg.dependencies ?? null })
}
