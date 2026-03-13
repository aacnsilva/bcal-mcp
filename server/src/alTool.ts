import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readManifest, type AppManifest } from "./project.ts";

export type BuildParams = {
  workspacePath: string;
  outputPath?: string;
  target?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
};

export type BuildResult = {
  status: "success" | "error";
  summary: string;
  details: {
    command?: string;
    args?: string[];
    diagnostics?: Diagnostic[];
    durationMs: number;
    workspacePath: string;
    outputPath: string;
    target?: string;
  };
  artifacts: Array<{ type: string; path: string }>;
  errorCategory?: "tooling-missing" | "compile" | "configuration";
};

export type Diagnostic = {
  filePath?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  code?: string;
  message: string;
};

export async function detectAlTool(env: NodeJS.ProcessEnv = process.env): Promise<{ path: string | null }> {
  const configuredPath = env.AL_TOOL_PATH ?? env.BCAL_AL_TOOL_PATH;
  if (configuredPath && (await isExecutable(configuredPath))) {
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

export async function buildProject(params: BuildParams): Promise<BuildResult> {
  const startedAt = Date.now();
  const workspacePath = path.resolve(params.workspacePath);
  const manifest = await readManifest(workspacePath);
  const outputRoot = path.resolve(params.outputPath ?? path.join(workspacePath, ".bcal-artifacts"));
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
        target: params.target,
      },
      artifacts: [],
      errorCategory: "tooling-missing",
    };
  }

  const artifactPath = path.join(outputRoot, `${sanitizeFileName(manifest.name ?? "business-central-app")}.app`);
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
        target: params.target,
      },
      artifacts: [],
      errorCategory: diagnostics.length > 0 ? "compile" : "configuration",
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
      target: params.target,
    },
    artifacts: producedArtifacts.map((entryPath) => ({ type: "app", path: entryPath })),
  };
}

function buildArguments(
  workspacePath: string,
  artifactPath: string,
  target: string | undefined,
  _manifest: AppManifest,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [
    `/project:${workspacePath}`,
    `/packagecachepath:${path.join(workspacePath, ".alpackages")}`,
    `/out:${artifactPath}`,
  ];

  if (target) {
    args.push(`/target:${target}`);
  }

  const extraArgs = splitArgs(env.AL_TOOL_EXTRA_ARGS);
  return args.concat(extraArgs);
}

function splitArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const matches = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ""));
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern =
    /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|info)\s+(?<code>[A-Z]+\d+):\s*(?<message>.+)$/gim;

  for (const match of output.matchAll(pattern)) {
    diagnostics.push({
      filePath: match.groups?.file,
      line: Number(match.groups?.line ?? "0"),
      column: Number(match.groups?.column ?? "0"),
      severity: (match.groups?.severity?.toLowerCase() as Diagnostic["severity"]) ?? "error",
      code: match.groups?.code,
      message: match.groups?.message?.trim() ?? "Unknown compiler diagnostic.",
    });
  }

  return diagnostics;
}

async function findArtifacts(outputRoot: string, preferredArtifact: string): Promise<string[]> {
  if (await fileIsReadable(preferredArtifact)) {
    return [preferredArtifact];
  }

  const results: string[] = [];
  const entries = await readdir(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".app")) {
      results.push(path.join(outputRoot, entry.name));
    }
  }
  return results;
}

async function fileIsReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(binaryName: string, pathValue?: string): Promise<string | null> {
  if (!pathValue) {
    return null;
  }

  for (const segment of pathValue.split(path.delimiter)) {
    const candidate = path.join(segment, binaryName);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "");
}
