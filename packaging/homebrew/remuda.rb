cask "remuda" do
  version "0.1.0"
  sha256 "REPLACE_ON_RELEASE"

  url "https://github.com/magna-nz/remuda/releases/download/v#{version}/Remuda-#{version}-aarch64.tar.gz"
  name "Remuda"
  desc "Chat-first desktop UI for Ollama"
  homepage "https://github.com/magna-nz/remuda"

  # The release build is aarch64-only (Apple Silicon) for now — see the
  # follow-up note in .github/workflows/release.yml. Restrict the cask to
  # arm64 until an x86_64/universal build exists, rather than silently
  # offering an Intel Mac an artifact that won't run there.
  depends_on macos: ">= :monterey"
  depends_on arch: :arm64

  app "Remuda.app"

  caveats <<~EOS
    Remuda talks to a local Ollama install — it does not bundle or run
    inference itself. If you don't have Ollama yet:
      brew install ollama
      ollama serve

    This build is unsigned (no Apple Developer ID yet — see the signing
    TODO in .github/workflows/release.yml). macOS Gatekeeper will refuse to
    open it until you clear the quarantine attribute once, after install:
      xattr -dr com.apple.quarantine /Applications/Remuda.app
  EOS
end
