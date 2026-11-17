import { execFile } from "child_process";
import { app } from "electron";
import path from "path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(file: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let code = 0;
      if (error) {
        // The process's exit code, or 1 when it failed without one (not found, timed out, killed).
        const exitCode = (error as { code?: unknown }).code;
        code = typeof exitCode === "number" ? exitCode : 1;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/** Run AppleScript with arguments passed out-of-band, so nothing is interpolated. */
export async function appleScript(script: string, args: string[] = [], timeoutMs = 30_000): Promise<string> {
  const result = await run("/usr/bin/osascript", ["-e", script, ...args], timeoutMs);
  if (result.code !== 0) throw new Error(explainAutomationError(result.stderr));
  return result.stdout.trim();
}

function explainAutomationError(stderr: string): string {
  if (stderr.includes("-1743") || stderr.includes("Not authorized")) {
    return "macOS blocked DesktopJarvis from controlling that app. Allow it in System Settings › Privacy & Security › Automation, then try again.";
  }
  if (stderr.includes("-1728") || stderr.includes("-1719")) {
    return `The app could not find what was asked for. ${stderr.trim()}`;
  }
  if (stderr.includes("-600") || stderr.includes("-10810")) {
    return "That app is not running or could not be started.";
  }
  return stderr.trim() || "The script failed without an error message";
}

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "theo-events")
    : path.join(app.getAppPath(), "native", "bin", "theo-events");
}

/** Call the EventKit helper (Calendar and Reminders). Throws on {"error": …}. */
export async function eventKit<T>(command: string, input: Record<string, unknown> = {}): Promise<T> {
  // Access prompts block until the person answers, so allow a long wait.
  const result = await run(helperPath(), [command, JSON.stringify(input)], 120_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr.trim() || "The calendar helper did not return a result");
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return parsed as T;
}

export function toEpoch(value: unknown, field: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a date and time such as 2026-03-04T17:00`);
  }
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`${field} is not a date and time DesktopJarvis can read: ${value}`);
  }
  return ms / 1000;
}

export function fromEpoch(seconds: unknown, allDay = false): string | null {
  if (typeof seconds !== "number") return null;
  const date = new Date(seconds * 1000);
  return allDay
    ? date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : date.toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
