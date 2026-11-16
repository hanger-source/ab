import { execFile } from "node:child_process";
import { get } from "node:http";
import { promisify } from "node:util";
import { ABError } from "../errors/index.js";
import type { OperationOptions } from "../options.js";
import type { ResolvedBrowserProvider } from "./provider.js";

const exec = promisify(execFile);
const stage = "sdk.chrome.discover";
const enableDebugging = "Open chrome://inspect/#remote-debugging in your existing Chrome and enable remote debugging, then connect again. AB will not start another Chrome.";

/** Resolves the current user's regular Google Chrome, excluding AB/custom profiles. */
export async function discoverUserChrome(options: OperationOptions = {}): Promise<ResolvedBrowserProvider> {
  if (process.platform !== "darwin") {
    throw failure("user_chrome_unsupported", "Automatic user Chrome connection currently supports macOS.");
  }
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  async function run(file: string, args: string[], allowEmpty = false): Promise<string> {
    options.signal?.throwIfAborted();
    try {
      const { stdout } = await exec(file, args, {
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return stdout;
    } catch (error) {
      options.signal?.throwIfAborted();
      // lsof reports no matching descriptors with exit status 1 and empty output.
      const result = error as { code?: unknown; stdout?: string; stderr?: string };
      if (allowEmpty && result.code === 1 && !result.stdout && !result.stderr) return "";
      throw failure("user_chrome_discovery_failed", `Cannot inspect running Chrome with ${file}. Check that this host permits local process inspection.`);
    }
  }

  const processes = await run("/bin/ps", ["-axo", "pid=,uid=,comm="]);
  const candidates: number[] = [];
  for (const line of processes.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== process.getuid?.()
      || !match[3]?.endsWith("/Google Chrome.app/Contents/MacOS/Google Chrome")) continue;
    const pid = Number(match[1]);
    const command = await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]);
    if (!/(?:^|\s)--user-data-dir(?:=|\s)/.test(command)) candidates.push(pid);
  }
  if (candidates.length === 0) {
    throw failure("user_chrome_not_running", "Your regular Google Chrome is not running. Open it yourself, then connect again. AB-managed and custom-profile browsers are not selected.");
  }
  if (candidates.length !== 1) {
    throw failure("user_chrome_ambiguous", "More than one regular Google Chrome process is running. Keep the intended Chrome instance open and close the other instance before connecting.");
  }
  const pid = candidates[0]!;
  const listeners = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], true);
  const addresses = [...new Set(listeners.split("\n")
    .filter((line) => /^n(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line))
    .map((line) => line.slice(1)))];
  if (addresses.length === 0) throw failure("user_chrome_debugging_disabled", enableDebugging);
  // One port may have both IPv4 and IPv6 sockets; they identify one server.
  const ports = new Set(addresses.map((address) => address.slice(address.lastIndexOf(":") + 1)));
  if (ports.size !== 1) {
    throw failure("user_chrome_ambiguous", "Chrome has multiple local listening ports, so AB cannot identify one debugging server safely. Check chrome://inspect/#remote-debugging in the intended Chrome.");
  }
  const address = addresses.find((value) => value.startsWith("127.0.0.1:")) ?? addresses[0]!;
  const webSocketUrl = await discoverEndpoint(address, Math.max(1, deadline - Date.now()), options.signal);
  // Process identity and its listening socket are checked before any connection request.
  console.error(`[ab.chrome] source=user pid=${pid} mode=${new URL(webSocketUrl).pathname === "/devtools/browser" ? "approval" : "remote-debugging"}`);
  return { kind: "external", webSocketUrl };
}

function discoverEndpoint(address: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(`http://${address}/json/version`, {
      agent: false,
      ...(signal ? { signal } : {}),
    }, (response) => {
      // Chrome's approval-only server deliberately hides all /json endpoints.
      // Its browser endpoint has no GUID; the WebSocket upgrade asks for consent.
      if (response.statusCode === 404) {
        response.resume();
        resolve(`ws://${address}/devtools/browser`);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(failure("user_chrome_discovery_failed", `Chrome debugging discovery returned HTTP ${response.statusCode}. ${enableDebugging}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy(new Error("Chrome version response is too large"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
          if (typeof value.webSocketDebuggerUrl !== "string") throw new Error("missing browser endpoint");
          const endpoint = new URL(value.webSocketDebuggerUrl);
          const local = new URL(`ws://${address}`);
          if (endpoint.protocol !== "ws:" || endpoint.port !== local.port
            || ![local.hostname, "localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
            || !endpoint.pathname.startsWith("/devtools/browser/")) throw new Error("invalid browser endpoint");
          // Keep the address whose listener was actually attributed to Chrome.
          resolve(`ws://${address}${endpoint.pathname}`);
        } catch {
          reject(failure("user_chrome_discovery_failed", `Chrome did not expose a valid browser debugging endpoint. ${enableDebugging}`));
        }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Chrome discovery timed out")), timeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => reject(signal?.aborted ? signal.reason
      : failure("user_chrome_discovery_failed", `Cannot reach Chrome's local debugging server: ${error.message}. ${enableDebugging}`)));
  });
}

function failure(kind: string, message: string): ABError {
  return new ABError({ kind, stage, message });
}

/** Keeps known consent failures actionable without hiding unrelated runtime errors. */
export function userChromeConnectionError(error: unknown): unknown {
  if (!(error instanceof ABError)) return error;
  if (error.stage === "session.connect" && /403 Forbidden/.test(error.message)) {
    return new ABError({ kind: "user_chrome_permission_denied", stage: "sdk.chrome.connect",
      message: "Chrome rejected the debugging connection. Allow the connection in Chrome when you choose to connect again.", details: error });
  }
  if (error.kind === "daemon_start_timeout" || (error.kind === "timeout" && error.stage === "handshake.wait")) {
    return new ABError({ kind: "user_chrome_connection_timeout", stage: "sdk.chrome.connect",
      message: "Chrome connection did not complete before the deadline. Check Chrome for an 'Allow remote debugging?' prompt and allow this connection; do not repeatedly reconnect while a prompt is pending.", details: error });
  }
  return error;
}
