import "./App.css";
import { ChatView } from "./chat/ChatView";
import { LoadPane } from "./ui/LoadPane";
import { OfflineBanner } from "./ui/OfflineBanner";
import { RemudaProvider, useRemuda } from "./ui/state";
import { Settings } from "./ui/Settings";
import { Sidebar } from "./ui/Sidebar";
import { TopNav } from "./ui/TopNav";

function Shell() {
  const { view } = useRemuda();

  return (
    <div className="app">
      <TopNav />
      <OfflineBanner />
      <div className="body">
        <Sidebar />
        <main className="main">{view === "settings" ? <Settings /> : <ChatView />}</main>
      </div>
      <LoadPane />
    </div>
  );
}

/**
 * App shell (SPEC.md §4, §5): global top nav with the model control, the
 * chats sidebar, the chat surface in the main area, and the load-pane
 * popover. Later waves (M3+) fill in the Modelfile editor and Pull.
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
