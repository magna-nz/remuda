cask "remuda" do
  version "0.1.0"
  sha256 "REPLACE_ON_RELEASE"

  url "https://github.com/magna-nz/remuda/releases/download/v#{version}/Remuda-#{version}-aarch64.tar.gz"
  name "Remuda"
  desc "Desktop app for tuning and testing local Ollama models"
  homepage "https://github.com/magna-nz/remuda"

  # The release build is aarch64-only (Apple Silicon) for now — see the
  # follow-up note in .github/workflows/release.yml. Restrict the cask to
  # arm64 until an x86_64/universal build exists, rather than silently
  # offering an Intel Mac an artifact that won't run there.
  depends_on macos: :monterey
  depends_on arch: :arm64

  app "Remuda.app"

  # The release build is unsigned and un-notarized (see the signing TODO in
  # .github/workflows/release.yml), so Gatekeeper quarantines it and macOS
  # refuses to launch it — "Remuda.app is damaged and can't be opened".
  #
  # Stripping the quarantine attribute here rather than in `caveats` is
  # deliberate. Caveats print *after* the install, so a user only reads the
  # fix once the app has already failed to open; and on macOS 15+ the old
  # right-click -> Open escape hatch is gone, leaving a detour through
  # System Settings -> Privacy & Security as the only manual recovery.
  #
  # homebrew/cask proper forbids this — a tap it doesn't audit is exactly
  # where it's appropriate. Remove this block once the build is signed and
  # notarized, at which point there is no quarantine flag to clear.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Remuda.app"],
                   sudo: false
  end

  caveats <<~EOS
    Remuda talks to a local Ollama install — it does not bundle or run
    inference itself. If you don't have Ollama yet:
      brew install ollama
      ollama serve

    This build is unsigned. The cask clears the Gatekeeper quarantine flag
    for you on install, so it should just open. If macOS still refuses:
      xattr -dr com.apple.quarantine /Applications/Remuda.app
  EOS
end
