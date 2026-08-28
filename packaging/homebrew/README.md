# Homebrew packaging

Remuda ships via Homebrew, not a DMG (SPEC.md §10). This directory holds the
cask **template**; the cask itself has to live in a separate *tap* repo for
`brew install --cask magna-nz/tap/remuda` to work — Homebrew casks aren't
installed straight out of an arbitrary GitHub repo.

## The tap repo

The tap is `magna-nz/homebrew-tap` (Homebrew's naming convention: a tap named
`magna-nz/tap` resolves to a repo named `homebrew-tap` under the `magna-nz`
GitHub account). It already exists — it is the same tap
[forgetop](https://github.com/magna-nz/forgetop) publishes to, and the two
share it without conflicting:

```
homebrew-tap/
  Formula/forgetop.rb   # forgetop — a CLI binary, so a formula
  Casks/remuda.rb       # remuda  — a GUI .app, so a cask
```

Homebrew looks for formulae under `Formula/` and casks under `Casks/`, so
`brew install magna-nz/tap/forgetop` and
`brew install --cask magna-nz/tap/remuda` resolve independently. `tap` here
is short for `magna-nz/tap`, i.e. `homebrew-tap` with the `homebrew-` prefix
dropped, per Homebrew's tap-naming shorthand.

The release workflow creates `Casks/` on the first push if it isn't there
yet, so nothing needs setting up in the tap by hand.

Note that forgetop reaches the same tap by a completely different route: it
is a Rust CLI released with [cargo-dist](https://axodotdev.github.io/cargo-dist),
which generates its release workflow and renders the formula itself.
cargo-dist has no notion of a Tauri `.app` bundle or a cask, so remuda's
release pipeline is hand-written — see `.github/workflows/release.yml`. The
outcome is the same (push a tag, the tap updates); the machinery is not.

## Cutting a release

Versions live in five files and the release workflow refuses to build when
any of them disagrees with the tag — so bump them all first, in one commit:

- `src-tauri/tauri.conf.json` (`version`) — this is what stamps the .app
- `src-tauri/Cargo.toml` (`[package] version`)
- `src-tauri/Cargo.lock` (the `version` under `name = "remuda"`)
- `app/package.json` (`version`)
- `app/package-lock.json` (`version` *and* `.packages[""].version`)

The two lockfiles are easy to forget and the failure without the gate is
obscure: `npm ci` rejects a `package-lock.json` whose version disagrees with
`package.json`, and Cargo silently rewrites a stale `Cargo.lock` during the
build, so the tagged commit no longer reproduces the artifact. The gate
catches both before the build starts.

Then cut the tag, either way — the workflow triggers on the tag push, and
both routes end in one:

**From the terminal:**

```bash
git tag v0.2.0 && git push origin v0.2.0
```

**From the GitHub UI:** *Releases → Draft a new release →* type `v0.2.0`
into the tag box and pick **Create new tag: v0.2.0 on publish** → set the
target to `main` → write whatever notes you want → **Publish release**.

The UI route publishes an empty release first and the workflow fills it in
a few minutes later, so the release is briefly visible with no assets on
it. That's expected. Hand-written notes survive: the workflow's release
step sets `append_body: true`, so its checksum-and-cask note is appended
below whatever you typed rather than replacing it. (Without that flag the
action overwrites the body — which is why it's set.)

There's no "tag without releasing" button in the GitHub UI, so the terminal
route is the one that lets the workflow author the whole release.

Either way, `.github/workflows/release.yml` builds the app and publishes a
GitHub release on this repo (`magna-nz/remuda`) with three assets:

- `Remuda-<version>-aarch64.tar.gz` — the app bundle the cask points at
- `Remuda-<version>-aarch64.tar.gz.sha256` — its checksum
- `remuda.rb` — **the cask, already rendered** for this release: the
  `remuda.rb` template in this directory with `version` and `sha256`
  substituted, and the substitution asserted before the release publishes

The `url` line is parameterized on `#{version}` and never needs
hand-editing — it always resolves to this repo's release asset for that
version.

## Updating the tap

**Automatically** — if the `HOMEBREW_TAP_TOKEN` secret is set on this repo,
the release workflow pushes the rendered cask to
`magna-nz/homebrew-tap` as `Casks/remuda.rb` and commits it as
`remuda <version>`. This happens *after* the release publishes, so the
tap never points at an asset URL that doesn't exist yet.

To enable it: create a fine-grained PAT at
*github.com/settings/personal-access-tokens/new* with resource owner
`magna-nz`, repository access limited to `magna-nz/homebrew-tap`, and
**Contents: read and write**. Then add it to *this* repo (not the tap):

```bash
gh secret set HOMEBREW_TAP_TOKEN -R magna-nz/remuda
```

The built-in `GITHUB_TOKEN` can't do this — it's scoped to
`magna-nz/remuda` and cannot push to another repo. `magna-nz` is a user
account rather than an org, so there are no org-level secrets to share:
forgetop holds its own `HOMEBREW_TAP_TOKEN` secret with the same name, and
the two are separate tokens. When one expires the other keeps working, and
the symptom is a failed *Push the cask to the tap repo* step on an
otherwise successful release.

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

## Install

```bash
brew install --cask magna-nz/tap/remuda
```

## Current limits

- **Unsigned.** No Apple Developer ID yet, so Gatekeeper quarantines the
  app. The cask works around this with a `postflight` block that clears the
  quarantine attribute on install — without it macOS reports the app as
  "damaged", and on macOS 15+ the right-click → Open escape hatch no longer
  exists. Signing and notarizing is the real fix; see the TODO in
  `.github/workflows/release.yml`.
- **Apple Silicon (aarch64) only.** The release workflow builds on a
  macos-14 (arm64) runner and doesn't yet produce an x86_64 or universal
  binary; the cask restricts itself to `arch: :arm64` to match. Widening
  that is a follow-up, not yet scheduled.
