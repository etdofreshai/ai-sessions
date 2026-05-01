import { listSkills, type SkillInfo } from "./catalog.js";

export const SKILLS_ADVERTISE_KEY = "skills.advertise_as_commands";

// Telegram bot command rules: [a-z0-9_]{1,32}, must start with a letter.
// Skill names use kebab-case (e.g. "ai-sessions-jobs"); we normalize dashes
// to underscores. Names that violate the regex after normalization are
// skipped — caller is responsible for renaming the skill if it wants the
// command to register.
export function skillCommandName(skill: SkillInfo): string | null {
  const candidate = skill.name.toLowerCase().replace(/-/g, "_");
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(candidate)) return null;
  return candidate;
}

// Returns the Telegram setMyCommands entries for every skill that maps to a
// valid command name. The description gets truncated to fit telegram's 256
// char limit. Used by the channel start path when the advertise toggle is on.
export interface SkillCommandEntry {
  command: string;
  description: string;
  skill: SkillInfo;
}

export function buildSkillCommands(workspaceDir: string): SkillCommandEntry[] {
  const out: SkillCommandEntry[] = [];
  for (const s of listSkills(workspaceDir)) {
    const command = skillCommandName(s);
    if (!command) continue;
    const description = (s.description || s.name).slice(0, 256);
    out.push({ command, description, skill: s });
  }
  return out;
}

// Reverse lookup: given a typed command name, return the skill (if any) it
// maps to. Used by the slash dispatcher so direct typing of /<skill> works
// even when advertising is off.
export function findSkillByCommand(
  workspaceDir: string,
  command: string,
): SkillInfo | null {
  const entries = buildSkillCommands(workspaceDir);
  return entries.find((e) => e.command === command)?.skill ?? null;
}
