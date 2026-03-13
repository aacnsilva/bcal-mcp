// vscode-bridge/src/extension.ts
import net from "node:net";
import path2 from "node:path";
import { tmpdir } from "node:os";
import { readFile as readFile2, unlink } from "node:fs/promises";
import * as vscode from "vscode";

// vscode-bridge/src/objectCatalog.ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
var OBJECT_DECLARATION = /^\s*(tableextension|pageextension|permissionsetextension|reportextension|enumextension|table|page|codeunit|report|query|enum|interface|xmlport|permissionset|controladdin|profile)\s+(\d+)?\s*(?:"([^"]+)"|([^\s{]+))?/im;
async function readWorkspaceManifest(workspacePath) {
  return JSON.parse(await readFile(path.join(workspacePath, "app.json"), "utf8"));
}
async function readLaunchProfiles(workspacePath) {
  const launchPath = path.join(workspacePath, ".vscode", "launch.json");
  try {
    const raw = await readFile(launchPath, "utf8");
    const parsed = JSON.parse(raw);
    return (parsed.configurations ?? []).filter((profile) => !profile.type || profile.type === "al");
  } catch {
    return [];
  }
}
async function scanObjectCatalog(workspacePath) {
  const filePaths = await collectAlFiles(workspacePath);
  const catalog = [];
  for (const filePath of filePaths) {
    const source = await readFile(filePath, "utf8");
    const match = OBJECT_DECLARATION.exec(source);
    if (!match) {
      continue;
    }
    catalog.push({
      objectType: match[1].toLowerCase(),
      id: match[2] ? Number(match[2]) : null,
      name: (match[3] ?? match[4] ?? "").trim(),
      filePath,
      line: source.slice(0, match.index).split(/\r?\n/).length,
      snippet: match[0].trim()
    });
  }
  return catalog.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
function searchCatalog(catalog, query, objectType, limit = 25) {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedType = objectType?.trim().toLowerCase();
  return catalog.filter((entry) => !normalizedType || entry.objectType === normalizedType).filter((entry) => {
    if (!normalizedQuery) {
      return true;
    }
    return [entry.objectType, String(entry.id ?? ""), entry.name, entry.filePath].join(" ").toLowerCase().includes(normalizedQuery);
  }).slice(0, limit);
}
async function collectAlFiles(rootPath) {
  const results = [];
  const ignoredNames = new Set([".git", ".alpackages", "node_modules", "dist"]);
  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".al")) {
        results.push(entryPath);
      }
    }
  }
  await walk(rootPath);
  return results;
}

// vscode-bridge/src/extension.ts
var currentServer;
async function activate(context) {
  const socketPath = defaultBridgeSocketPath();
  currentServer = await startBridgeServer(socketPath);
  context.subscriptions.push({
    dispose() {
      currentServer?.close();
      currentServer = undefined;
    }
  });
  context.subscriptions.push(vscode.commands.registerCommand("bcalMcpBridge.showStatus", async () => {
    await vscode.window.showInformationMessage(`BC AL MCP Bridge listening on ${socketPath}`);
  }));
}
function deactivate() {
  currentServer?.close();
  currentServer = undefined;
}
async function startBridgeServer(socketPath) {
  if (process.platform !== "win32") {
    await unlink(socketPath).catch(() => {
      return;
    });
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
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
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify(errorResponse(null, -32700, "Invalid JSON payload."))}
`);
          continue;
        }
        const response = await handleBridgeRequest(request);
        socket.write(`${JSON.stringify(response)}
`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}
async function handleBridgeRequest(request) {
  try {
    switch (request.method) {
      case "workspace.info":
        return successResponse(request.id, await workspaceInfo(request.params ?? {}));
      case "workspace.launchProfiles":
        return successResponse(request.id, await workspaceLaunchProfiles(request.params ?? {}));
      case "diagnostics.get":
        return successResponse(request.id, await diagnosticsGet(request.params ?? {}));
      case "symbols.refresh":
        return successResponse(request.id, await symbolsRefresh(request.params ?? {}));
      case "symbols.search":
        return successResponse(request.id, await symbolsSearch(request.params ?? {}));
      case "object.inspect":
        return successResponse(request.id, await objectInspect(request.params ?? {}));
      case "references.find":
        return successResponse(request.id, await referencesFind(request.params ?? {}));
      case "publish.run":
        return successResponse(request.id, await publishRun(request.params ?? {}));
      default:
        return errorResponse(request.id, -32601, `Unsupported bridge method ${request.method}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected bridge error.";
    return errorResponse(request.id, -32000, message);
  }
}
async function workspaceInfo(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  const manifest = await readWorkspaceManifest(workspaceFolder.uri.fsPath);
  const launchProfiles = await readLaunchProfiles(workspaceFolder.uri.fsPath);
  const objectCatalog = await scanObjectCatalog(workspaceFolder.uri.fsPath);
  return {
    bridgeVersion: "1.0.0",
    workspacePath: workspaceFolder.uri.fsPath,
    manifest,
    launchProfiles,
    objectCount: objectCatalog.length
  };
}
async function workspaceLaunchProfiles(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  return {
    workspacePath: workspaceFolder.uri.fsPath,
    launchProfiles: await readLaunchProfiles(workspaceFolder.uri.fsPath)
  };
}
async function diagnosticsGet(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  const diagnostics = vscode.languages.getDiagnostics();
  const entries = diagnostics.filter(([uri]) => {
    if (params.filePath) {
      return uri.fsPath === path2.resolve(params.filePath);
    }
    return uri.fsPath.startsWith(workspaceFolder.uri.fsPath);
  }).flatMap(([uri, items]) => items.map((diagnostic) => ({
    filePath: uri.fsPath,
    message: diagnostic.message,
    severity: severityToString(diagnostic.severity),
    code: typeof diagnostic.code === "string" ? diagnostic.code : diagnostic.code?.value,
    range: {
      start: diagnostic.range.start,
      end: diagnostic.range.end
    },
    source: diagnostic.source
  })));
  return {
    workspacePath: workspaceFolder.uri.fsPath,
    count: entries.length,
    diagnostics: entries
  };
}
async function symbolsRefresh(params) {
  resolveWorkspaceFolder(params.workspacePath);
  const attemptedCommands = ["al.downloadSymbols", "al.downloadSymbolsWithDependencies", "AL.downloadSymbols"];
  let executedCommand;
  let lastError;
  for (const command of attemptedCommands) {
    try {
      await vscode.commands.executeCommand(command);
      executedCommand = command;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!executedCommand) {
    throw new Error(lastError?.message ?? "No symbol refresh command could be executed.");
  }
  return {
    command: executedCommand,
    refreshed: true
  };
}
async function symbolsSearch(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  const catalog = await scanObjectCatalog(workspaceFolder.uri.fsPath);
  const matches = searchCatalog(catalog, params.query, params.objectType, params.limit ?? 25);
  return {
    workspacePath: workspaceFolder.uri.fsPath,
    count: matches.length,
    matches
  };
}
async function objectInspect(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  const manifest = await readWorkspaceManifest(workspaceFolder.uri.fsPath);
  const catalog = await scanObjectCatalog(workspaceFolder.uri.fsPath);
  const match = catalog.find((entry) => matchesObject(entry, params));
  if (!match) {
    throw new Error("No matching AL object was found.");
  }
  return {
    workspacePath: workspaceFolder.uri.fsPath,
    object: match,
    dependencies: manifest.dependencies ?? []
  };
}
async function referencesFind(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  if (params.filePath && typeof params.line === "number" && typeof params.character === "number") {
    const uri = vscode.Uri.file(path2.resolve(params.filePath));
    const position = new vscode.Position(params.line, params.character);
    const locations = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position) ?? [];
    return {
      strategy: "referenceProvider",
      count: locations.length,
      references: locations.map((location) => ({
        filePath: location.uri.fsPath,
        range: {
          start: location.range.start,
          end: location.range.end
        }
      }))
    };
  }
  if (!params.query) {
    throw new Error("references.find requires either filePath/line/character or a query.");
  }
  const textMatches = await textSearch(workspaceFolder.uri.fsPath, params.query);
  return {
    strategy: "textSearch",
    count: textMatches.length,
    references: textMatches
  };
}
async function publishRun(params) {
  const workspaceFolder = resolveWorkspaceFolder(params.workspacePath);
  const launchProfiles = await readLaunchProfiles(workspaceFolder.uri.fsPath);
  const profile = launchProfiles.find((entry) => entry.name === params.launchProfile);
  if (!profile) {
    throw new Error(`Launch profile ${params.launchProfile} was not found.`);
  }
  const started = await vscode.debug.startDebugging(workspaceFolder, params.launchProfile);
  if (!started) {
    throw new Error(`VS Code could not start launch profile ${params.launchProfile}.`);
  }
  return {
    workspacePath: workspaceFolder.uri.fsPath,
    launchProfile: params.launchProfile,
    dependencyPublishingOrder: params.dependencyPublishingOrder ?? [],
    started,
    mode: "debug.startDebugging"
  };
}
function resolveWorkspaceFolder(workspacePath) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error("No VS Code workspace folder is open.");
  }
  if (!workspacePath) {
    return folders[0];
  }
  const resolved = path2.resolve(workspacePath);
  const exactMatch = folders.find((folder) => folder.uri.fsPath === resolved);
  if (!exactMatch) {
    throw new Error(`Workspace folder ${resolved} is not currently open in VS Code.`);
  }
  return exactMatch;
}
function defaultBridgeSocketPath() {
  if (process.platform === "win32") {
    return String.raw`\\.\pipe\bcal-mcp-bridge-v1`;
  }
  return process.env.BCAL_MCP_BRIDGE_SOCKET ?? path2.join(tmpdir(), "bcal-mcp-bridge-v1.sock");
}
function severityToString(value) {
  switch (value) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}
function matchesObject(entry, params) {
  if (params.objectType && entry.objectType !== params.objectType.toLowerCase()) {
    return false;
  }
  if (typeof params.objectId === "number" && entry.id !== params.objectId) {
    return false;
  }
  if (params.objectName && entry.name.toLowerCase() !== params.objectName.toLowerCase()) {
    return false;
  }
  return true;
}
async function textSearch(workspacePath, query) {
  const catalog = await scanObjectCatalog(workspacePath);
  const filePaths = [...new Set(catalog.map((entry) => entry.filePath))];
  const references = [];
  const needle = query.toLowerCase();
  for (const filePath of filePaths) {
    const source = await readFile2(filePath, "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, lineNumber) => {
      const column = line.toLowerCase().indexOf(needle);
      if (column !== -1) {
        references.push({
          filePath,
          line: lineNumber,
          character: column,
          preview: line.trim()
        });
      }
    });
  }
  return references;
}
function successResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}
function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message
    }
  };
}
export {
  deactivate,
  activate
};
