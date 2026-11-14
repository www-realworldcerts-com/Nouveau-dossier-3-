import fs from 'node:fs';
import path from 'node:path';

/**
 * Fixed read-only access to the revenue swarm's runtime files. JARVIS never
 * writes these files; the tick/audit owns them.
 */
export function swarmRoots(): string[] {
  const roots: string[] = [];
  if (process.env.SWARM_ROOT) roots.push(process.env.SWARM_ROOT);
  // Standalone output nests the server under .next/standalone/<app>, so walk
  // up from the current directory instead of assuming a fixed parent.
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(roots)];
}

export function findSwarmFile(relativePath: string): string | null {
  for (const root of swarmRoots()) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function readSwarmJson<T = unknown>(relativePath: string): T | null {
  const file = findSwarmFile(relativePath);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readSwarmText(relativePath: string): string | null {
  const file = findSwarmFile(relativePath);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
