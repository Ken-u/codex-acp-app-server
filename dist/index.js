#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bridge_1 = require("./bridge");
const codexClient_1 = require("./codexClient");
const client = new codexClient_1.CodexClient({
    executable: process.env.CODEX_EXECUTABLE || "codex",
    model: process.env.CODEX_MODEL || "gpt-5.4",
    cwd: process.env.CODEX_CWD || process.cwd()
});
const bridge = new bridge_1.Bridge(client, process.env.CODEX_CWD || process.cwd());
bridge.start();
const shutdown = () => {
    bridge.stop();
    setTimeout(() => {
        process.exit(130);
    }, 50).unref?.();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
