#!/usr/bin/env node

import { Bridge } from "./bridge";
import { CodexClient } from "./codexClient";

const client = new CodexClient({
  executable: process.env.CODEX_EXECUTABLE || "codex",
  model: process.env.CODEX_MODEL || "gpt-5.4",
  cwd: process.env.CODEX_CWD || process.cwd()
});

const bridge = new Bridge(client, process.env.CODEX_CWD || process.cwd());
bridge.start();

const shutdown = () => {
  bridge.stop();
  setTimeout(() => {
    process.exit(130);
  }, 50).unref?.();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
