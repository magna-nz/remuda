import { afterEach, describe, expect, it, vi } from "vitest";

import { hostStats, isHostAvailable, openExternal, startOllama } from "./host";

/**
 * Stand in for the Tauri bridge that `withGlobalTauri` injects. Returns the
 * spy so a test can assert what the frontend actually asked for.
 */
function stubBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("hostStats", () => {
  it("resolves to null with no bridge, so the UI renders without telemetry", async () => {
    expect(isHostAvailable()).toBe(false);
    await expect(hostStats()).resolves.toBeNull();
  });

  it("passes the camelCase wire struct straight through", async () => {
    const invoke = stubBridge(async () => ({
      memTotalBytes: 34_359_738_368,
      memUsedBytes: 21_000_000_000,
      ollamaCpuPercent: 12.5,
      gpuPercent: null,
    }));

    await expect(hostStats()).resolves.toEqual({
      memTotalBytes: 34_359_738_368,
      memUsedBytes: 21_000_000_000,
      ollamaCpuPercent: 12.5,
      gpuPercent: null,
    });
    expect(invoke).toHaveBeenCalledWith("host_stats");
  });

  it("preserves a real zero CPU reading rather than flattening it to null", async () => {
    // 0 is a genuine answer from an idle server; null means "unknown". The
    // bridge must not conflate them, because the UI branches on it.
    stubBridge(async () => ({
      memTotalBytes: 8,
      memUsedBytes: 4,
      ollamaCpuPercent: 0,
      gpuPercent: null,
    }));

    const stats = await hostStats();
    expect(stats?.ollamaCpuPercent).toBe(0);
  });

  it("turns an Err from Rust into a rejection carrying its text", async () => {
    stubBridge(async () => {
      throw "sysinfo refresh failed";
    });

    await expect(hostStats()).rejects.toThrow("sysinfo refresh failed");
  });
});

describe("startOllama", () => {
  it("invokes the command and resolves", async () => {
    const invoke = stubBridge(async () => null);

    await expect(startOllama()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("start_ollama");
  });

  it("surfaces the spawn error verbatim — that is how the user learns it is not on PATH", async () => {
    stubBridge(async () => {
      throw "No such file or directory (os error 2)";
    });

    await expect(startOllama()).rejects.toThrow("No such file or directory (os error 2)");
  });

  it("rejects rather than silently doing nothing when there is no bridge", async () => {
    await expect(startOllama()).rejects.toThrow(/desktop app/);
  });
});

describe("openExternal", () => {
  it("hands http and https to the opener plugin", async () => {
    const invoke = stubBridge(async () => null);

    await openExternal("https://ollama.com/library");
    await openExternal("http://localhost:11434/");

    expect(invoke).toHaveBeenNthCalledWith(1, "plugin:opener|open_url", {
      url: "https://ollama.com/library",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin:opener|open_url", {
      url: "http://localhost:11434/",
    });
  });

  it("refuses any other scheme, and never reaches the bridge", async () => {
    const invoke = stubBridge(async () => null);

    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:someone@example.com",
      "tel:+64211234567",
      "vscode://file/etc/passwd",
    ]) {
      await expect(openExternal(url)).rejects.toThrow(/refusing to open/);
    }

    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a scheme-less string", async () => {
    const invoke = stubBridge(async () => null);

    for (const url of ["ollama.com", "/library", "", "   "]) {
      await expect(openExternal(url)).rejects.toThrow(/not an absolute URL/);
    }

    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates before it needs a bridge, so the check holds in a browser too", async () => {
    await expect(openExternal("javascript:alert(1)")).rejects.toThrow(/refusing to open/);
    await expect(openExternal("https://ollama.com")).rejects.toThrow(/desktop app/);
  });

  it("surfaces an Err from the plugin as a rejection", async () => {
    stubBridge(async () => {
      throw "url not allowed on the configured scope: https://ollama.com/";
    });

    await expect(openExternal("https://ollama.com/")).rejects.toThrow(/not allowed on the configured scope/);
  });
});
