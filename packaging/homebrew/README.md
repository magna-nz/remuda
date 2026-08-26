# Homebrew packaging

Remuda ships via Homebrew, not a DMG (SPEC.md §10). This directory holds the
cask **template**; the cask itself has to live in a separate *tap* repo for
`brew install --cask magna-nz/tap/remuda` to work — Homebrew casks aren't
installed straight out of an arbitrary GitHub repo.

## The tap repo

The tap is `magna-nz/homebrew-tap` (Homebrew's naming convention: a tap named
`magna-nz/tap` resolves to a repo named `homebrew-tap` under the `magna-nz`
GitHub account/org). **It doesn't exist yet** — create it at the first
release:

1. Create an empty GitHub repo `magna-nz/homebrew-tap`.
2. Add a `Casks/remuda.rb` file (Homebrew's expected path for a cask in a
   tap) with the contents of `remuda.rb` in this directory, filled in per
   the release you're publishing (see below).
3. Commit and push.

After that, `brew install --cask magna-nz/tap/remuda` works: `tap` here is
short for `magna-nz/tap`, i.e. `homebrew-tap` with the `homebrew-` prefix
dropped, per Homebrew's tap-naming shorthand.

## Cutting a release

Versions live in three files and the release workflow refuses to build when
any of them disagrees with the tag — so bump them first, in one commit:

- `src-tauri/tauri.conf.json` (`version`) — this is what stamps the .app
- `src-tauri/Cargo.toml` (`[package] version`)
- `app/package.json` (`version`)

Then tag and push:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds the app and publishes a GitHub
release on this repo (`magna-nz/remuda`) with three assets:

- `Remuda-<version>-aarch64.tar.gz` — the app bundle the cask points at
- `Remuda-<version>-aarch64.tar.gz.sha256` — its checksum
- `remuda.rb` — **the cask, already rendered** for this release: the
  `remuda.rb` template in this directory with `version` and `sha256`
  substituted, and the substitution asserted before the release publishes

The `url` line is parameterized on `#{version}` and never needs
hand-editing — it always resolves to this repo's release asset for that
version.

## Updating the tap

**Automatically** — if the `TAP_GITHUB_TOKEN` secret is set on this repo,
the release workflow pushes the rendered cask to
`magna-nz/homebrew-tap` as `Casks/remuda.rb` and commits it as
`remuda <version>`. This happens *after* the release publishes, so the
tap never points at an asset URL that doesn't exist yet.

To enable it: create a fine-grained PAT with **Contents: read and write**
on `magna-nz/homebrew-tap` only, and add it to this repo under
*Settings → Secrets and variables → Actions* as `TAP_GITHUB_TOKEN`. The
built-in `GITHUB_TOKEN` can't do this — it's scoped to `magna-nz/remuda`
and cannot push to another repo.

**By hand** — without that secret the workflow skips the push and logs a
notice. Download the `remuda.rb` asset from the release and commit it to
the tap repo as `Casks/remuda.rb`. No editing required; it is already
filled in.

## Download counts

Homebrew's own analytics only cover casks in the official `homebrew/cask`
tap, so a third-party tap like `magna-nz/tap` reports nothing there. The
number to watch instead is GitHub release-asset downloads — which *does*
include Homebrew installs, because the cask fetches the tarball straight
from the release URL. The README carries a badge for the total; for exact
per-asset figures:

```bash
gh api repos/magna-nz/remuda/releases \
  --jq '.[] | .tag_name as $t | .assets[] | "\($t)  \(.name)  \(.download_count)"'
```

## Install (once the tap exists)

```bash
brew install --cask magna-nz/tap/remuda
```

## Current limits

- **Unsigned.** No Apple Developer ID yet, so Gatekeeper blocks the app
  until the user manually clears quarantine (the cask's `caveats` block
  explains this). See the signing TODO in
  `.github/workflows/release.yml`.
- **Apple Silicon (aarch64) only.** The release workflow builds on a
  macos-14 (arm64) runner and doesn't yet produce an x86_64 or universal
  binary; the cask restricts itself to `arch: :arm64` to match. Widening
  that is a follow-up, not yet scheduled.
