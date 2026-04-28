import type { Provider } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { opencodeProvider } from "./opencode.js";
import { glmProvider } from "./glm.js";

export const providers: Record<string, Provider> = {
  claude: claudeProvider,
  glm: glmProvider,
  codex: codexProvider,
  opencode: opencodeProvider,
};

export function getProvider(name: string): Provider {
  const p = providers[name];
  if (!p) throw new Error(`unknown provider: ${name} (expected: ${Object.keys(providers).join(", ")})`);
  return p;
}

export function listProviderNames(): string[] {
  return Object.keys(providers);
}
