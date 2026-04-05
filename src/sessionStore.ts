import * as fs from "node:fs/promises";
import * as path from "node:path";

export type StoredSession = {
  sessionId: string;
  threadId?: string;
  modeId: "default" | "plan";
  cwd: string;
  updatedAt: string;
};

type StoreFile = {
  sessions: StoredSession[];
};

export class SessionStore {
  private readonly rootDir: string;
  private readonly filePath: string;

  constructor(cwd: string) {
    this.rootDir = path.join(cwd, ".codex-acp-app-server");
    this.filePath = path.join(this.rootDir, "sessions.json");
  }

  async list(): Promise<StoredSession[]> {
    return (await this.readStore()).sessions;
  }

  async get(sessionId: string): Promise<StoredSession | undefined> {
    const store = await this.readStore();
    return store.sessions.find((session) => session.sessionId === sessionId);
  }

  async upsert(session: StoredSession): Promise<void> {
    const store = await this.readStore();
    const index = store.sessions.findIndex((entry) => entry.sessionId === session.sessionId);

    if (index >= 0) {
      store.sessions[index] = session;
    } else {
      store.sessions.push(session);
    }

    await this.writeStore(store);
  }

  private async readStore(): Promise<StoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      if (!Array.isArray(parsed.sessions)) {
        return { sessions: [] };
      }

      return {
        sessions: parsed.sessions.filter((entry): entry is StoredSession => {
          return Boolean(
            entry &&
              typeof entry === "object" &&
              typeof entry.sessionId === "string" &&
              typeof entry.cwd === "string" &&
              typeof entry.updatedAt === "string" &&
              (entry.modeId === "default" || entry.modeId === "plan")
          );
        })
      };
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === "ENOENT") {
        return { sessions: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreFile): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }
}
