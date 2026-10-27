import "@fontsource-variable/inter";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/toast";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// One page-load time per visit, for the "under 3 seconds on 3G/4G" target (PRD 2). No personal data.
window.addEventListener("load", () =>
  setTimeout(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const ms = Math.round(nav?.loadEventEnd || performance.now());
    if (!ms || ms > 120_000) return;
    const connection = (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType;
    const body = JSON.stringify({ path: location.pathname.split("/").slice(0, 2).join("/") || "/", ms, connection });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/metrics/load", new Blob([body], { type: "text/plain" }));
  }, 0),
);
