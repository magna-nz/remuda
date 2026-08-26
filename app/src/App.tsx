import "./App.css";
import { LoadPane } from "./ui/LoadPane";
import { OfflineBanner } from "./ui/OfflineBanner";
import { RemudaProvider, useRemuda } from "./ui/state";
import { Settings } from "./ui/Settings";
import { Sidebar } from "./ui/Sidebar";
import { TopNav } from "./ui/TopNav";

/**
 * M1 is read-only + load: there's no chat surface yet (that's M2), so the
 * main area is the mockup's empty state pointing at the model control.
 */
function ChatPlaceholder() {
  return (
    <div className="chat-empty">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <b>Load a model, then start a chat</b>
    </div>
  );
}

function Shell() {
  const { view } = useRemuda();

  return (
    <div className="app">
      <TopNav />
      <OfflineBanner />
      <div className="body">
        <Sidebar />
        <main className="main">{view === "settings" ? <Settings /> : <ChatPlaceholder />}</main>
      </div>
      <LoadPane />
    </div>
  );
}

/**
 * App shell (SPEC.md §4, §5): global top nav with the model control, the
 * chats sidebar, the main area, and the load-pane popover. Later waves
 * (M2+) fill in chat, the Modelfile editor, and Pull.
 *
 * `client` is injected by tests (a FakeClient); production passes nothing
 * and the provider constructs the real Ollama client.
 */
function App({ client }: { client?: import("./api/types").OllamaClient }) {
  return (
    <RemudaProvider client={client}>
      <Shell />
    </RemudaProvider>
  );
}

export default App;
