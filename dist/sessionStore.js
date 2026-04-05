"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
class SessionStore {
    rootDir;
    filePath;
    constructor(cwd) {
        this.rootDir = path.join(cwd, ".codex-acp-app-server");
        this.filePath = path.join(this.rootDir, "sessions.json");
    }
    async list() {
        return (await this.readStore()).sessions;
    }
    async get(sessionId) {
        const store = await this.readStore();
        return store.sessions.find((session) => session.sessionId === sessionId);
    }
    async upsert(session) {
        const store = await this.readStore();
        const index = store.sessions.findIndex((entry) => entry.sessionId === session.sessionId);
        if (index >= 0) {
            store.sessions[index] = session;
        }
        else {
            store.sessions.push(session);
        }
        await this.writeStore(store);
    }
    async readStore() {
        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.sessions)) {
                return { sessions: [] };
            }
            return {
                sessions: parsed.sessions.filter((entry) => {
                    return Boolean(entry &&
                        typeof entry === "object" &&
                        typeof entry.sessionId === "string" &&
                        typeof entry.cwd === "string" &&
                        typeof entry.updatedAt === "string" &&
                        (entry.modeId === "default" || entry.modeId === "plan"));
                })
            };
        }
        catch (error) {
            const code = error?.code;
            if (code === "ENOENT") {
                return { sessions: [] };
            }
            throw error;
        }
    }
    async writeStore(store) {
        await fs.mkdir(this.rootDir, { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
    }
}
exports.SessionStore = SessionStore;
