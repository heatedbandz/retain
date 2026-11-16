"use client";

import { useEffect } from "react";
import { getSupabase } from "@/lib/supabase";

const TABS = [
  ["today", "Today"],
  ["tutor", "Tutor"],
  ["tasks", "Tasks"],
  ["learn", "Learn"],
  ["notebook", "Notebook"],
  ["me", "Me"]
] as const;

// The app itself is plain DOM code in lib/app.js; this component renders its shell and starts it.
export default function RetainApp() {
  useEffect(() => {
    let cancelled = false;
    import("@/lib/app.js").then(m => {
      if (!cancelled) m.start({ supabase: getSupabase() });
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><span></span></span>Retain
          </div>
          <span className="sync cloud" id="sync" hidden><i></i><span>Saved to your account</span></span>
          <nav className="tabs" id="tabs" hidden>
            {TABS.map(([id, label]) => (
              <button key={id} className="tab" data-act="tab" data-tab={id}>{label}</button>
            ))}
          </nav>
        </div>
      </header>
      <main id="view"><p className="muted">Opening your notebook…</p></main>
      <div id="sheet"></div>
      <div id="focus" className="focus" hidden></div>
      <div id="toast" className="toast" hidden role="status"></div>
    </>
  );
}
