// M0 shell: sidebar + canvas layout only. The real expression list arrives in
// M2. Keep src/core/ imports flowing through a thin adapter layer once UI
// work starts — core stays DOM-free.

export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-placeholder">Expressions (M2)</div>
      </aside>
      <main className="canvas-area">
        <div className="canvas-placeholder">Graph canvas (M2)</div>
      </main>
    </div>
  );
}
