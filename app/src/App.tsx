import "./App.css";

/**
 * Minimal app shell: top bar (brand + model control placeholder), an empty
 * chats sidebar, and an empty main area. Styled with the Embigo tokens from
 * index.css. Later waves fill in the load pane, chat, Modelfile editor,
 * pull, and settings surfaces (see SPEC.md §5).
 */
function App() {
  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <b>Remuda</b>
        </div>
        <div className="divider" />
        <button className="modelctl" type="button" title="Choose and load a model">
          <span className="dot" aria-hidden="true" />
          <span className="modelctl-text">No model loaded</span>
        </button>
        <div className="spacer" />
        <div className="conn">
          <span className="dot" aria-hidden="true" />
          <span>Connecting…</span>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar" aria-label="Chats" />
        <main className="main" />
      </div>
    </div>
  );
}

export default App;
