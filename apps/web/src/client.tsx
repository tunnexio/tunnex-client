import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../../../packages/shared/generated/tokens.css";
import "./index.css";
import { ClientApp } from "./client/ClientApp";

// ⛔ THE DESKTOP CLIENT'S OWN ENTRY POINT — no router, no AppShell, no pages.
//
// The client used to load the web SPA's index.html, which meant it mounted the router, the
// sidebar, the top bar and every dashboard screen, then hid most of it behind `isDesktop()`
// branches. That is the makeshift this replaces: the client is not a small dashboard, and the
// wireframe's own block agrees — it specifies ONE window with four regions and nothing else.
//
// Fonts and design tokens are shared; components are its own.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientApp />
  </StrictMode>,
);
