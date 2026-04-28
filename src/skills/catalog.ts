import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  path: string; // absolute path to SKILL.md
  enabled: boolean;
}

interface Frontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
}

// Minimal YAML-ish frontmatter parser: leading `---\n...\n---\n` block of
// `key: value` lines. Doesn't handle multiline values, lists, or quotes
// beyond stripping outer pairs.
function parseFrontmatter(body: string): { fm: Frontmatter; rest: string } {
  if (!body.startsWith("---")) return { fm: {}, rest: body };
  const end = body.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, rest: body };
  const block = body.slice(3, end).replace(/^\r?\n/, "");
  const rest = body.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "enabled") {
      fm.enabled = !["false", "no", "0", "off"].includes(val.toLowerCase());
    } else if (key === "name") {
      fm.name = val;
    } else if (key === "description") {
      fm.description = val;
    }
  }
  return { fm, rest };
}

function firstHeadingOrParagraph(text: string): string {
  const lines = text.split(/\r?\n/);
  // Prefer the first paragraph after the first heading.
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^#{1,6}\s+/.test(lines[i])) i++;
  while (i < lines.length && !lines[i].trim()) i++;
  const para: string[] = [];
  while (i < lines.length && lines[i].trim()) {
    para.push(lines[i].trim());
    i++;
  }
  return para.join(" ");
}

function parseSkillFile(path: string, dirName: string): SkillInfo | null {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { fm, rest } = parseFrontmatter(body);
  const enabled = fm.enabled ?? true;
  const name = fm.name?.trim() || dirName;
  const description = (fm.description?.trim() || firstHeadingOrParagraph(rest))
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return { name, description, path, enabled };
}

// Scan <workspaceDir>/skills/<dir>/SKILL.md and return enabled skills.
// Returns [] if the directory doesn't exist.
export function listSkills(workspaceDir: string): SkillInfo[] {
  const root = join(workspaceDir, "skills");
  if (!existsSync(root)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      /* skip */
    }
    if (!isDir) continue;
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const info = parseSkillFile(file, basename(dir));
    if (info?.enabled) out.push(info);
  }
  return out;
}

// Build the catalog block to append to system instructions. Returns "" when
// there are no enabled skills (caller should skip the append in that case).
export function buildCatalog(workspaceDir: string): string {
  const skills = listSkills(workspaceDir);
  if (skills.length === 0) return "";
  const lines = [
    `Available skills (read full instructions in ${workspaceDir}/skills/<name>/SKILL.md):`,
  ];
  for (const s of skills) {
    lines.push(`- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  }
  return lines.join("\n");
}
