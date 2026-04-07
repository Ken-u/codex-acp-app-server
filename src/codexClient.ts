import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

type JsonRpcId = number | string;

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc?: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type CodexClientOptions = {
  executable: string;
  model: string;
  cwd: string;
};

export type CodexNotification = {
  method: string;
  params?: any;
};

export type CodexServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: any;
};

type ThreadStartResult = {
  thread: {
    id: string;
  };
};

type TurnStartResult = {
  turn: {
    id: string;
  };
};

export class CodexClient extends EventEmitter {
  private readonly executable: string;
  private readonly model: string;
  private readonly cwd: string;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private initialized = false;
  private initializePromise?: Promise<void>;
  private closedError?: Error;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(options: CodexClientOptions) {
    super();
    this.executable = options.executable;
    this.model = options.model;
    this.cwd = options.cwd;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.bootstrap();
    }

    return this.initializePromise;
  }

  async startThread(): Promise<{ threadId: string }> {
    await this.initialize();

    const result = (await this.sendRequest("thread/start", {
      cwd: this.cwd,
      model: this.model,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
      persistExtendedHistory: false
    })) as ThreadStartResult;

    return { threadId: result.thread.id };
  }

  async startTurn(
    threadId: string,
    text: string,
    collaborationMode: "default" | "plan" = "default"
  ): Promise<{ turnId: string }> {
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
    })) as TurnStartResult;

    return { turnId: result.turn.id };
  }

  close(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  private async bootstrap(): Promise<void> {
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

  private async spawnChild(): Promise<void> {
    if (this.child) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, ["app-server"], {
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

      const onError = (error: NodeJS.ErrnoException) => {
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

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    const stdoutRl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    stdoutRl.on("line", (line: string) => {
      this.handleStdoutLine(line);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      process.stderr.write(`[codex] ${chunk.toString()}`);
    });

    child.on("exit", (code: number | null, signal: string | null) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleFatal(new Error(`codex app-server exited with ${detail}`));
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      this.handleFatal(this.formatSpawnError(error));
    });
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (error) {
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
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (this.isRequest(message)) {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params
      } satisfies CodexServerRequest);
      return;
    }

    if (this.isNotification(message)) {
      this.emit("notification", {
        method: message.method,
        params: message.params
      } satisfies CodexNotification);
      return;
    }

    this.log(`Ignoring unknown app-server message shape: ${trimmed}`);
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const child = this.requireChild();
    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      try {
        this.write(child, {
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const child = this.requireChild();
    this.write(child, {
      jsonrpc: "2.0",
      method,
      params
    });
  }

  sendResponse(id: JsonRpcId, result: unknown): void {
    const child = this.requireChild();
    this.write(child, {
      jsonrpc: "2.0",
      id,
      result
    });
  }

  sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): void {
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

  private write(child: ChildProcessWithoutNullStreams, payload: unknown): void {
    if (!child.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }

    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (this.closedError) {
      throw this.closedError;
    }

    if (!this.child) {
      throw new Error("codex app-server has not been started");
    }

    return this.child;
  }

  private handleFatal(error: Error): void {
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

  private describeRpcError(error: { code: number; message: string; data?: unknown }): string {
    if (error.data === undefined) {
      return `RPC ${error.code}: ${error.message}`;
    }

    return `RPC ${error.code}: ${error.message} (${JSON.stringify(error.data)})`;
  }

  private formatSpawnError(error: NodeJS.ErrnoException): Error {
    if (error.code === "ENOENT") {
      return new Error(
        `Could not start codex app-server because "${this.executable}" was not found. ` +
          `Set CODEX_EXECUTABLE or install the Codex CLI.`
      );
    }

    return new Error(`Failed to start codex app-server: ${error.message}`);
  }

  private isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return "method" in message && "id" in message && !("result" in message) && !("error" in message);
  }

  private isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
    return "method" in message && !("id" in message) && !("result" in message) && !("error" in message);
  }

  private isResponse(message: JsonRpcMessage): message is JsonRpcSuccess | JsonRpcFailure {
    return "id" in message && ("result" in message || "error" in message);
  }

  private log(message: string): void {
    process.stderr.write(`[bridge] ${message}\n`);
  }
}
