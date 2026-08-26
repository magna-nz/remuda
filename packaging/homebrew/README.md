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

## Updating the cask for a release

`.github/workflows/release.yml` builds the app and publishes a GitHub
release on this repo (`magna-nz/remuda`) when a `v*` tag is pushed, with a
`Remuda-<version>-aarch64.tar.gz` asset and a `.sha256` file alongside it.
The cask in the tap repo needs to be updated by hand to point at each new
release:

1. Wait for the release workflow to finish and find the published release
   for the tag (e.g. `v0.1.0`).
2. Copy the SHA-256 from the release body, or the `.sha256` asset it
   uploaded.
3. In the tap repo's `Casks/remuda.rb` (copied from `remuda.rb` here), set:
   - `version` to the tag without its `v` prefix (e.g. `"0.1.0"`).
   - `sha256` to the value from step 2, replacing the
     `"REPLACE_ON_RELEASE"` placeholder.
4. Commit and push to the tap repo.

The `url` line is already parameterized on `#{version}` and doesn't need
hand-editing per release — it always resolves to this repo's release asset
for that version.

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
