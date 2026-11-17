/**
 * The window's entry point: Vite starts here and follows the imports.
 *
 * The interface is moving to React one area at a time. Areas already moved live in
 * src/components, each with its own CSS Module; the rest is still the original code in
 * src/legacy, styled by the shared stylesheets in src/styles.
 */
// Shared stylesheets first, in cascade order: later files win over earlier ones.
// Components' own CSS Modules load after these, with the components.
import "./styles/base.css";
import "./styles/ruler.css";
import "./styles/views.css";
import "./styles/talk.css";
import "./styles/stage.css";
import "./styles/board.css";
import "./styles/conversation.css";
import "./styles/controls.css";
import "./styles/rows.css";
import "./styles/voice.css";

// The original interface code. app.js uses the other three, so it comes last.
import "./legacy/dragon.js";
import "./legacy/forge.js";
import "./legacy/hearing.js";
import "./legacy/app.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Dock } from "./components/Dock/Dock";

createRoot(document.getElementById("dock-root")!).render(
  <StrictMode>
    <Dock />
  </StrictMode>,
);
