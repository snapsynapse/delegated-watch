# Release Checklist

Delegated.watch ships an agent-facing install guide anchored in DNS, a hosted landing page and demo deployed from `main`, and a public candidate inventory that pins every shipped file by hash. Merging to `main` publishes the site, so the release pull request is itself a publication step. Run this checklist for every release, in order.

## 1. Version and date sites
Set the new version and the release date in every file below, in one change:
- `package.json` and `package-lock.json` (two `version` fields).
- `config/site.json`: `version` and `date_modified`.
- `docs/llms.txt`: the `Updated:` line.
- `README.md`: the Status paragraph.
- `INTENT.md`: a changelog line for the release.
- `CHANGELOG.md`: rename the `[Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD`, and leave an empty `## [Unreleased]` heading above it.
`npm run build` regenerates `docs/index.html` and `docs/sitemap.xml` from these. Edit the build inputs for changes to those outputs.

## 2. Assistant guide rotation
`docs/.well-known/assistant-guide.txt` targets Level 4 provenance under profile 2.0.0. The served bytes, sidecar manifest, and DNS TXT record at `_assistant-guide.delegated.watch` must agree. The repository-root `assistant-guide.txt` is a byte-identical review copy.
- In the guide: raise `guide-version`, set `applies-to` to the new release range, set `last-reviewed`, and update every `exec-sha256` pin whose script changed (`scripts/check-runtime.js`, `scripts/demo-import.js`, `scripts/validate-data.js`).
- Run `npm run build` to regenerate the repository-root `assistant-guide.txt` from the rotated served guide.
- In `docs/.well-known/assistant-guide-manifest.txt`: set `guide-version`, `guide-sha256`, `guide-bytes`, `immutable-release-url`, `changelog-url`, and `released-at`.
- `tests/assistant-guide.test.js` checks the root copy, pins, and manifest against the guide's actual bytes.
- The DNS record is changed after the release pull request merges, never before: until the site serves the new guide, a new record value would not match it. Set a TTL of 3600 or less. Some DNS providers publish edits without changing the zone's SOA serial, so poll the record value on each authoritative nameserver, and allow up to an hour.
- Between the merge and DNS catching up, the provenance check sees a hash mismatch. Change the record immediately after the merge.

## 3. Inventory
Every edit to an inventoried file changes its pinned hash. After reviewing the diff, re-pin and confirm:
```bash
node scripts/verify-public-candidate.js --self --pin
npm run verify:candidate -- --self
```
A new file must also be added to the inventory, or the second command reports it as outside the inventory. The second command reports the comparison against a real aggregate dataset as not evaluated; that is expected for this repository, whose CI is offline. A comparison against a real record belongs to the release process of whoever holds that record, run as `--require-reference-data --reference-data PATH`, reporting only the verdict and the overlap count. When a rebase conflicts in `config/public-candidate.json`, keep both sides' list entries before re-pinning: re-pinning hashes only what is listed.

## 4. Gates
Run every step of `.github/workflows/ci.yml` locally before opening the pull request, and judge each by its own exit status, not by the last line of a pipeline:
```bash
npm run check:runtime
npm test
npm run validate
npm run eval -- --strict
npm run eval:code -- --strict
npm run build
npm run eval:dashboard -- --strict
npm run eval:served -- --strict
npm run export:csv
npm run demo:import
npm run verify:candidate -- --self
```
After `npm run build`, `git status` must show no change to a generated file. Then confirm a clean install of the release content works outside the checkout: unpack `git archive HEAD` into an empty directory, run `npm ci`, `npm run build`, and `npm test` there.

## 5. Release pull request
- `main` accepts changes only through a pull request whose `verify (24.x, ubuntu-latest)` and `verify (26.x, ubuntu-latest)` checks pass, with no bypass.
- A pull request showing zero checks has not been verified. Do not merge it.
- Merge, then change the DNS record (section 2).

## 6. Tag and GitHub Release
On the merge commit, after CI passes on `main`:
```bash
git tag -s vX.Y.Z -m vX.Y.Z
git push origin vX.Y.Z
```
Tags are SSH-signed and annotated. Create the GitHub Release titled with the bare version (`X.Y.Z`), with the CHANGELOG section as its notes followed by the generated pull request notes. The project publishes no npm package and attaches no release assets.

## 7. Verify
- The tag resolves to the merge commit, and CI on that commit is green.
- https://delegated.watch/ shows the new version. The root, `/demo/`, `/llms.txt`, `/sitemap.xml`, the assistant guide, and its manifest return 200; an unknown path returns 404.
- The live guide's SHA-256 equals the manifest's `guide-sha256`, the tagged review copy's SHA-256, and the DNS record value on every authoritative nameserver. The manifest byte count and canonical URL match the served artifact.
- Capture the hosted GuideCheck result for the released guide hash. Expect Level 3 with zero blocking findings. The hosted verifier caps results at Level 3 and reports declared anchors as unverified.
- Record the independent DNS and artifact comparisons as provenance evidence. Claim achieved Level 4 only with a conformant verifier report for the exact guide hash, including its qualifying anchor and findings.
