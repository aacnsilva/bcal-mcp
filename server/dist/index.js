// @bun
// server/src/runtime.ts
import path4 from "path";

// server/src/alTool.ts
import { mkdir, readdir as readdir2 } from "fs/promises";
import path2 from "path";
import { constants as fsConstants } from "fs";
import { access as access2 } from "fs/promises";
import { spawn } from "child_process";

// server/src/project.ts
import { access, readFile, readdir } from "fs/promises";
import path from "path";
var OBJECT_DECLARATION = /^\s*(tableextension|pageextension|permissionsetextension|reportextension|enumextension|table|page|codeunit|report|query|enum|interface|xmlport|permissionset|controladdin|profile)\s+(\d+)?\s*(?:"([^"]+)"|([^\s{]+))?/im;
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function resolveWorkspacePath(inputPath) {
  return path.resolve(inputPath ?? process.cwd());
}
async function readManifest(workspacePath) {
  const manifestPath = path.join(workspacePath, "app.json");
  const raw = await readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}
async function readLaunchProfiles(workspacePath) {
  const launchPath = path.join(workspacePath, ".vscode", "launch.json");
  if (!await fileExists(launchPath)) {
    return [];
  }
  const raw = await readFile(launchPath, "utf8");
  const parsed = JSON.parse(raw);
  return (parsed.configurations ?? []).filter((profile) => !profile.type || profile.type === "al");
}
async function scanObjectCatalog(workspacePath) {
  const files = await collectFiles(workspacePath, (entryPath) => entryPath.endsWith(".al"));
  const entries = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const match = OBJECT_DECLARATION.exec(source);
    if (!match) {
      continue;
    }
    const objectType = match[1].toLowerCase();
    const idValue = match[2] ? Number(match[2]) : null;
    const name = (match[3] ?? match[4] ?? "").trim();
    const snippet = match[0].trim();
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    entries.push({
      objectType,
      id: Number.isNaN(idValue) ? null : idValue,
      name,
      filePath,
      line,
      snippet
    });
  }
  return entries.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
async function collectFiles(rootPath, predicate) {
  const results = [];
  const ignoredNames = new Set([".git", ".alpackages", ".gitignore", "node_modules", "dist"]);
  async function walk(currentPath) {
    const dirEntries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (ignoredNames.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (entry.isFile() && predicate(entryPath)) {
        results.push(entryPath);
      }
    }
  }
  await walk(rootPath);
  return results;
}

// server/src/alTool.ts
async function detectAlTool(env = process.env) {
  const configuredPath = env.AL_TOOL_PATH ?? env.BCAL_AL_TOOL_PATH;
  if (configuredPath && await isExecutable(configuredPath)) {
    return { path: configuredPath };
  }
  for (const candidate of ["alc", "alc.exe", "altool", "altool.exe"]) {
    const resolved = await which(candidate, env.PATH);
    if (resolved) {
      return { path: resolved };
    }
  }
  return { path: null };
}
async function buildProject(params) {
  const startedAt = Date.now();
  const workspacePath = path2.resolve(params.workspacePath);
  const manifest = await readManifest(workspacePath);
  const outputRoot = path2.resolve(params.outputPath ?? path2.join(workspacePath, ".bcal-artifacts"));
  await mkdir(outputRoot, { recursive: true });
  const alTool = await detectAlTool(params.env);
  if (!alTool.path) {
    return {
      status: "error",
      summary: "ALTool was not found. Set AL_TOOL_PATH or add alc to PATH.",
      details: {
        durationMs: Date.now() - startedAt,
        workspacePath,
        outputPath: outputRoot,
        target: params.target
      },
      artifacts: [],
      errorCategory: "tooling-missing"
    };
  }
  const artifactPath = path2.join(outputRoot, `${sanitizeFileName(manifest.name ?? "business-central-app")}.app`);
  const args = buildArguments(workspacePath, artifactPath, params.target, manifest, params.env);
  params.onProgress?.("Running ALTool build.");
  const execution = await runCommand(alTool.path, args, workspacePath, params.env);
  const diagnostics = parseDiagnostics(execution.stdout + execution.stderr);
  if (execution.exitCode !== 0) {
    return {
      status: "error",
      summary: diagnostics.length > 0 ? "AL build failed with compiler diagnostics." : "AL build failed.",
      details: {
        command: alTool.path,
        args,
        diagnostics,
        durationMs: Date.now() - startedAt,
        workspacePath,
        outputPath: outputRoot,
        target: params.target
      },
      artifacts: [],
      errorCategory: diagnostics.length > 0 ? "compile" : "configuration"
    };
  }
  const producedArtifacts = await findArtifacts(outputRoot, artifactPath);
  return {
    status: "success",
    summary: "AL build completed successfully.",
    details: {
      command: alTool.path,
      args,
      diagnostics,
      durationMs: Date.now() - startedAt,
      workspacePath,
      outputPath: outputRoot,
      target: params.target
    },
    artifacts: producedArtifacts.map((entryPath) => ({ type: "app", path: entryPath }))
  };
}
function buildArguments(workspacePath, artifactPath, target, _manifest, env = process.env) {
  const args = [
    `/project:${workspacePath}`,
    `/packagecachepath:${path2.join(workspacePath, ".alpackages")}`,
    `/out:${artifactPath}`
  ];
  if (target) {
    args.push(`/target:${target}`);
  }
  const extraArgs = splitArgs(env.AL_TOOL_EXTRA_ARGS);
  return args.concat(extraArgs);
}
function splitArgs(value) {
  if (!value) {
    return [];
  }
  const matches = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ""));
}
async function runCommand(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
function parseDiagnostics(output) {
  const diagnostics = [];
  const pattern = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|info)\s+(?<code>[A-Z]+\d+):\s*(?<message>.+)$/gim;
  for (const match of output.matchAll(pattern)) {
    diagnostics.push({
      filePath: match.groups?.file,
      line: Number(match.groups?.line ?? "0"),
      column: Number(match.groups?.column ?? "0"),
      severity: match.groups?.severity?.toLowerCase() ?? "error",
      code: match.groups?.code,
      message: match.groups?.message?.trim() ?? "Unknown compiler diagnostic."
    });
  }
  return diagnostics;
}
async function findArtifacts(outputRoot, preferredArtifact) {
  if (await fileIsReadable(preferredArtifact)) {
    return [preferredArtifact];
  }
  const results = [];
  const entries = await readdir2(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".app")) {
      results.push(path2.join(outputRoot, entry.name));
    }
  }
  return results;
}
async function fileIsReadable(filePath) {
  try {
    await access2(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
async function isExecutable(filePath) {
  try {
    await access2(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function which(binaryName, pathValue) {
  if (!pathValue) {
    return null;
  }
  for (const segment of pathValue.split(path2.delimiter)) {
    const candidate = path2.join(segment, binaryName);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}
function sanitizeFileName(value) {
  return value.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "");
}

// server/src/bridge.ts
import net from "net";
import path3 from "path";
import { tmpdir } from "os";

class BridgeClient {
  socketPath;
  timeoutMs;
  constructor(options) {
    this.socketPath = options?.socketPath ?? defaultBridgeSocketPath();
    this.timeoutMs = options?.timeoutMs ?? Number(process.env.BCAL_MCP_BRIDGE_TIMEOUT_MS ?? 5000);
  }
  async isAvailable() {
    const response = await this.call("workspace.info", {});
    return response.ok;
  }
  async call(method, params) {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const requestId = Date.now();
      const finalize = (value) => {
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
        const payload = {
          jsonrpc: "2.0",
          id: requestId,
          method,
          params
        };
        socket.write(`${JSON.stringify(payload)}
`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes(`
`)) {
          const newlineIndex = buffer.indexOf(`
`);
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          let response;
          try {
            response = JSON.parse(line);
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
          finalize({ ok: true, value: response.result });
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
function defaultBridgeSocketPath() {
  if (process.platform === "win32") {
    return String.raw`\\.\pipe\bcal-mcp-bridge-v1`;
  }
  return process.env.BCAL_MCP_BRIDGE_SOCKET ?? path3.join(tmpdir(), "bcal-mcp-bridge-v1.sock");
}

// server/src/runtime.ts
var TOOL_DEFINITIONS = [
  {
    name: "bc_project_info",
    description: "Read app.json, workspace metadata, and available launch profiles.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" }
      }
    }
  },
  {
    name: "bc_diagnostics",
    description: "Return structured AL diagnostics for a workspace or file through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        filePath: { type: "string" }
      }
    }
  },
  {
    name: "bc_symbols_refresh",
    description: "Refresh Business Central symbols through the VS Code bridge.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" }
      }
    }
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
        limit: { type: "number" }
      },
      required: ["query"]
    }
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
        objectName: { type: "string" }
      }
    }
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
        query: { type: "string" }
      }
    }
  },
  {
    name: "bc_build",
    description: "Compile/package an AL workspace with ALTool.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        outputPath: { type: "string" },
        target: { type: "string" }
      },
      required: ["workspacePath"]
    }
  },
  {
    name: "bc_publish",
    description: "Publish an AL workspace through the VS Code bridge using an existing launch profile.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        launchProfile: { type: "string" },
        dependencyPublishingOrder: { type: "array", items: { type: "string" } }
      },
      required: ["workspacePath", "launchProfile"]
    }
  }
];
var RESOURCE_DEFINITIONS = [
  { uri: "bc://workspace/manifest", name: "Workspace manifest", mimeType: "application/json" },
  { uri: "bc://workspace/launch-profiles", name: "Workspace launch profiles", mimeType: "application/json" },
  { uri: "bc://workspace/object-catalog", name: "Workspace object catalog", mimeType: "application/json" }
];
function createBcalServer(options = {}) {
  const bridgeClient = options.bridgeClient ?? new BridgeClient;
  const env = options.env ?? process.env;
  const defaultWorkspacePath = path4.resolve(options.defaultWorkspacePath ?? process.cwd());
  async function handleRequest(request) {
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
    handleRequest
  };
}
async function initializeResult(defaultWorkspacePath, bridgeClient, env) {
  const bridgeAvailable = await bridgeClient.isAvailable();
  const alTool = await detectAlTool(env);
  return {
    protocolVersion: "2024-11-05",
    serverInfo: {
      name: "bcal-mcp",
      version: "0.1.0"
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
            ...bridgeAvailable ? [] : ["bc_diagnostics", "bc_symbols_refresh", "bc_symbols_search", "bc_object_inspect", "bc_references_find", "bc_publish"],
            ...alTool.path ? [] : ["bc_build"]
          ]
        }
      }
    }
  };
}
async function handleToolCall(params, defaultWorkspacePath, bridgeClient, env, sendNotification) {
  const toolName = String(params.name ?? "");
  const args = params.arguments ?? {};
  let result;
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
        errorCategory: "configuration"
      };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result,
    isError: result.status === "error"
  };
}
async function projectInfoTool(args, defaultWorkspacePath, bridgeClient, env) {
  const workspacePath = await pickWorkspacePath(args.workspacePath, defaultWorkspacePath);
  const [manifest, launchProfiles, objectCatalog, bridgeAvailable, alTool] = await Promise.all([
    readManifest(workspacePath),
    readLaunchProfiles(workspacePath),
    scanObjectCatalog(workspacePath),
    bridgeClient.isAvailable(),
    detectAlTool(env)
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
        alToolAvailable: Boolean(alTool.path)
      }
    },
    artifacts: []
  };
}
async function buildTool(args, defaultWorkspacePath, env, sendNotification) {
  try {
    const workspacePath = await pickWorkspacePath(args.workspacePath, defaultWorkspacePath);
    const outputPath = typeof args.outputPath === "string" ? args.outputPath : undefined;
    const target = typeof args.target === "string" ? args.target : undefined;
    const cancelToken = `build:${Date.now()}`;
    sendNotification?.("notifications/progress", {
      token: cancelToken,
      message: "Preparing AL build."
    });
    const result = await buildProject({
      workspacePath,
      outputPath,
      target,
      env,
      onProgress: (message) => {
        sendNotification?.("notifications/progress", { token: cancelToken, message });
      }
    });
    return {
      ...result,
      cancelToken
    };
  } catch (error) {
    return {
      status: "error",
      summary: "AL build configuration is invalid.",
      details: {
        message: error instanceof Error ? error.message : "Unknown build error."
      },
      artifacts: [],
      errorCategory: "configuration"
    };
  }
}
async function publishTool(args, bridgeClient, sendNotification) {
  const cancelToken = `publish:${Date.now()}`;
  sendNotification?.("notifications/progress", {
    token: cancelToken,
    message: "Starting publish request through the VS Code bridge."
  });
  const result = await bridgeBackedTool("publish.run", args, "Started publish.", bridgeClient, "publish");
  return {
    ...result,
    cancelToken
  };
}
async function bridgeBackedTool(method, args, successSummary, bridgeClient, remoteErrorCategory = "configuration") {
  const response = await bridgeClient.call(method, args);
  if (!response.ok) {
    return {
      status: "error",
      summary: response.kind === "transport" ? "VS Code bridge is unavailable." : "Bridge request failed.",
      details: {
        method,
        message: response.message
      },
      artifacts: [],
      errorCategory: response.kind === "transport" ? "bridge-unavailable" : remoteErrorCategory
    };
  }
  return {
    status: "success",
    summary: successSummary,
    details: response.value,
    artifacts: []
  };
}
async function handleResourceRead(params, defaultWorkspacePath) {
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
function jsonResource(uri, value) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
function success(id, result) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}
function failure(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message
    }
  };
}
async function pickWorkspacePath(inputPath, defaultWorkspacePath) {
  if (typeof inputPath === "string" && inputPath.trim()) {
    return resolveWorkspacePath(inputPath);
  }
  return resolveWorkspacePath(defaultWorkspacePath);
}

// server/src/index.ts
var encoder = new TextEncoder;
var decoder = new TextDecoder;
function startServer() {
  const server = createBcalServer({
    defaultWorkspacePath: process.env.BC_WORKSPACE_PATH ?? process.cwd(),
    sendNotification(method, params) {
      writeMessage({
        jsonrpc: "2.0",
        method,
        params
      });
    }
  });
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf(`\r
\r
`);
      if (headerEnd === -1) {
        break;
      }
      const headerText = decoder.decode(buffer.subarray(0, headerEnd));
      const contentLengthLine = headerText.split(`\r
`).find((line) => line.toLowerCase().startsWith("content-length:"));
      if (!contentLengthLine) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const contentLength = Number(contentLengthLine.split(":")[1]?.trim() ?? "0");
      const totalLength = headerEnd + 4 + contentLength;
      if (buffer.length < totalLength) {
        break;
      }
      const payload = decoder.decode(buffer.subarray(headerEnd + 4, totalLength));
      buffer = buffer.subarray(totalLength);
      let request;
      try {
        request = JSON.parse(payload);
      } catch {
        continue;
      }
      const response = await server.handleRequest(request);
      if (response) {
        writeMessage(response);
      }
    }
  });
  process.stdin.resume();
}
function writeMessage(message) {
  const payload = encoder.encode(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${payload.byteLength}\r
\r
`);
  process.stdout.write(payload);
}
if (import.meta.main) {
  startServer();
}
export {
  startServer
};
