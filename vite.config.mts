import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** What the window may load. The packaged app gets the strict policy. */
const POLICY = [
  "default-src 'self'",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
];

/**
 * While developing, Vite injects styles and React's hot-reload code inline and talks to
 * the dev server over a WebSocket, so the policy is relaxed for that, and only that.
 */
const DEV_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
];

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    transformIndexHtml(html, context) {
      const policy = context.server ? DEV_POLICY : POLICY;
      return html.replace("%CONTENT_SECURITY_POLICY%", policy.join("; "));
    },
  };
}

// The window's code lives in renderer/; the main process is built separately by tsc.
export default defineConfig({
  root: "renderer",
  // Relative paths, so the built page also works when opened from the app bundle.
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    // Electron's Chromium is current, so nothing needs translating for older browsers.
    target: "esnext",
  },
  server: { port: 5173, strictPort: true },
});
