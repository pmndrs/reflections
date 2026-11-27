# Releasing @pmndrs/reflections

The package is published from GitHub Actions (`.github/workflows/release.yml`) with npm trusted publishing:
no npm token anywhere, provenance attached. The workflow runs on a `v*` tag push (publishes) or by hand
from the Actions tab (dry run by default). The dist-tag follows the version: `x.y.z` goes to `latest`,
`x.y.z-alpha.N` to `alpha`, `-beta.N` to `beta`, `-rc.N` to `rc`; any other prerelease is refused.

## Before the first release (once)

1. **Make the repository public.** npm refuses provenance from a private repository, and the workflow
   publishes with `--provenance`. (pmndrs/reflections is private as of 2026-11-26.)
2. **Make sure `main` is pushed** and contains the release commit.
3. **The package must exist on npm before a trusted publisher can be added to it.** `@pmndrs/reflections`
   is not on npm yet. Two ways:
   - If npmjs.com lets you add a trusted publisher for a package name that doesn't exist yet (the
     "pending publisher" flow), do that (step 4) and skip to "Every release".
   - Otherwise publish `0.1.0-alpha.0` by hand once, from a clean checkout of the release commit (this is
     what @pmndrs/motion-vectors did for its first version):

     ```bash
     git status                      # clean, on the release commit
     pnpm install --frozen-lockfile
     npm login                       # an account that can publish under the @pmndrs scope
     npm publish --access public --tag alpha
     ```

     `prepublishOnly` runs typecheck, tests and the build; `prepack` / `postpack` strip the workspace
     devDependencies from the published manifest and restore package.json afterwards
     (`scripts/pack-manifest.mjs`). A hand publish carries no provenance; every later one does.
4. **Add the trusted publisher** on npmjs.com: package `@pmndrs/reflections` -> Settings -> Trusted
   publisher -> GitHub Actions:
   - Organization or user: `pmndrs`
   - Repository: `reflections`
   - Workflow filename: `release.yml`
   - Environment: `npm`

   npm expires a new trusted publisher that hasn't published within a few days, so add it shortly before
   the release. While there, set "Publishing access" to require 2FA and disallow tokens if you want only
   the workflow to publish.
5. **(Optional) Required reviewers**: GitHub -> Settings -> Environments -> `npm` (the job creates the
   environment on its first run if it doesn't exist) -> Required reviewers. A tag push then waits for an
   approval before publishing.
6. GitHub Actions must be able to run for the org (they did not start on 2026-11-26: org billing).

## Every release

1. **GPU checks on a real GPU** (CI has none): `pnpm check` on the release commit, all sections passing,
   and `FLICKER_REPEAT=2 pnpm check -- --only flicker` compared with the previous release if a default
   changed (CLAUDE.md rules 2 and 7).
2. **Version and changelog** in one commit on `main`: `package.json` `version` (e.g. `0.1.0-alpha.1`,
   `0.1.0`) and a `CHANGELOG.md` entry with the same version.
3. **Local gates**:

   ```bash
   pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build
   npm pack --dry-run                       # LICENSE, NOTICE, README.md, CHANGELOG.md, dist/
   npx publint                              # "All good!"
   npx @arethetypeswrong/cli --pack .       # only the ESM-only notice for CommonJS (expected: the package is ESM)
   ```

4. **Dry run on CI**: Actions -> Release -> Run workflow, branch `main`, `version` = the new version,
   `dry-run` checked (the default). It must end with `+ @pmndrs/reflections@<version>` and
   `Publishing to https://registry.npmjs.org/ with tag <alpha|beta|rc|latest> ... (dry-run)`.
5. **Tag and push** (publishes):

   ```bash
   git tag v0.1.0-alpha.0          # v + package.json's version, on the commit the dry run used
   git push origin v0.1.0-alpha.0
   ```

   The workflow refuses a tag that differs from package.json's version. (Running the workflow by hand with
   `dry-run` unchecked publishes too, without a tag.)

## After publishing

- `npm view @pmndrs/reflections dist-tags` shows the version under the right tag (`alpha` for
  `0.1.0-alpha.0`; `latest` stays unset until the first stable release, then `0.1.0`).
- The package page on npmjs.com shows the provenance badge ("Built and signed on GitHub Actions") linking
  to the workflow run and the commit.
- A fresh consumer installs and builds: in an empty directory,
  `npm create vite@latest app -- --template vanilla-ts`, then
  `npm i @pmndrs/reflections@alpha three@0.187` (ray tracing: `@pmndrs/raytracer @pmndrs/bvh` too),
  import from `@pmndrs/reflections/three`, `npx tsc --noEmit`, `npx vite build`.
- Create a GitHub release from the tag with the CHANGELOG entry (mark it "pre-release" for alpha / beta / rc).
- **0.1.0 waits for the examples** (maintainer, 2026-11-27): every page in `docs/EXAMPLES.md` built, checked in
  `pnpm check`, and on the site.
- Moving `alpha` to `0.1.0` stable: bump to `0.1.0`, changelog, dry run, tag `v0.1.0`; it lands on
  `latest`. Old prerelease tags stay where they are unless you move them
  (`npm dist-tag add @pmndrs/reflections@0.1.0 alpha` if `alpha` should follow).

## What the workflow checks

Version guard (input or tag = package.json's version, package not private), dist-tag from the version,
`pnpm install --frozen-lockfile`, typecheck, unit tests, build, the packed manifest names no workspace
package or `workspace:` specifier and dist names no private package, the tarball holds LICENSE, NOTICE,
README.md, CHANGELOG.md and the entry points, then `npm publish --provenance --access public --tag <tag>`
(`--dry-run` for a dry run). Node 24, pnpm from `packageManager`, npm pinned to 11.6.2 (trusted publishing
needs npm >= 11.5.1).
