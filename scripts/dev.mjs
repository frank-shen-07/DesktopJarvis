// `npm run dev`: start Vite's dev server for the window, then open Electron pointed at it.
// Saving a file in renderer/ updates the window straight away. Changes in src/ (the main
// process) need a restart.
import { spawn } from "child_process";
import electron from "electron";
import { createServer } from "vite";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];

const env = { ...process.env, VITE_DEV_SERVER_URL: url };
// Set by some terminals and tools; Electron would start as plain Node with it.
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(electron, ["."], { stdio: "inherit", env });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
