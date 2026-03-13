import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

export type BridgeResponse<T> = {
  ok: true;
  value: T;
};

export type BridgeFailure = {
  ok: false;
  kind: "transport" | "remote";
  message: string;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class BridgeClient {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(options?: { socketPath?: string; timeoutMs?: number }) {
    this.socketPath = options?.socketPath ?? defaultBridgeSocketPath();
    this.timeoutMs = options?.timeoutMs ?? Number(process.env.BCAL_MCP_BRIDGE_TIMEOUT_MS ?? 5_000);
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.call("workspace.info", {});
    return response.ok;
  }

  async call<T>(method: string, params?: unknown): Promise<BridgeResponse<T> | BridgeFailure> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const requestId = Date.now();

      const finalize = (value: BridgeResponse<T> | BridgeFailure) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      const timeout = setTimeout(() => {
        finalize({ ok: false, kind: "transport", message: `Bridge request timed out for method ${method}.` });
      }, this.timeoutMs);

      socket.on("connect", () => {
        const payload: JsonRpcRequest = {
          jsonrpc: "2.0",
          id: requestId,
          method,
          params,
        };
        socket.write(`${JSON.stringify(payload)}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let response: JsonRpcResponse;
          try {
            response = JSON.parse(line) as JsonRpcResponse;
          } catch {
            continue;
          }

          if (response.id !== requestId) {
            continue;
          }

          clearTimeout(timeout);
          if (response.error) {
            finalize({ ok: false, kind: "remote", message: response.error.message });
            return;
          }

          finalize({ ok: true, value: response.result as T });
          return;
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        finalize({ ok: false, kind: "transport", message: error.message });
      });

      socket.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }
}

export function defaultBridgeSocketPath(): string {
  if (process.platform === "win32") {
    return String.raw`\\.\pipe\bcal-mcp-bridge-v1`;
  }

  return process.env.BCAL_MCP_BRIDGE_SOCKET ?? path.join(tmpdir(), "bcal-mcp-bridge-v1.sock");
}
