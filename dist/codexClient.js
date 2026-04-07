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
exports.CodexClient = void 0;
const node_events_1 = require("node:events");
const node_child_process_1 = require("node:child_process");
const readline = __importStar(require("node:readline"));
class CodexClient extends node_events_1.EventEmitter {
    executable;
    model;
    cwd;
    child;
    nextId = 1;
    initialized = false;
    initializePromise;
    closedError;
    pending = new Map();
    constructor(options) {
        super();
        this.executable = options.executable;
        this.model = options.model;
        this.cwd = options.cwd;
    }
    async initialize() {
        if (this.initialized) {
            return;
        }
        if (!this.initializePromise) {
            this.initializePromise = this.bootstrap();
        }
        return this.initializePromise;
    }
    async startThread() {
        await this.initialize();
        const result = (await this.sendRequest("thread/start", {
            cwd: this.cwd,
            model: this.model,
            approvalPolicy: "never",
            sandbox: "workspace-write",
            experimentalRawEvents: false,
            persistExtendedHistory: false
        }));
        return { threadId: result.thread.id };
    }
    async startTurn(threadId, text, collaborationMode = "default") {
        await this.initialize();
        const result = (await this.sendRequest("turn/start", {
            threadId,
            cwd: this.cwd,
            model: this.model,
            collaborationMode: {
                mode: collaborationMode,
                settings: {
                    model: this.model,
                    reasoning_effort: null,
                    developer_instructions: null
                }
            },
            input: [
                {
                    type: "text",
                    text,
                    text_elements: []
                }
            ]
        }));
        return { turnId: result.turn.id };
    }
    close() {
        if (this.child && !this.child.killed) {
            this.child.kill();
        }
    }
    async bootstrap() {
        await this.spawnChild();
        await this.sendRequest("initialize", {
            clientInfo: {
                name: "codex-acp-app-server",
                version: "0.1.0"
            },
            capabilities: {
                experimentalApi: true
            }
        });
        this.sendNotification("initialized");
        this.initialized = true;
    }
    async spawnChild() {
        if (this.child) {
            return;
        }
        await new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.spawn)(this.executable, ["app-server"], {
                cwd: this.cwd,
                stdio: ["pipe", "pipe", "pipe"]
            });
            let settled = false;
            const onReady = () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.child = child;
                this.attachChild(child);
                resolve();
            };
            const onError = (error) => {
                if (settled) {
                    this.handleFatal(this.formatSpawnError(error));
                    return;
                }
                settled = true;
                reject(this.formatSpawnError(error));
            };
            child.once("spawn", onReady);
            child.once("error", onError);
        });
    }
    attachChild(child) {
        const stdoutRl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity
        });
        stdoutRl.on("line", (line) => {
            this.handleStdoutLine(line);
        });
        child.stderr.on("data", (chunk) => {
            process.stderr.write(`[codex] ${chunk.toString()}`);
        });
        child.on("exit", (code, signal) => {
            const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
            this.handleFatal(new Error(`codex app-server exited with ${detail}`));
        });
        child.on("error", (error) => {
            this.handleFatal(this.formatSpawnError(error));
        });
    }
    handleStdoutLine(line) {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch (error) {
            this.log(`Ignoring invalid JSON from codex app-server: ${String(error)}: ${trimmed}`);
            return;
        }
        if (this.isResponse(message)) {
            if (message.id === null) {
                return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            if ("error" in message) {
                pending.reject(new Error(this.describeRpcError(message.error)));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if (this.isRequest(message)) {
            this.emit("serverRequest", {
                id: message.id,
                method: message.method,
                params: message.params
            });
            return;
        }
        if (this.isNotification(message)) {
            this.emit("notification", {
                method: message.method,
                params: message.params
            });
            return;
        }
        this.log(`Ignoring unknown app-server message shape: ${trimmed}`);
    }
    async sendRequest(method, params) {
        const child = this.requireChild();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.write(child, {
                    jsonrpc: "2.0",
                    id,
                    method,
                    params
                });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    sendNotification(method, params) {
        const child = this.requireChild();
        this.write(child, {
            jsonrpc: "2.0",
            method,
            params
        });
    }
    sendResponse(id, result) {
        const child = this.requireChild();
        this.write(child, {
            jsonrpc: "2.0",
            id,
            result
        });
    }
    sendErrorResponse(id, code, message, data) {
        const child = this.requireChild();
        this.write(child, {
            jsonrpc: "2.0",
            id,
            error: {
                code,
                message,
                data
            }
        });
    }
    write(child, payload) {
        if (!child.stdin.writable) {
            throw new Error("codex app-server stdin is not writable");
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`);
    }
    requireChild() {
        if (this.closedError) {
            throw this.closedError;
        }
        if (!this.child) {
            throw new Error("codex app-server has not been started");
        }
        return this.child;
    }
    handleFatal(error) {
        if (this.closedError) {
            return;
        }
        this.closedError = error;
        this.initialized = false;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
        this.emit("fatalError", error);
    }
    describeRpcError(error) {
        if (error.data === undefined) {
            return `RPC ${error.code}: ${error.message}`;
        }
        return `RPC ${error.code}: ${error.message} (${JSON.stringify(error.data)})`;
    }
    formatSpawnError(error) {
        if (error.code === "ENOENT") {
            return new Error(`Could not start codex app-server because "${this.executable}" was not found. ` +
                `Set CODEX_EXECUTABLE or install the Codex CLI.`);
        }
        return new Error(`Failed to start codex app-server: ${error.message}`);
    }
    isRequest(message) {
        return "method" in message && "id" in message && !("result" in message) && !("error" in message);
    }
    isNotification(message) {
        return "method" in message && !("id" in message) && !("result" in message) && !("error" in message);
    }
    isResponse(message) {
        return "id" in message && ("result" in message || "error" in message);
    }
    log(message) {
        process.stderr.write(`[bridge] ${message}\n`);
    }
}
exports.CodexClient = CodexClient;
