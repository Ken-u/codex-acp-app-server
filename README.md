# codex-acp-app-server

一个最小可用的 ACP over stdio bridge。它把上游 ACP client 或 ACPX 的 session/prompt 请求，转成对 `codex app-server` 的 `thread/start` 和 `turn/start` 调用，并把 app-server 的流式事件重新输出为 ACP/JSON-RPC 通知。

- 语言：TypeScript + Node.js
- 后端：`codex app-server` over stdio JSON-RPC
- 目标：最小可运行、可验证、可被 ACPX 驱动

## 目录结构

```text
codex-acp-app-server/
├── package.json
├── tsconfig.json
├── README.md
└── src
    ├── bridge.ts
    ├── codexClient.ts
    ├── index.ts
    ├── sessionStore.ts
    └── shims-node.d.ts
```

## 最小协议假设

ACP 细节这里按“最小可运行假设”实现：

1. 传输层是 `stdin/stdout` 的逐行 JSON。
2. 报文格式按 JSON-RPC 2.0 风格处理。
3. 只实现两个请求方法：
   - `initialize`
   - `message`
4. 只实现四个通知方法：
   - `message/started`
   - `message/delta`
   - `message/progress`
   - `message/completed`
5. 一个 `sessionId` 在 bridge 进程内只绑定一个 `threadId`，仅保存在内存里。

这不是完整 ACP 规范实现，只是为了让外部 agent 宿主能够最小接通。

额外补充：

- 对 ACPX 兼容的最小方法还实现了：
  - `session/new`
  - `session/load`
  - `session/prompt`
  - `session/set_mode`
  - `session/cancel`
  - `session/update`
- bridge 会在工作区下保存 `acpSessionId -> codex threadId` 映射：
  - `CODEX_CWD/.codex-acp-app-server/sessions.json`

## 环境变量

- `CODEX_EXECUTABLE`：默认 `codex`
- `CODEX_MODEL`：默认 `gpt-5.4`
- `CODEX_CWD`：默认 `process.cwd()`

## 安装与构建

```bash
npm install
npm run build
node dist/index.js
```

## 直接从 GitHub 使用

当前推荐直接从 GitHub 仓库安装或运行：

全局安装：

```bash
npm install -g github:Ken-u/codex-acp-app-server
codex-acp-app-server
```

一次性运行：

```bash
npx github:Ken-u/codex-acp-app-server
```

配合环境变量：

```bash
CODEX_EXECUTABLE=codex \
CODEX_MODEL=gpt-5.4 \
CODEX_CWD=/absolute/path/to/workspace \
codex-acp-app-server
```

包里已经配置了 `bin` 入口，所以以后如果发布到 npm，也可以直接作为 CLI 使用。

## GitHub 全局安装验证

先做本地构建验证：

```bash
npm install
npm run build
node dist/index.js
```

然后验证 GitHub 直接全局安装：

```bash
npm uninstall -g codex-acp-app-server || true
npm install -g github:Ken-u/codex-acp-app-server
which codex-acp-app-server
codex-acp-app-server
```

预期现象：

- `npm install -g github:Ken-u/codex-acp-app-server` 能成功完成
- `which codex-acp-app-server` 能输出全局命令路径
- `codex-acp-app-server` 能直接启动

如果命令仍不可用，按下面步骤排查：

```bash
npm root -g
ls -la "$(npm root -g)/codex-acp-app-server"
cat "$(npm root -g)/codex-acp-app-server/package.json"
ls -la /opt/homebrew/bin | grep codex-acp-app-server
```

重点检查：

- 全局安装目录里是否存在 `dist/index.js`
- 全局安装目录里的 `package.json` 是否保留了正确的 `bin` 配置
- Homebrew 的全局可执行目录里是否生成了 `codex-acp-app-server` 链接

## bridge 行为

上游发送一条 `message` 请求后，bridge 会：

1. 确保已经对 `codex app-server` 做过 `initialize` 和 `initialized`
2. 如果当前 `sessionId` 还没有 `threadId`，先调用 `thread/start`
3. 再调用 `turn/start`
4. 把以下 app-server 事件转成 ACP 通知
   - `item/agentMessage/delta` -> `message/delta`
   - `turn/plan/updated` -> `message/progress`
   - `turn/completed` -> `message/completed`

所有日志都写到 `stderr`，`stdout` 只输出协议 JSON。

## 1. 如何确认 codex app-server 可运行

先直接验证 `codex` 本身：

```bash
codex app-server --help
```

再验证最小握手：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}' \
  '{"jsonrpc":"2.0","method":"initialized"}' \
  | codex app-server
```

预期能看到一条带 `id: 1` 的初始化结果 JSON。

如果报 `codex` 不存在，bridge 也会返回明确错误：

```text
Could not start codex app-server because "codex" was not found. Set CODEX_EXECUTABLE or install the Codex CLI.
```

## 2. 如何手动 pipe 一条 JSON 到 stdin 测试

先启动 bridge：

```bash
node dist/index.js
```

另一个终端里直接 pipe 两行 JSON：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"manual-test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"message","params":{"sessionId":"demo","text":"请用一句话自我介绍"}}' \
  | node dist/index.js
```

也可以先初始化，再交互输入：

```bash
node dist/index.js
```

然后手动输入：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"manual-test","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"message","params":{"sessionId":"demo","text":"请用一句话自我介绍"}}
```

## 3. 示例输入输出

输入：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"manual-test","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"message","params":{"sessionId":"demo","text":"say hello in one sentence"}}
```

可能输出：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocol":"minimal-acp-jsonrpc","server":"codex-acp-app-server","version":"0.1.0","methods":{"request":["initialize","message"],"notification":["message/started","message/delta","message/progress","message/completed"]}}}
{"jsonrpc":"2.0","method":"message/started","params":{"sessionId":"demo","threadId":"019d...","turnId":"019d..."}}
{"jsonrpc":"2.0","method":"message/progress","params":{"sessionId":"demo","threadId":"019d...","turnId":"019d...","text":"[plan] [in_progress] Respond to the user"}}
{"jsonrpc":"2.0","method":"message/delta","params":{"sessionId":"demo","threadId":"019d...","turnId":"019d...","delta":"Hello"}}
{"jsonrpc":"2.0","method":"message/delta","params":{"sessionId":"demo","threadId":"019d...","turnId":"019d...","delta":" there."}}
{"jsonrpc":"2.0","method":"message/completed","params":{"sessionId":"demo","threadId":"019d...","turnId":"019d...","status":"completed"}}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"demo","threadId":"019d...","turnId":"019d...","status":"completed"}}
```

如果上游发来非法 JSON，bridge 会忽略该行并把错误写到 `stderr`，不会污染 `stdout`。

## 4. 可选：Zed custom external agent 配置示例

如果你要把它当成自定义外部 agent，大致可以参考：

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/codex-acp-app-server/dist/index.js"
  ],
  "env": {
    "CODEX_EXECUTABLE": "codex",
    "CODEX_MODEL": "gpt-5.4",
    "CODEX_CWD": "/absolute/path/to/workspace"
  }
}
```

具体字段名取决于你的宿主程序，这里只给进程启动方式。

## 5. 用 ACPX 验证

本项目现在兼容 ACPX 运行时最小必需方法：

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/set_mode`
- `session/cancel`
- `session/update`（通知）

直接验证命令：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  exec 'hello'
```

在我的本机上，ACPX 已经成功完成：

1. `initialize`
2. `session/new`
3. `session/prompt`

随后失败在底层 `codex app-server` 联网阶段，错误类似：

```text
stream disconnected before completion: failed to lookup address information
```

这说明：

- ACPX 对接已生效
- bridge 已被 ACPX 正常驱动
- 当前剩余问题是 Codex 侧网络或鉴权环境，不是 ACPX 协议层问题

### ACPX 多 session 与 `set-mode plan` 验证

创建两个命名 session：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  sessions new --name alpha

acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  sessions new --name beta
```

查看本地 session 列表：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  sessions
```

给 `alpha` 设置 `plan` mode：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --format json \
  --json-strict \
  set-mode -s alpha plan
```

然后分别验证：

```bash
acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --verbose \
  prompt -s alpha 'hello from alpha after set-mode'

acpx --agent 'node /absolute/path/to/codex-acp-app-server/dist/index.js' \
  --verbose \
  prompt -s beta 'say current mode in one line'
```

预期现象：

- `alpha` 会先走 `session/load`
- `alpha` 的回答应体现 `plan` 模式
- `beta` 应保持 `default` 模式

## License

MIT
- `alpha` 的回答表现为 `plan` 模式
- `beta` 仍保持 `default` 模式
