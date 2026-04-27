// Channel address: provider-specific. Telegram uses chat + optional thread.
export interface TelegramAddress {
  chatId: number;
  threadId?: number;
}

export type ChannelAddress = TelegramAddress; // union when more channels land

export interface ChannelMessage {
  text?: string;
  // Future: attachments, buttons, etc.
}

export interface Channel {
  name: string; // "telegram"
  isAvailable(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Outbound: post a message into a bound channel address.
  send(address: ChannelAddress, msg: ChannelMessage): Promise<void>;
}
