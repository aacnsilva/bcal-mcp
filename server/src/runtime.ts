import path from "node:path";
import { buildProject, detectAlTool } from "./alTool.ts";
import { BridgeClient } from "./bridge.ts";
import {
  filterObjectCatalog,
  readLaunchProfiles,
  readManifest,
  resolveWorkspacePath,
  scanObjectCatalog,
} from "./project.ts";

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type ToolResult = {
  status: "success" | "error";
  summary: string;
  details: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  errorCategory?: string;
  cancelToken?: string;
};

type ServerOptions = {
  defaultWorkspacePath?: string;
  bridgeClient?: BridgeClient;
  env?: NodeJS.ProcessEnv;
  sendNotification?: (method: string, params: Record<string, unknown>) => void;
};

const TOOL_DEFINITIONS = [
  {
    name: "bc_project_info",
    description: "Read app.json, workspace metadata, and available launch profiles.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
      },
    },
  },
  {
    name: "bc_diagnostics",
    description: "Return structured AL diagnostics for a workspace or file through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        filePath: { type: "string" },
      },
    },
  },
  {
    name: "bc_symbols_refresh",
    description: "Refresh Business Central symbols through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
      },
    },
  },
  {
    name: "bc_symbols_search",
    description: "Search objects and symbols through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        query: { type: "string" },
        objectType: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "bc_object_inspect",
    description: "Inspect a Business Central AL object through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        objectType: { type: "string" },
        objectId: { type: "number" },
        objectName: { type: "string" },
      },
    },
  },
  {
    name: "bc_references_find",
    description: "Find references through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        filePath: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        query: { type: "string" },
      },
    },
  },
  {
    name: "bc_build",
    description: "Compile/package an AL workspace with ALTool.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        outputPath: { type: "string" },
        target: { type: "string" },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "bc_publish",
    description: "Publish an AL workspace through the VS Code bridge using an existing launch profile.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        launchProfile: { type: "string" },
        dependencyPublishingOrder: { type: "array", items: { type: "string" } },
      },
      required: ["workspacePath", "launchProfile"],
    },
  },
];

const RESOURCE_DEFINITIONS = [
  { uri: "bc://workspace/manifest", name: "Workspace manifest", mimeType: "application/json" },
  { uri: "bc://workspace/launch-profiles", name: "Workspace launch profiles", mimeType: "application/json" },
  { uri: "bc://workspace/object-catalog", name: "Workspace object catalog", mimeType: "application/json" },
];

export function createBcalServer(options: ServerOptions = {}) {
  const bridgeClient = options.bridgeClient ?? new BridgeClient();
  const env = options.env ?? process.env;
  const defaultWorkspacePath = path.resolve(options.defaultWorkspacePath ?? process.cwd());

  async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    try {
      switch (request.method) {
        case "initialize":
          return success(request.id, await initializeResult(defaultWorkspacePath, bridgeClient, env));
        case "ping":
          return success(request.id, { ok: true });
        case "tools/list":
          return success(request.id, { tools: TOOL_DEFINITIONS });
        case "tools/call":
          return success(request.id, await handleToolCall(request.params ?? {}, defaultWorkspacePath, bridgeClient, env, options.sendNotification));
        case "resources/list":
          return success(request.id, { resources: RESOURCE_DEFINITIONS });
        case "resources/read":
          return success(request.id, await handleResourceRead(request.params ?? {}, defaultWorkspacePath));
        case "notifications/initialized":
          return null;
        default:
          return failure(request.id, -32601, `Unsupported method ${request.method}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return failure(request.id, -32000, message);
    }
  }

  return {
    handleRequest,
  };
}

async function initializeResult(defaultWorkspacePath: string, bridgeClient: BridgeClient, env: NodeJS.ProcessEnv) {
  const bridgeAvailable = await bridgeClient.isAvailable();
  const alTool = await detectAlTool(env);

  return {
    protocolVersion: "2024-11-05",
    serverInfo: {
      name: "bcal-mcp",
      version: "0.1.0",
    },
    capabilities: {
      tools: {},
      resources: {},
      experimental: {
        bcalMcp: {
          defaultWorkspacePath,
          bridgeSocketPath: bridgeClient.socketPath,
          bridgeAvailable,
          alToolAvailable: Boolean(alTool.path),
          degradedTools: [
            ...(bridgeAvailable ? [] : ["bc_diagnostics", "bc_symbols_refresh", "bc_symbols_search", "bc_object_inspect", "bc_references_find", "bc_publish"]),
            ...(alTool.path ? [] : ["bc_build"]),
          ],
        },
      },
    },
  };
}

async function handleToolCall(
  params: Record<string, any>,
  defaultWorkspacePath: string,
  bridgeClient: BridgeClient,
  env: NodeJS.ProcessEnv,
  sendNotification?: (method: string, params: Record<string, unknown>) => void,
) {
  const toolName = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, any>;

  let result: ToolResult;
  switch (toolName) {
    case "bc_project_info":
      result = await projectInfoTool(args, defaultWorkspacePath, bridgeClient, env);
      break;
    case "bc_build":
      result = await buildTool(args, defaultWorkspacePath, env, sendNotification);
      break;
    case "bc_diagnostics":
      result = await bridgeBackedTool("diagnostics.get", args, "Fetched diagnostics.", bridgeClient);
      break;
    case "bc_symbols_refresh":
      result = await bridgeBackedTool("symbols.refresh", args, "Refreshed symbols.", bridgeClient);
      break;
    case "bc_symbols_search":
      result = await bridgeBackedTool("symbols.search", args, "Searched symbols.", bridgeClient);
      break;
    case "bc_object_inspect":
      result = await bridgeBackedTool("object.inspect", args, "Inspected object.", bridgeClient);
      break;
    case "bc_references_find":
      result = await bridgeBackedTool("references.find", args, "Resolved references.", bridgeClient);
      break;
    case "bc_publish":
      result = await publishTool(args, bridgeClient, sendNotification);
      break;
    default:
      result = {
        status: "error",
        summary: `Unsupported tool ${toolName}.`,
        details: {},
        artifacts: [],
        errorCategory: "configuration",
      };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
    isError: result.status === "error",
  };
}

async function projectInfoTool(
  args: Record<string, unknown>,
  defaultWorkspacePath: string,
  bridgeClient: BridgeClient,
  env: NodeJS.ProcessEnv,
): Promise<ToolResult> {
  const workspacePath = await pickWorkspacePath(args.workspacePath, defaultWorkspacePath);
  const [manifest, launchProfiles, objectCatalog, bridgeAvailable, alTool] = await Promise.all([
    readManifest(workspacePath),
    readLaunchProfiles(workspacePath),
    scanObjectCatalog(workspacePath),
    bridgeClient.isAvailable(),
    detectAlTool(env),
  ]);

  return {
    status: "success",
    summary: `Loaded Business Central AL project info for ${workspacePath}.`,
    details: {
      workspacePath,
      manifest,
      runtime: manifest.runtime,
      dependencies: manifest.dependencies ?? [],
      launchProfiles,
      objectCount: objectCatalog.length,
      capabilities: {
        bridgeAvailable,
        alToolAvailable: Boolean(alTool.path),
      },
    },
    artifacts: [],
  };
}

async function buildTool(
  args: Record<string, unknown>,
  defaultWorkspacePath: string,
  env: NodeJS.ProcessEnv,
  sendNotification?: (method: string, params: Record<string, unknown>) => void,
): Promise<ToolResult> {
  try {
    const workspacePath = await pickWorkspacePath(args.workspacePath, defaultWorkspacePath);
    const outputPath = typeof args.outputPath === "string" ? args.outputPath : undefined;
    const target = typeof args.target === "string" ? args.target : undefined;
    const cancelToken = `build:${Date.now()}`;

    sendNotification?.("notifications/progress", {
      token: cancelToken,
      message: "Preparing AL build.",
    });

    const result = await buildProject({
      workspacePath,
      outputPath,
      target,
      env,
      onProgress: (message) => {
        sendNotification?.("notifications/progress", { token: cancelToken, message });
      },
    });

    return {
      ...result,
      cancelToken,
    };
  } catch (error) {
    return {
      status: "error",
      summary: "AL build configuration is invalid.",
      details: {
        message: error instanceof Error ? error.message : "Unknown build error.",
      },
      artifacts: [],
      errorCategory: "configuration",
    };
  }
}

async function publishTool(
  args: Record<string, unknown>,
  bridgeClient: BridgeClient,
  sendNotification?: (method: string, params: Record<string, unknown>) => void,
): Promise<ToolResult> {
  const cancelToken = `publish:${Date.now()}`;
  sendNotification?.("notifications/progress", {
    token: cancelToken,
    message: "Starting publish request through the VS Code bridge.",
  });

  const result = await bridgeBackedTool("publish.run", args, "Started publish.", bridgeClient, "publish");
  return {
    ...result,
    cancelToken,
  };
}

async function bridgeBackedTool(
  method: string,
  args: Record<string, unknown>,
  successSummary: string,
  bridgeClient: BridgeClient,
  remoteErrorCategory = "configuration",
): Promise<ToolResult> {
  const response = await bridgeClient.call<Record<string, unknown>>(method, args);
  if (!response.ok) {
    return {
      status: "error",
      summary: response.kind === "transport" ? "VS Code bridge is unavailable." : "Bridge request failed.",
      details: {
        method,
        message: response.message,
      },
      artifacts: [],
      errorCategory: response.kind === "transport" ? "bridge-unavailable" : remoteErrorCategory,
    };
  }

  return {
    status: "success",
    summary: successSummary,
    details: response.value,
    artifacts: [],
  };
}

async function handleResourceRead(params: Record<string, unknown>, defaultWorkspacePath: string) {
  const uri = String(params.uri ?? "");
  const workspacePath = await pickWorkspacePath(params.workspacePath, defaultWorkspacePath);

  switch (uri) {
    case "bc://workspace/manifest":
      return jsonResource(uri, await readManifest(workspacePath));
    case "bc://workspace/launch-profiles":
      return jsonResource(uri, await readLaunchProfiles(workspacePath));
    case "bc://workspace/object-catalog":
      return jsonResource(uri, await scanObjectCatalog(workspacePath));
    default:
      throw new Error(`Unsupported resource ${uri}.`);
  }
}

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function success(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

function failure(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

async function pickWorkspacePath(inputPath: unknown, defaultWorkspacePath: string): Promise<string> {
  if (typeof inputPath === "string" && inputPath.trim()) {
    return resolveWorkspacePath(inputPath);
  }

  return resolveWorkspacePath(defaultWorkspacePath);
}

export { filterObjectCatalog };
