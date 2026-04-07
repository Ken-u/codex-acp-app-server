import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { CodexClient, type CodexNotification, type CodexServerRequest } from "./codexClient";
import { SessionStore, type StoredSession } from "./sessionStore";

type JsonRpcId = number | string;

type AcpRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type StdinMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type SessionState = {
  threadId?: string;
  busy: boolean;
  cancelled?: boolean;
  modeId: "default" | "plan";
};

type MessageResult = {
  sessionId: string;
  threadId: string;
  turnId: string;
  status: string;
};

export class Bridge {
  private readonly client: CodexClient;
  private readonly store: SessionStore;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingClientRequests = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();
  private initialized = false;
  private stdinClosed = false;
  private activeRequests = 0;
  private nextClientRequestId = 1;
  constructor(client: CodexClient, cwd: string) {
    this.client = client;
    this.store = new SessionStore(cwd);
  }

  start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false
    });

    rl.on("line", (line: string) => {
      this.activeRequests += 1;
      void this.handleLine(line)
        .catch((error) => {
          this.log(`Failed to handle stdin line: ${this.toErrorMessage(error)}`);
        })
        .finally(() => {
          this.activeRequests -= 1;
          this.maybeShutdown();
        });
    });

    rl.on("close", () => {
      this.stdinClosed = true;
      this.maybeShutdown();
    });
  }

  stop(): void {
    this.stdinClosed = true;
    this.activeRequests = 0;
    this.client.close();
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: StdinMessage;
    try {
      message = JSON.parse(trimmed) as StdinMessage;
    } catch (error) {
      this.log(`Ignoring invalid stdin JSON: ${String(error)}: ${trimmed}`);
      return;
    }

    if (this.isClientResponse(message)) {
      this.handleClientResponse(message);
      return;
    }

    const request = message as AcpRequest;
    if (typeof request.id === "undefined" || typeof request.method !== "string") {
      this.log(`Ignoring invalid request envelope: ${trimmed}`);
      return;
    }

    try {
      switch (request.method) {
        case "initialize":
          await this.handleInitialize(request);
          break;
        case "message":
          await this.handleMessage(request);
          break;
        case "session/new":
          await this.handleSessionNew(request);
          break;
        case "session/prompt":
          await this.handleSessionPrompt(request);
          break;
        case "session/load":
          await this.handleSessionLoad(request);
          break;
        case "session/set_mode":
          await this.handleSessionSetMode(request);
          break;
        case "session/cancel":
          this.handleSessionCancel(request);
          break;
        default:
          this.writeError(request.id, -32601, `Unsupported method: ${request.method}`);
      }
    } catch (error) {
      this.writeError(request.id, -32000, this.toErrorMessage(error));
    }
  }

  private async handleInitialize(request: AcpRequest): Promise<void> {
    await this.client.initialize();
    this.initialized = true;

    this.writeResult(request.id, {
      protocolVersion:
        typeof request.params?.protocolVersion === "number" ? request.params.protocolVersion : 1,
      agentInfo: {
        name: "codex-acp-app-server",
        version: "0.1.0"
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: {}
      },
      protocol: "minimal-acp-jsonrpc",
      server: "codex-acp-app-server",
      version: "0.1.0",
      methods: {
        request: ["initialize", "message"],
        notification: ["message/started", "message/delta", "message/progress", "message/completed"]
      }
    });
  }

  private async handleSessionNew(request: AcpRequest): Promise<void> {
    if (!this.initialized) {
      this.writeError(request.id, -32002, "Bridge is not initialized");
      return;
    }

    const sessionId = `session-${randomUUID()}`;
    const session: SessionState = { busy: false, modeId: "default" };
    this.sessions.set(sessionId, session);
    await this.store.upsert(this.toStoredSession(sessionId, session));

    this.writeResult(request.id, {
      sessionId,
      modes: this.toModeState(session.modeId)
    });
  }

  private async handleSessionLoad(request: AcpRequest): Promise<void> {
    if (!this.initialized) {
      this.writeError(request.id, -32002, "Bridge is not initialized");
      return;
    }

    const sessionId = request.params?.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      this.writeError(request.id, -32602, "params.sessionId must be a non-empty string");
      return;
    }

    const stored = await this.store.get(sessionId);
    if (!stored) {
      this.writeError(request.id, -32004, `Unknown session: ${sessionId}`);
      return;
    }

    this.sessions.set(sessionId, {
      threadId: stored.threadId,
      busy: false,
      modeId: stored.modeId
    });

    this.writeResult(request.id, {
      sessionId,
      modes: this.toModeState(stored.modeId)
    });
  }

  private async handleSessionSetMode(request: AcpRequest): Promise<void> {
    if (!this.initialized) {
      this.writeError(request.id, -32002, "Bridge is not initialized");
      return;
    }

    const sessionId = request.params?.sessionId;
    const modeId = request.params?.modeId;
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      this.writeError(request.id, -32602, "params.sessionId must be a non-empty string");
      return;
    }

    if (modeId !== "default" && modeId !== "plan") {
      this.writeError(request.id, -32602, `Unsupported modeId: ${String(modeId)}`);
      return;
    }

    const session = await this.requireSession(sessionId);
    session.modeId = modeId;
    await this.store.upsert(this.toStoredSession(sessionId, session));

    this.writeNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: modeId
      }
    });

    this.writeResult(request.id, {});
  }

  private async handleSessionPrompt(request: AcpRequest): Promise<void> {
    if (!this.initialized) {
      this.writeError(request.id, -32002, "Bridge is not initialized");
      return;
    }

    const sessionId = request.params?.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      this.writeError(request.id, -32602, "params.sessionId must be a non-empty string");
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.writeError(request.id, -32004, `Unknown session: ${sessionId}`);
      return;
    }

    const text = this.extractPromptText(request.params?.prompt);
    if (!text) {
      this.writeError(request.id, -32602, "session/prompt requires at least one text content block");
      return;
    }

    if (session.busy) {
      this.writeError(request.id, -32001, `Session "${sessionId}" already has an active turn`);
      return;
    }

    session.cancelled = false;
    session.busy = true;

    try {
      await this.client.initialize();

      if (!session.threadId) {
        const started = await this.client.startThread();
        session.threadId = started.threadId;
        await this.store.upsert(this.toStoredSession(sessionId, session));
      }

      await this.runTurn(sessionId, session.threadId, text, {
        mode: "acp",
        userMessageId:
          typeof request.params?.messageId === "string" && request.params.messageId.trim() !== ""
            ? request.params.messageId
            : undefined,
        collaborationMode: session.modeId
      });

      this.writeResult(request.id, {
        stopReason: session.cancelled ? "cancelled" : "end_turn",
        userMessageId:
          typeof request.params?.messageId === "string" && request.params.messageId.trim() !== ""
            ? request.params.messageId
            : undefined
      });
    } finally {
      session.busy = false;
      session.cancelled = false;
    }
  }

  private handleSessionCancel(request: AcpRequest): void {
    const sessionId = request.params?.sessionId;
    if (typeof sessionId !== "string") {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.cancelled = true;
  }

  private async handleMessage(request: AcpRequest): Promise<void> {
    if (!this.initialized) {
      this.writeError(request.id, -32002, "Bridge is not initialized");
      return;
    }

    const text = request.params?.text;
    if (typeof text !== "string" || text.trim() === "") {
      this.writeError(request.id, -32602, "params.text must be a non-empty string");
      return;
    }

    const sessionId =
      typeof request.params?.sessionId === "string" && request.params.sessionId.trim() !== ""
        ? request.params.sessionId
        : "default";

    const session = this.getSession(sessionId);
    if (session.busy) {
      this.writeError(request.id, -32001, `Session "${sessionId}" already has an active turn`);
      return;
    }

    session.busy = true;

    try {
      await this.client.initialize();

      if (!session.threadId) {
        const started = await this.client.startThread();
        session.threadId = started.threadId;
        await this.store.upsert(this.toStoredSession(sessionId, session));
      }

      const result = await this.runTurn(sessionId, session.threadId, text, {
        mode: "minimal",
        collaborationMode: session.modeId
      });
      this.writeResult(request.id, result);
    } finally {
      session.busy = false;
    }
  }

  private async runTurn(
    sessionId: string,
    threadId: string,
    text: string,
    options: {
      mode: "minimal" | "acp";
      userMessageId?: string;
      collaborationMode: "default" | "plan";
    }
  ): Promise<MessageResult> {
    return new Promise<MessageResult>(async (resolve, reject) => {
      let turnId: string | undefined;
      const session = this.sessions.get(sessionId);

      const onNotification = (notification: CodexNotification) => {
        const params = notification.params ?? {};
        if (params.threadId !== threadId) {
          return;
        }

        switch (notification.method) {
          case "turn/started": {
            turnId = params.turn?.id ?? turnId;
            if (!turnId) {
              return;
            }

            if (options.mode === "minimal") {
              this.writeNotification("message/started", {
                sessionId,
                threadId,
                turnId
              });
            }
            break;
          }

          case "item/agentMessage/delta": {
            const incomingTurnId = params.turnId;
            if (turnId && incomingTurnId !== turnId) {
              return;
            }

            turnId = incomingTurnId ?? turnId;
            if (!turnId || typeof params.delta !== "string") {
              return;
            }

            if (options.mode === "minimal") {
              this.writeNotification("message/delta", {
                sessionId,
                threadId,
                turnId,
                delta: params.delta
              });
            } else {
              this.writeNotification("session/update", {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  messageId: turnId,
                  content: {
                    type: "text",
                    text: params.delta
                  }
                }
              });
            }
            break;
          }

          case "turn/plan/updated": {
            const incomingTurnId = params.turnId;
            if (turnId && incomingTurnId !== turnId) {
              return;
            }

            turnId = incomingTurnId ?? turnId;
            if (!turnId) {
              return;
            }

            if (options.mode === "minimal") {
              this.writeNotification("message/progress", {
                sessionId,
                threadId,
                turnId,
                text: this.formatPlan(params.explanation, params.plan)
              });
            } else {
              this.writeNotification("session/update", {
                sessionId,
                update: {
                  sessionUpdate: "plan",
                  entries: this.toAcpPlanEntries(params.plan)
                }
              });
            }
            break;
          }

          case "error": {
            const incomingTurnId = params.turnId;
            if (turnId && incomingTurnId !== turnId) {
              return;
            }

            cleanup();
            reject(new Error(this.formatTurnError(params.error)));
            break;
          }

          case "turn/completed": {
            const completedTurnId = params.turn?.id;
            if (turnId && completedTurnId !== turnId) {
              return;
            }

            turnId = completedTurnId ?? turnId;
            if (!turnId) {
              return;
            }

            const status = params.turn?.status?.type ?? "completed";
            const errorMessage =
              status === "failed" ? this.formatTurnError(params.turn?.error) : undefined;

            if (options.mode === "minimal") {
              this.writeNotification("message/completed", {
                sessionId,
                threadId,
                turnId,
                status,
                error: errorMessage
              });
            }

            cleanup();

            if (session?.cancelled) {
              resolve({
                sessionId,
                threadId,
                turnId,
                status: "cancelled"
              });
              return;
            }

            if (status === "failed") {
              reject(new Error(errorMessage ?? "turn failed"));
              return;
            }

            resolve({
              sessionId,
              threadId,
              turnId,
              status
            });
            break;
          }

          default:
            break;
        }
      };

      const onFatalError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onServerRequest = (request: CodexServerRequest) => {
        void this.handleCodexServerRequest(sessionId, threadId, turnId, request).catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const cleanup = () => {
        this.client.off("notification", onNotification);
        this.client.off("fatalError", onFatalError);
        this.client.off("serverRequest", onServerRequest);
      };

      this.client.on("notification", onNotification);
      this.client.on("fatalError", onFatalError);
      this.client.on("serverRequest", onServerRequest);

      try {
        const started = await this.client.startTurn(threadId, text, options.collaborationMode);
        turnId = started.turnId;
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private getSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { busy: false, modeId: "default" };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  private writeResult(id: JsonRpcId, result: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      result
    });
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message
      }
    });
  }

  private writeNotification(method: string, params: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  private write(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  private isClientResponse(message: StdinMessage): message is JsonRpcResponse {
    return typeof message.id !== "undefined" && typeof message.method === "undefined";
  }

  private handleClientResponse(message: JsonRpcResponse): void {
    const pending = this.pendingClientRequests.get(message.id);
    if (!pending) {
      this.log(`Ignoring unexpected client response for id ${String(message.id)}`);
      return;
    }

    this.pendingClientRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(this.describeJsonRpcError(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleCodexServerRequest(
    sessionId: string,
    threadId: string,
    turnId: string | undefined,
    request: CodexServerRequest
  ): Promise<void> {
    switch (request.method) {
      case "item/tool/requestUserInput": {
        const result = await this.collectUserInput(sessionId, threadId, turnId, request.params);
        this.client.sendResponse(request.id, result);
        return;
      }

      default:
        this.log(`Received unsupported server request: ${request.method}`);
        this.client.sendErrorResponse(request.id, -32601, `Unsupported server request: ${request.method}`);
    }
  }

  private async collectUserInput(
    sessionId: string,
    threadId: string,
    turnId: string | undefined,
    params: any
  ): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    if (questions.length === 0) {
      throw new Error("requestUserInput did not contain any questions");
    }

    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      if (!question || typeof question !== "object" || typeof question.id !== "string") {
        continue;
      }

      const response = await this.collectSingleAnswer(sessionId, threadId, turnId, question);
      answers[question.id] = {
        answers: response
      };
    }

    return { answers };
  }

  private async collectSingleAnswer(
    sessionId: string,
    threadId: string,
    turnId: string | undefined,
    question: any
  ): Promise<string[]> {
    if (Array.isArray(question.options) && question.options.length > 0) {
      return this.requestPermissionAnswer(sessionId, threadId, turnId, question);
    }

    return this.requestCustomUserInput(sessionId, threadId, turnId, question);
  }

  private async requestPermissionAnswer(
    sessionId: string,
    threadId: string,
    turnId: string | undefined,
    question: any
  ): Promise<string[]> {
    const permissionKinds = [
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always"
    ] as const;
    const options = question.options
      .map((option: any, index: number) => {
        if (
          !option ||
          typeof option !== "object" ||
          typeof option.label !== "string" ||
          index >= permissionKinds.length
        ) {
          return null;
        }

        return {
          optionId: `choice-${index}`,
          name: option.label,
          kind: permissionKinds[index],
          _meta:
            typeof option.description === "string" && option.description.trim() !== ""
              ? { description: option.description }
              : undefined
        };
      })
      .filter(
        (
          option: unknown
        ): option is {
          optionId: string;
          name: string;
          kind: (typeof permissionKinds)[number];
          _meta?: { description: string };
        } => Boolean(option)
      );

    if (options.length === 0) {
      return this.requestCustomUserInput(sessionId, threadId, turnId, question);
    }

    const permissionResult = (await this.sendClientRequest("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: `request-user-input:${question.id}`,
        title: typeof question.question === "string" ? question.question : "User input requested",
        kind: "other",
        status: "pending",
        rawInput: {
          threadId,
          turnId,
          question
        }
      },
      options
    })) as {
      outcome?: {
        outcome?: string;
        optionId?: string;
      };
    };

    const outcome = permissionResult?.outcome?.outcome;
    if (outcome !== "selected") {
      throw new Error(`User input request was not completed: ${outcome ?? "cancelled"}`);
    }

    const selected = options.find(
      (option: {
        optionId: string;
        name: string;
        kind: (typeof permissionKinds)[number];
        _meta?: { description: string };
      }) =>
        option.optionId === permissionResult.outcome?.optionId
    );
    if (!selected) {
      throw new Error("User input request returned an unknown option");
    }

    return [selected.name];
  }

  private async requestCustomUserInput(
    sessionId: string,
    threadId: string,
    turnId: string | undefined,
    question: any
  ): Promise<string[]> {
    const result = (await this.sendClientRequest("_codex/request_user_input", {
      sessionId,
      threadId,
      turnId,
      question
    })) as {
      answers?: string[];
    };

    if (!result || !Array.isArray(result.answers) || result.answers.length === 0) {
      throw new Error("User input request returned no answers");
    }

    return result.answers.filter((answer): answer is string => typeof answer === "string" && answer.trim() !== "");
  }

  private sendClientRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextClientRequestId++;

    return new Promise<unknown>((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject });
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        params
      });
    });
  }

  private describeJsonRpcError(error: { code: number; message: string; data?: unknown }): string {
    if (typeof error.data === "undefined") {
      return `RPC ${error.code}: ${error.message}`;
    }

    return `RPC ${error.code}: ${error.message} (${JSON.stringify(error.data)})`;
  }

  private formatPlan(explanation: unknown, plan: unknown): string {
    const parts: string[] = [];

    if (typeof explanation === "string" && explanation.trim() !== "") {
      parts.push(explanation.trim());
    }

    if (Array.isArray(plan)) {
      for (const item of plan) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const status = typeof item.status === "string" ? item.status : "pending";
        const step = typeof item.step === "string" ? item.step : "";
        if (step) {
          parts.push(`[${status}] ${step}`);
        }
      }
    }

    if (parts.length === 0) {
      return "[plan] updated";
    }

    return `[plan] ${parts.join(" | ")}`;
  }

  private formatTurnError(error: any): string {
    if (!error || typeof error !== "object") {
      return "turn failed";
    }

    const parts = [
      typeof error.message === "string" ? error.message : undefined,
      typeof error.additionalDetails === "string" ? error.additionalDetails : undefined
    ].filter((value): value is string => Boolean(value && value.trim()));

    return parts.length > 0 ? parts.join(" | ") : "turn failed";
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async requireSession(sessionId: string): Promise<SessionState> {
    let session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }

    const stored = await this.store.get(sessionId);
    if (!stored) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    session = {
      threadId: stored.threadId,
      busy: false,
      modeId: stored.modeId
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private toStoredSession(sessionId: string, session: SessionState): StoredSession {
    return {
      sessionId,
      threadId: session.threadId,
      modeId: session.modeId,
      cwd: process.cwd(),
      updatedAt: new Date().toISOString()
    };
  }

  private toModeState(currentModeId: "default" | "plan"): {
    currentModeId: "default" | "plan";
    availableModes: Array<{ id: "default" | "plan"; name: string; description: string }>;
  } {
    return {
      currentModeId,
      availableModes: [
        {
          id: "default",
          name: "Default",
          description: "Standard collaboration mode"
        },
        {
          id: "plan",
          name: "Plan",
          description: "Plan-first collaboration mode"
        }
      ]
    };
  }

  private extractPromptText(prompt: unknown): string {
    if (!Array.isArray(prompt)) {
      return "";
    }

    const texts: string[] = [];
    for (const block of prompt) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        texts.push(block.text);
      }
    }

    return texts.join("\n").trim();
  }

  private toAcpPlanEntries(plan: unknown): Array<{ content: string; priority: "medium"; status: string }> {
    if (!Array.isArray(plan)) {
      return [];
    }

    const entries: Array<{ content: string; priority: "medium"; status: string }> = [];
    for (const item of plan) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const content = typeof item.step === "string" ? item.step : "";
      const status = typeof item.status === "string" ? item.status : "pending";
      if (!content) {
        continue;
      }

      entries.push({
        content,
        priority: "medium",
        status
      });
    }

    return entries;
  }

  private log(message: string): void {
    process.stderr.write(`[bridge] ${message}\n`);
  }

  private maybeShutdown(): void {
    if (!this.stdinClosed || this.activeRequests > 0) {
      return;
    }

    this.client.close();
  }
}
