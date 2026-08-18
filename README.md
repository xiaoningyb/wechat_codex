# 企业微信 ↔ 本机 Codex 桥接

一个只运行在当前 Mac 上的单用户桥接服务。企业微信智能机器人通过官方 WebSocket 长连接接收消息，程序通过本机 `codex app-server` 控制 Codex，并把流式结果、执行状态和审批请求返回企业微信。

## 快速交接给其他 Codex

让另一个 Codex 接手时，先读：

1. `AGENTS.md`：仓库级工作指引和安全边界。
2. `docs/ARCHITECTURE.md`：组件、数据流、持久化模型。
3. `docs/DEPLOY.md`：从零部署步骤。
4. `docs/RELEASE.md`：发布包构建和验收清单。

最短验证路径：

```bash
npm install
cp config.example.json config.json
./scripts/setup-keychain.zsh config.json
npm run doctor
npm run check
npm test
npm start
```

打包发布：

```bash
npm run pack:release
```

发布产物会生成在 `dist/`，不会包含 `config.json`、Secret、SQLite、日志、审计日志或 `node_modules`。

## 当前能力

- 企业微信单聊文本直接创建或继续 Codex 任务
- 任务执行中发送新文本，通过 `turn/steer` 加入补充指令
- 流式输出 Codex 回复，显示简要命令和文件修改状态
- 长任务无输出时会按 `progressIntervalMs` 更新原始流式状态消息；发送“是否运行结束”等状态查询不会再注入为补充指令
- `/停止` 中断执行，`/新建对话` 新建对话，`/选择对话` 管理允许目录内的历史线程
- `/发送 <线程ID或序号> <消息>` 通过 App Server 直接启动目标线程的新一轮任务
- 发送 `/选择对话` 时按项目聚合展示会话名和状态，会话序号在所有项目间全局连续；下一条输入序号进入对话后，再完整展示该对话最后一次用户输入和 Codex 输出
- 发送 `/新建对话` 会立即创建一个空白 Codex 线程，后续文字使用新的上下文
- 发送 `/选择模型` 会读取当前 ChatGPT/Codex 账号可用的模型；下一条输入序号即可选择
- 所有系统操作都必须以 `/` 开头，避免把普通对话误当成控制指令
- `/只读` 与 `/可写` 切换权限；可写范围严格限制在项目白名单
- 命令执行、文件修改以及额外文件系统/网络权限通过企业微信卡片批准或拒绝
- Codex 补充提问可直接在企业微信继续回答
- SQLite 保存用户、会话、消息排重、任务和审批状态
- 独立 JSONL 审计日志记录企业微信收发、Codex RPC、工具执行、审批和线程生命周期
- 本机只读管理后台实时展示审计日志流，并分页浏览 SQLite 表数据
- Secret 从 macOS 钥匙串读取；日志屏蔽 Secret、Token、`response_url` 和 AES key
- 系统命令输出使用企业微信 markdown，并包在 `text` fenced code block 中，避免不受支持的 HTML 标签污染消息
- WebSocket 自动重连，可选 LaunchAgent 登录后常驻

## 安全边界

1. 当前版本只处理机器人单聊，拒绝群聊控制。
2. `authorizedUsers` 为空时，数据库会把第一位发消息的人锁定为本机所有者。正式使用更建议在 `config.json` 中填入自己的企业微信 userid。
3. 默认只读。`/可写` 只允许写入当前项目白名单目录，网络默认关闭；越权动作由 Codex 发起审批。
4. 跨线程发送不会启动嵌套的 `codex exec resume` 子进程，目标线程的命令和权限审批直接回到同一个企业微信单聊；目标线程必须属于项目白名单。
5. 配置中不保存 Secret。此前在聊天或日志里出现过的 Secret 应先在企业微信后台刷新。
6. 审计日志包含完整对话和工具输出，虽然会脱敏常见密钥并将用户标识哈希化，仍应按敏感数据保护，不要上传或提交到 Git。
7. 同一机器人同一时间只运行一个 WebSocket 客户端。启动正式服务前先停止回声程序。
8. 管理后台只允许绑定本机回环地址，并拒绝异常 Host；没有任意 SQL 或数据库写入接口。

## 配置

编辑 `config.json`：

- `botId`：企业微信机器人 Bot ID，不是 Secret。
- `authorizedUsers`：允许控制本机的企业微信 userid；留空采用“首位用户锁定”。
- `projects`：Codex 可操作的项目白名单，路径必须是存在的绝对路径。
- `defaultProject`：默认项目 ID。
- `codexCommand`：本机 Codex CLI 的绝对路径。
- `model`、`effort`：桥接默认使用已在本机 ChatGPT 登录态验证的 `gpt-5.5`，避免继承不受该账户支持的模型；可按账户可用性调整，留空则使用当前 Codex 默认配置。
- `streamIntervalMs`：Codex 输出增量的流式刷新间隔，默认 900ms。
- `progressIntervalMs`：长任务没有新输出时主动发送进度通知的间隔，默认 30000ms，最低 5000ms。
- `auditLogDirectory`：审计日志目录；相对路径按 `config.json` 所在项目目录解析，默认 `./logs/audit`。
- `auditMaxFileBytes`：单个审计文件最大字节数，默认 50 MiB，超出后自动增加分卷序号。
- `auditRetentionDays`：审计文件保留天数，默认 30 天。
- `adminEnabled`：是否启动本机管理后台，默认 `true`。
- `adminHost`：管理后台监听地址，只接受 `127.0.0.1`、`::1` 或 `localhost`。
- `adminPort`：管理后台端口，默认 `17321`。

## 首次启动

先刷新曾经暴露过的机器人 Secret，然后保存到钥匙串：

```bash
./scripts/setup-keychain.zsh
```

启动并在企业微信验证：

```bash
npm start
```

向机器人发送 `/状态`，然后发送普通任务。需要修改时先发送 `/可写`；如果 Codex 请求额外权限，企业微信会收到审批卡片。

跨对话执行时，先发送 `/选择对话` 刷新序号，再发送 `/发送 1 更新水滴插件`。桥接程序会等待目标任务真正收到 `turn/completed` 后，才把最终结果发回企业微信。

交互式切换上下文：

1. 发送 `/选择对话`（兼容 `/threads`）。
2. 机器人列出所有允许目录中的 Codex 对话后，下一条只输入序号，例如 `2`。
3. 收到“已进入对话”后，后续普通文字都会继续使用该对话历史。

发送 `/新建对话`（兼容 `/new`）会立刻创建一个空白线程，而不是等到下一条任务才创建。
空白线程的第一条消息会先通过 `thread/loaded/list` 判断它是否仍在 App Server 内存中：已加载时直接开始首轮，不会错误调用 `thread/resume`；如果服务曾重启且空白线程尚无 rollout，桥接程序会自动创建替代空白线程后继续处理消息。

## 审计日志

审计日志采用每行一个 JSON 对象的 JSONL 格式，文件名为 `audit-YYYY-MM-DD.0001.jsonl`。记录范围包括：

- 企业微信原始入站事件、流式回复、主动消息和卡片更新
- Codex App Server 全部 JSON-RPC 请求、响应、通知与审批结果
- Agent 回复增量、最终回复、命令输出、文件变更、Diff、线程和 Turn 状态
- WebSocket、App Server 进程和桥接程序错误事件

文件夹权限为 `0700`，日志文件权限为 `0600`。用户标识和消息 ID 使用 SHA-256 摘要，Secret、Token、Authorization、Cookie、AES key 和 `response_url` 等常见凭据会脱敏。自由文本仍可能包含无法自动识别的业务敏感信息。

常驻服务的审计目录：

```text
logs/audit
```

查看当天第一卷日志：

```bash
tail -f logs/audit/audit-$(date +%F).0001.jsonl
```

## 管理后台

服务启动后，在同一台 Mac 的浏览器打开：

```text
http://127.0.0.1:17321
```

后台包含两个只读视图：

- **实时日志**：先载入最近的审计事件，再通过 SSE 持续接收新事件；支持暂停、清空当前显示和按事件名筛选。
- **SQLite 数据**：列出桥接数据库中的真实表，选择表后按页查看字段和记录。

对应接口为 `/api/status`、`/api/audit/recent`、`/api/audit/stream`、`/api/db/tables` 和 `/api/db/rows`。数据库接口只允许查询已存在的表，限制每页最大记录数，不接受任意 SQL，也不提供新增、修改或删除操作。

该页面刻意只监听本机回环地址，因此手机或其他电脑不能直接访问。页面会显示完整业务日志和数据库内容，请勿通过公网代理暴露。

## 常驻运行

```bash
./scripts/install-launch-agent.zsh
```

运行状态和 SQLite 数据位于 `~/Library/Application Support/wecom-codex-bridge`，服务日志在 `logs/bridge.log` 和 `logs/bridge-error.log`，审计日志在 `logs/audit/`。安装完成后可通过 `http://127.0.0.1:17321` 查看管理后台。卸载：

```bash
launchctl bootout "gui/$(id -u)/com.local.wecom-codex-bridge"
rm "$HOME/Library/LaunchAgents/com.local.wecom-codex-bridge.plist"
```

## 测试

```bash
npm run doctor
npm run check
npm test
node test/real-app-server.mjs
node test/real-bridge.mjs
node test/real-cross-thread.mjs
```

最后三个命令会创建真实的只读 Codex 测试线程，其中 `real-cross-thread.mjs` 会验证目标线程恢复、新一轮任务和真实完成回传。`src/echo.mjs` 和 `start-echo.zsh` 仅作为企业微信连通性排障工具保留，不能与正式服务同时运行。

## 发布包

```bash
npm run pack:release
```

产物：

```text
dist/wecom-codex-local-bridge-v<version>.tgz
dist/wecom-codex-local-bridge-v<version>.tgz.sha256
```

发布包内容和验收流程见 `docs/RELEASE.md`。
