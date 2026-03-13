import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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

export async function readWorkspaceManifest(workspacePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(workspacePath, "app.json"), "utf8")) as Record<string, unknown>;
}

export async function readLaunchProfiles(workspacePath: string): Promise<Array<Record<string, unknown>>> {
  const launchPath = path.join(workspacePath, ".vscode", "launch.json");
  try {
    const raw = await readFile(launchPath, "utf8");
    const parsed = JSON.parse(raw) as { configurations?: Array<Record<string, unknown>> };
    return (parsed.configurations ?? []).filter((profile) => !profile.type || profile.type === "al");
  } catch {
    return [];
  }
}

export async function scanObjectCatalog(workspacePath: string): Promise<ObjectCatalogEntry[]> {
  const filePaths = await collectAlFiles(workspacePath);
  const catalog: ObjectCatalogEntry[] = [];

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
      snippet: match[0].trim(),
    });
  }

  return catalog.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function searchCatalog(
  catalog: ObjectCatalogEntry[],
  query?: string,
  objectType?: string,
  limit = 25,
): ObjectCatalogEntry[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedType = objectType?.trim().toLowerCase();

  return catalog
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

async function collectAlFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  const ignoredNames = new Set([".git", ".alpackages", "node_modules", "dist"]);

  async function walk(currentPath: string): Promise<void> {
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

