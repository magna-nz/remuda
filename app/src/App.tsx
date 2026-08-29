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
import { ToolsView } from "./tools/ToolsView";
import { BenchmarkPane } from "./benchmark/BenchmarkPane";
import { FirstRunOffer } from "./tour/FirstRunOffer";
import { Tour } from "./tour/Tour";

function MainPanel() {
  const { view } = useRemuda();
  if (view === "settings") return <Settings />;
  if (view === "pull") return <PullView />;
  if (view === "modelfile") return <EditorView />;
  if (view === "tools") return <ToolsView />;
  if (view === "benchmark") return <BenchmarkPane />;
  return <ChatView />;
}

function Shell() {
  // SPEC §5: the chats sidebar is a persistent rail — it stays visible for
  // every surface, so Pull and Settings open in the main area beside it
  // rather than taking over the window.
  return (
    <div className="app">
      <TopNav />
      <OfflineBanner />
      {/* R6: the tour is offered in the shell's flow, above the body — a
          card the user can ignore, never a modal in front of the app. */}
      <FirstRunOffer />
      <div className="body">
        <Sidebar />
        <main className="main">
          <ViewTabs />
          <div className="viewbody">
            <MainPanel />
          </div>
        </main>
      </div>
      <LoadPane />
      <ReloadToast />
      <Tour />
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
