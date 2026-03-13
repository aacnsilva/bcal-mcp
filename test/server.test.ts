import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBcalServer } from "../server/src/runtime.ts";

const fixtureRoot = path.resolve("test/fixtures/sample-al");
const fakeBridgeUnavailable = {
  async isAvailable() {
    return false;
  },
  async call() {
    return {
      ok: false as const,
      kind: "transport" as const,
      message: "Bridge socket was not reachable.",
    };
  },
};

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const entry = tempPaths.pop();
    if (entry) {
      await rm(entry, { recursive: true, force: true });
    }
  }
});

describe("bcal MCP server", () => {
  test("initialize advertises degraded capabilities without bridge and ALTool", async () => {
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: { PATH: "" },
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    const result = response?.result as any;
    expect(result.capabilities.experimental.bcalMcp.bridgeAvailable).toBe(false);
    expect(result.capabilities.experimental.bcalMcp.alToolAvailable).toBe(false);
    expect(result.capabilities.experimental.bcalMcp.degradedTools).toContain("bc_publish");
    expect(result.capabilities.experimental.bcalMcp.degradedTools).toContain("bc_build");
  });

  test("bc_project_info returns manifest, launch profiles, and object count", async () => {
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: { PATH: "" },
    });

    const result = await callTool(server, "bc_project_info", { workspacePath: fixtureRoot });
    expect(result.status).toBe("success");
    expect(result.details.manifest.name).toBe("Sample AL App");
    expect(result.details.launchProfiles).toHaveLength(1);
    expect(result.details.objectCount).toBe(2);
  });

  test("resources expose manifest and object catalog", async () => {
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: { PATH: "" },
    });

    const manifestResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: {
        uri: "bc://workspace/manifest",
        workspacePath: fixtureRoot,
      },
    });

    const objectCatalogResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: {
        uri: "bc://workspace/object-catalog",
        workspacePath: fixtureRoot,
      },
    });

    const manifest = JSON.parse((manifestResponse?.result as any).contents[0].text);
    const objectCatalog = JSON.parse((objectCatalogResponse?.result as any).contents[0].text);

    expect(manifest.runtime).toBe("14.0");
    expect(objectCatalog).toHaveLength(2);
    expect(objectCatalog[0].objectType).toBeDefined();
  });

  test("bridge-backed tools fail with bridge-unavailable when the bridge is down", async () => {
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: { PATH: "" },
    });

    const result = await callTool(server, "bc_diagnostics", { workspacePath: fixtureRoot });
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("bridge-unavailable");
  });

  test("bc_build reports tooling-missing when ALTool is not configured", async () => {
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: { PATH: "" },
    });

    const result = await callTool(server, "bc_build", { workspacePath: fixtureRoot });
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("tooling-missing");
  });

  test("bc_build succeeds with a configured ALTool wrapper", async () => {
    const outputPath = await createTempDir();
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: {
        PATH: process.env.PATH ?? "",
        AL_TOOL_PATH: path.resolve("test/fixtures/fake-alc-success"),
      },
    });

    const result = await callTool(server, "bc_build", {
      workspacePath: fixtureRoot,
      outputPath,
    });

    expect(result.status).toBe("success");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path.endsWith(".app")).toBe(true);
  });

  test("bc_build returns compile diagnostics on ALTool failure", async () => {
    const outputPath = await createTempDir();
    const server = createBcalServer({
      defaultWorkspacePath: fixtureRoot,
      bridgeClient: fakeBridgeUnavailable as never,
      env: {
        PATH: process.env.PATH ?? "",
        AL_TOOL_PATH: path.resolve("test/fixtures/fake-alc-fail"),
      },
    });

    const result = await callTool(server, "bc_build", {
      workspacePath: fixtureRoot,
      outputPath,
    });

    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("compile");
    expect(result.details.diagnostics).toHaveLength(1);
    expect(result.details.diagnostics[0].code).toBe("AL0185");
  });
});

async function createTempDir() {
  const directoryPath = await mkdtemp(path.join(tmpdir(), "bcal-mcp-"));
  tempPaths.push(directoryPath);
  return directoryPath;
}

async function callTool(server: ReturnType<typeof createBcalServer>, name: string, args: Record<string, unknown>) {
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });

  return (response?.result as any).structuredContent;
}
