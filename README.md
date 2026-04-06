# codex-acp-app-server

一个最小的 ACP over stdio bridge，后端通过 `codex app-server` 驱动。

数据流：

```text
ACP client / ACPX
  -> 本程序
  -> codex app-server
```

## 要求

- Node.js 18+
- 已安装并可执行 `codex`

## 本地运行

```bash
npm install
npm run compile
node dist/index.js
```

## 直接从 GitHub 运行

```bash
npx github:Ken-u/codex-acp-app-server
```

指定工作目录：

```bash
CODEX_CWD=/absolute/path/to/workspace \
npx github:Ken-u/codex-acp-app-server
```

## 环境变量

- `CODEX_EXECUTABLE`，默认 `codex`
- `CODEX_MODEL`，默认 `gpt-5.4`
- `CODEX_CWD`，默认当前目录

## 协议

标准输入按行读取 JSON，标准输出按行写 JSON。

- `stdout` 只输出协议消息
- 日志只写 `stderr`

最小支持：

- `initialize`
- `message`

兼容 ACPX 的最小会话方法：

- `session/new`
- `session/load`
- `session/prompt`
- `session/set_mode`
- `session/cancel`
- `session/update`

会话映射保存在：

```text
CODEX_CWD/.codex-acp-app-server/sessions.json
```

## 验证

确认 `codex app-server` 可运行：

```bash
codex app-server --help
```

手动测试：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"manual-test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"message","params":{"sessionId":"demo","text":"say hello in one sentence"}}' \
  | node dist/index.js
```

ACPX 测试：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  exec 'hello'
```

## 说明

- 仓库内已提交 `dist/`
- CLI 入口是 `dist/index.js`
- 当前版本只做最小实现，不覆盖完整 ACP 规范
