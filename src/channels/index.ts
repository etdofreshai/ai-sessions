import type { Channel } from "./types.js";
import { telegramChannel } from "./telegram.js";

export const channels: Record<string, Channel> = {
  telegram: telegramChannel,
};

export function getChannel(name: string): Channel {
  const c = channels[name];
  if (!c) throw new Error(`unknown channel: ${name}`);
  return c;
}

export function listChannelNames(): string[] {
  return Object.keys(channels);
}

// Start any channels that are configured (i.e., isAvailable() === true).
export async function startAvailableChannels(): Promise<void> {
  for (const [name, c] of Object.entries(channels)) {
    if (await c.isAvailable()) {
      try {
        await c.start();
      } catch (e: any) {
        console.error(`[channel ${name}] start failed:`, e?.message ?? e);
      }
    }
  }
}
