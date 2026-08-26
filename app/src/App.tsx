import "./App.css";
import { ChatView } from "./chat/ChatView";
import { EditorView } from "./editor/EditorView";
import { ReloadToast } from "./editor/ReloadToast";
import { ViewTabs } from "./editor/ViewTabs";
import { LoadPane } from "./ui/LoadPane";
import { OfflineBanner } from "./ui/OfflineBanner";
import { RemudaProvider, useRemuda } from "./ui/state";
import { Settings } from "./ui/Settings";
import { Sidebar } from "./ui/Sidebar";
import { TopNav } from "./ui/TopNav";
import { PullView } from "./pull/PullView";

function MainPanel() {
  const { view } = useRemuda();
  if (view === "settings") return <Settings />;
  if (view === "pull") return <PullView />;
  if (view === "modelfile") return <EditorView />;
  return <ChatView />;
}

function Shell() {
  const { view } = useRemuda();
  // SPEC §5: the chats sidebar is visible for Chat and Modelfile (they share
  // the window) and hidden on the full-width global surfaces, Pull and
  // Settings.
  const showSidebar = view !== "pull" && view !== "settings";

  return (
    <div className="app">
      <TopNav />
      <OfflineBanner />
      <div className="body">
        {showSidebar && <Sidebar />}
        <main className="main">
          <ViewTabs />
          <div className="viewbody">
            <MainPanel />
          </div>
        </main>
      </div>
      <LoadPane />
      <ReloadToast />
    </div>
  );
}

/**
 * App shell (SPEC.md §4, §5): global top nav with the model control, the
 * chats sidebar, the chat/Modelfile/Pull/Settings surface in the main area,
 * and the load-pane popover.
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
