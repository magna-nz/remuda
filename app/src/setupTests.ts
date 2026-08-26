import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Several suites drive real timers — the provider's health poll, and the
// Pull pane's 350ms probe debounce. Testing Library's 1s default leaves
// little headroom for those on a loaded machine, where a slow tick turns a
// correct assertion into a spurious failure. The timeout only bounds how
// long a *failing* wait takes; passing assertions still resolve immediately.
configure({ asyncUtilTimeout: 5000 });
