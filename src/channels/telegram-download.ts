import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import type { TelegramApi } from "./telegram-api.js";

export interface DownloadedFile {
  path: string; // absolute path on disk
  filename: string;
  mimeType?: string;
  size?: number;
}

// Downloads a Telegram file by file_id to dataDir/uploads/<sessionId>/<name>.
// Returns the absolute path and filename. The bytes come from
// https://api.telegram.org/file/bot<TOKEN>/<file_path>.
export async function downloadTelegramFile(
  api: TelegramApi,
  fileId: string,
  opts: { aiSessionId?: string; preferredName?: string; mimeType?: string } = {}
): Promise<DownloadedFile> {
  const meta = await api.getFile(fileId);
  const url = api.fileUrl(meta.file_path);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`telegram file fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const dir = ensureDir(join(dataDir(), "uploads", opts.aiSessionId ?? "_unbound"));

  // Prefer caller-provided name; else use the tail of the telegram file_path.
  let name = opts.preferredName ?? basename(meta.file_path);
  // If the name has no extension, try to derive one from the telegram path.
  if (!extname(name)) {
    const ext = extname(meta.file_path);
    if (ext) name = `${name}${ext}`;
  }
  const path = uniquePath(join(dir, name));
  writeFileSync(path, buf);
  return {
    path,
    filename: basename(path),
    mimeType: opts.mimeType,
    size: meta.file_size,
  };
}

function uniquePath(target: string): string {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  let n = 0;
  let candidate = target;
  while (existsSync(candidate)) {
    n++;
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}
