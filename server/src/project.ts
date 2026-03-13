import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type AppManifest = {
  id?: string;
  name?: string;
  publisher?: string;
  version?: string;
  runtime?: string;
  application?: string;
  platform?: string;
  dependencies?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type LaunchProfile = {
  name: string;
  type?: string;
  request?: string;
  server?: string;
  serverInstance?: string;
  authentication?: string;
  startupObjectType?: string;
  startupObjectId?: number;
  [key: string]: unknown;
};

export type ObjectCatalogEntry = {
  objectType: string;
  id: number | null;
  name: string;
  filePath: string;
  line: number;
  snippet: string;
};

const OBJECT_DECLARATION =
  /^\s*(tableextension|pageextension|permissionsetextension|reportextension|enumextension|table|page|codeunit|report|query|enum|interface|xmlport|permissionset|controladdin|profile)\s+(\d+)?\s*(?:"([^"]+)"|([^\s{]+))?/im;

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspacePath(inputPath?: string): Promise<string> {
  return path.resolve(inputPath ?? process.cwd());
}

export async function readManifest(workspacePath: string): Promise<AppManifest> {
  const manifestPath = path.join(workspacePath, "app.json");
  const raw = await readFile(manifestPath, "utf8");
  return JSON.parse(raw) as AppManifest;
}

export async function readLaunchProfiles(workspacePath: string): Promise<LaunchProfile[]> {
  const launchPath = path.join(workspacePath, ".vscode", "launch.json");
  if (!(await fileExists(launchPath))) {
    return [];
  }

  const raw = await readFile(launchPath, "utf8");
  const parsed = JSON.parse(raw) as { configurations?: LaunchProfile[] };
  return (parsed.configurations ?? []).filter((profile) => !profile.type || profile.type === "al");
}

export async function scanObjectCatalog(workspacePath: string): Promise<ObjectCatalogEntry[]> {
  const files = await collectFiles(workspacePath, (entryPath) => entryPath.endsWith(".al"));
  const entries: ObjectCatalogEntry[] = [];

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
      snippet,
    });
  }

  return entries.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function filterObjectCatalog(
  entries: ObjectCatalogEntry[],
  query?: string,
  objectType?: string,
  limit = 25,
): ObjectCatalogEntry[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedType = objectType?.trim().toLowerCase();

  return entries
    .filter((entry) => !normalizedType || entry.objectType === normalizedType)
    .filter((entry) => {
      if (!normalizedQuery) {
        return true;
      }

      return [entry.objectType, String(entry.id ?? ""), entry.name, entry.filePath]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, limit);
}

async function collectFiles(rootPath: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const results: string[] = [];
  const ignoredNames = new Set([".git", ".alpackages", ".gitignore", "node_modules", "dist"]);

  async function walk(currentPath: string): Promise<void> {
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

