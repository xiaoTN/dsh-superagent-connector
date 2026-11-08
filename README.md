# Superagent Connector

[English](<README.en.md>) · 简体中文

**在 DSH 原生聊天界面操作真实 WSL SuperAgent，让工单出现在已经安装的任务看板里。不是普通助手改名，也不是另一套看板。**

> 本文对应计划正式发布的 **0.4.3**；正式标签和可安装归档以 Release 为准。0.4.0/0.4.1 仅为本机 staging，未发布公开标签。非官方、早期软件，仅面向单机、单个 DSH 所有者和单个 SuperAgent 仓库。现有 worker 的命令、root、GitHub、推送及合并权限不会被本插件降低。请先阅读[安全说明](<SECURITY.md>)。

## 现在如何工作

- **SuperAgent 入口**使用真实 Controller `SessionReference`、原生 Session Provider 和 `conversation.content` Factory：复用原生 Lexical 输入、队列、消息及附件呈现，不复制一个 textarea。
- 本机注册的是 **Source-backed structural Agent**，不是普通 AgentLoop、模型 provider 或伪造 Session。真正的授权、路由、工单和 worker 仍在 WSL SuperAgent；本机会话只是它的操作与观察面。
- 真实人工输入保留为 `user/message`；Source 回复保留为有明确 `customSource` 的事件，不伪造模型 token、工具调用或执行记录。实际 Source ports 的 `kind` 为 `acknowledgement` / `reply` / `notice`；旧消息没有 `kind` 时保留 `delivery`，不根据正文猜测。
- **原任务看板**继续使用 `@linxin666/dsh-client-ui-task-board` 的卡片、分列、搜索和详情。以实例 + 真实 `ticket.id` 更新原卡；同步、刷新或读取记录不会创建本地 execution。
- 飞书、GitHub 原入口保留；客户端不伪造飞书消息，不展示混合来源的 Main/coordinator 历史。

```text
Windows DSH：原生 SessionReference → Provider → Conversation Factory
             ↓ 真实人工输入 / 单独持久化 outbox
             ↓ 受认证的固定 loopback 传输；附件传真实 bytes
WSL Source：授权 → prepare → Source.atomic（Trigger + 会话日志）→ commit
             ↓ 真实 SuperAgent 路由 / 工单 / worker → Source 回复
Windows DSH：Source 事件及附件恢复 → 原生消息显示
原任务看板：仅同步真实工单状态；中央执行保护仍独立生效
```

### 输入、历史与不确定结果

**Enter 排队发送，Shift+Enter 换行**，也可点原生发送按钮。`accepted` 只表示接收，不表示完成，也不保证创建新工单；SuperAgent 可直接答复、继续已有工单或创建工单。

本机在原生收件成功前同步保存独立 outbox；在任何上传/提交副作用前将请求标记为 `unknown`。丢失回执、断线或重启后只与 Source 对账，**不自动重传已不确定的请求**。保留同一请求身份与有序附件，不能换正文后复用 requestId。outbox 当前最多 **256 个请求 / 10 MiB**，超额拒绝新收件，不静默删消息；不要通过删除 outbox 来“修复”未知结果。

Source 会话 journal 是确认历史的事实来源，不再截断为 2000 条；按序分页读取，每页至多 **200 条**，另受字节预算约束。2000 条上限仅保留在旧版 rollback 镜像，不是原生对话历史上限。Facade 重开从 Source 恢复，不能从 outbox 伪造已确认回复；未加载/离线时拒绝发送，不回退普通助手。当前默认 UI 仍打开项目 `main` 对话，不能视为多实例或多租户会话管理器。

### 回复与话题

`acknowledgement`、`reply` 以及工单级结果都显示飞书话题式的引用块（左侧色条、原消息文字和时间），不再只靠消息顺序猜测回复对象。点击引用块会在对话右侧打开上下文分屏：全高列、带右侧栏式标签条、可拖动左边缘调整宽度；显示这条消息及其前后的已确认内容，并提供一个只针对这段上下文的输入框；发送时把该消息的引用作为正文的一部分交给 Source（当前 Source 没有独立 thread 字段），沿用原生输入/outbox 链路，不创建本地工单、不改写历史。直接答复按回复事件的确定性 id 与 Source 历史中的 Trigger/消息 id 匹配；工单级结果（如最终完成通知）没有直接的消息 id，就引用同一工单已绑定的人消息（优先发起该工单的那条），保持同一种话题样式。即使先后收到多条消息、答复晚到，也不会引错；旧消息或 id 无法解析时宁可不显示引用，不做位置猜测。该解析只在客户端读取已确认历史，不新增请求、不修改 Source 记录。

### 真正的图片与文件

附件链路为：原生 FileUploads → 本机持久 ref → 读取真实 bytes → WSL Source **新** receipt → prepare → Source 原子收件 → commit → 受控 worker 的真实只读文件路径。

- 浏览器/Windows receipt 只在原本机 Session 内准入，不能跨机复用。图片可能由原生存储规范化，例如 PNG 变为 WebP；传输必须使用真实已存 bytes 与对应 MIME，不改 MIME 冒充图片。
- Source 绑定 owner、conversation、request、message；每文件 **20 MiB**、每请求最多 **10 个 / 100 MiB**，默认仓库总量 500 MiB / 1000 个。支持真实 PNG/JPEG/WebP/GIF 头校验；不支持格式、伪 MIME 和超限均真实报错。普通文件不自动冒充可读图片。
- `prepare` 的精确消息绑定可供服务端在 Source 原子提交前构造 worker 文件引用；`commit` 仍在原子收件之后。prepared 文件被固定保留，以恢复提交成功但文件 commit 前的崩溃窗口；草稿 TTL 清理不删除已提交文件。
- Source `threadContext.image` 检查该 Source 消息的附件归属、**实际正在使用的模型**及图像模态，再真实调用附件存储 `saveImage`。不支持图像的模型会拒绝，不会谎称“已看图”；worker 也可按真实路径使用 `read_image`。
- 恢复历史时读取 Source 已提交文件，验证 receipt、长度及 SHA-256，再真实导入本机附件存储，生成本机 ref；不制造一个没有 bytes 的预览引用。

### Stop、继续与执行记录

Stop 是**非终结中断**：保留工单、Assignment、worker Session、目录和分支，不等于关闭工单或创建一次 retry。操作必须携带当前 `expectedAssignmentId` 和 `expectedControlSeq`；旧代际请求冲突，不能误停已继续的执行。有多个候选工单时明确选择，不将一个 Stop 扩大为全局停止。

`paused` 只证明持久 hold 已提交；只有 `interruption: settled` 才证明真实取消已完成。取消尚为 `requested` 或失败时不能继续；HTTP 等待被取消也不等于 worker 已停。卸载、刷新或关闭页面只停止本机观察，不隐式中断 WSL 工作。

执行记录是 Source 授权到真实 ticket/worker 的 **cold、限量投影**，不会激活冷 Agent，也不混入 Main 历史。每次只读一页，最多 100 条 / 128 KiB，保留原 seq/time 和游标；过滤后的空页不代表没有历史，不把投影转换成伪原生模型/工具事件。

### 明确不支持的原生控制

模型/推理设置、权限、steer、approval、Plan、Goal、本地命令、上下文注入、标题 LLM 刷新和 fork 等没有对应 Source 语义，当前均不可用；模型和权限不跟随 Native 全局设置。输入仅走排队模式。

RC.1 没有官方原生 per-session capability 接口；当前采用 **Source 范围的 DOM/ARIA 兼容 shim** 隐藏/拒绝相关入口并在操作面校验，Host 同时拒绝不支持的动作。这不是 SDK 原生 capability，也不是权限沙箱；升级 DSH 后必须重新验证，不能只靠隐藏按钮保障安全。普通 DSH 会话不受这套 Source 范围 UI 适配影响。

## 界面与验证状态

[旧版 v0.2 简化聊天截图](<docs/images/chat.png>)仅为历史资料，**不是** 0.4.3 原生 Conversation 截图或验收证据。

![历史截图：沿用已有任务看板，不是新建看板](<docs/images/native-board.png>)

真实 RC.1 SDK suite **24/24 通过**。另在现有 Windows GUI 实测通过：原生输入→Source 正式答复；真实文本和图片附件被 WSL 读取并返回独有内容、颜色与尺寸；所选验证工单在准备阶段中断确认 settled 后继续，保留同一 Assignment、worker Session 与目录，最终由执行器正常完成；界面只读显示 46 条带原始序号/时间的真实记录。浏览器无页面错误。完整边界与复现入口见[实机验证记录](<docs/native-verification.md>)；隔离 SDK 证明与真实 GUI 证据分开计数。

## 必需环境与两个不同补丁

- DSH **0.2.2-rc.1**，Node **22.19+ / 24+**。
- 已安装的任务看板 **`@linxin666/dsh-client-ui-task-board` 0.4.15**。
- 已配置仓库、模型及执行环境的 [Superagent 原型](<https://github.com/deepseek-ai/dsh-superagent-prototype>)；初始组合为 Windows desktop + WSL SuperAgent（固定 IPv4 loopback origin，例 `http://127.0.0.1:3082`）。

**1. 原看板中央执行保护，保持不变。** 0.4.15 没有外部执行归属的官方 run-veto 接口。[保护模块](<src/native-guard.js>)和[安装脚本](<scripts/install-native-guard.mjs>)只接受精确发布文件 SHA-256，在中央 `startRun` 创建 execution 前拒绝 SuperAgent 外部卡片的运行、重跑、返工、定时及含外部后代的父派发。换 preset 或停用 connector 不移除已安装保护。原 Run 按钮仍可能显示并明确拒绝；未知 preset 只是备用保险，不是安全边界。备份位于 `$DSH_HOME/superagent-connector-backup`；补丁修改原看板插件，不修改 DSH 核心/桌面 shell。

**2. WSL Source 上游执行能力补丁。** [部署说明](<integration-patches/README.execution.md>)面向 upstream **`8c32a9d`**。必须先审阅、应用补丁并 typecheck/test/build，然后在服务 **idle、无活动执行时真正 reload**。仅升级 connector、仅打包或仅构建，都不会让正在运行的 Source 获得执行能力。未实际加载 `context.execution.version === 1` 时 Stop/Resume/执行记录保持不可用，不能用终结工单代替中断。

## 安装与升级

尚未发布 npm；使用仓库或经确认的 Release 归档，不安装来源不明同名包。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
```

1. 按[Source 补丁说明](<integration-patches/README.execution.md>)应用、构建上游，并在 idle 时 reload；核实实际运行能力，而不只是文件已更新。
2. 原任务看板无活动 execution 时运行 `node scripts/install-native-guard.mjs`，随后 reload 原看板 Host 插件。脚本读取 `DSH_PROFILE_DIR`，或默认 `~/.dsh/profiles/desktop`。
3. Windows 和 WSL 安装**同一版本** connector 归档；WSL 用户覆盖层启用 Source、禁用桌面 connector：

   ```yaml
   - id: superagent-connector
     disabled: true
   - id: superagent-desktop-source
     disabled: false
   ```

4. 在两端私有文件保存相同的 32 字节随机桥接密钥（64 个十六进制字符）：Windows `.dsh/superagent-board-token`；WSL `.config/dsh-superagent-board/token`。只允许相应 OS 账号读取，不放入浏览器、命令行、仓库或聊天。
5. `desktop-inbox` 的 Source allowlist 仅允许 `desktop-owner`，不要扩大飞书/GitHub 名单。reload 对应模块、刷新现有 GUI，在原生 SuperAgent 对话中验证实际连接与能力。

桌面配置示例：

```yaml
- id: superagent-connector
  config:
    url: http://127.0.0.1:3082
    tokenFile: C:\Users\YOUR_NAME\.dsh\superagent-board-token
```

不提供任意 URL 转发或自动启停 WSL。一次插件升级不应自动中断正在运行的工单。

## 名称、工单与开发

**名称设置**保存独立 SuperAgent 实例名（默认 SuperAgent，1–80 个 Unicode 字符）；权威记录在 WSL Source，不借用飞书机器人名。保存带 revision 校验，不发送消息、不创建 Trigger/工单/worker；离线保留上次名称，历史正文不被改写。

看板列是粗粒度投影：工作中 → 进行中，排队 → 待办，等待答复/审阅 → 储备，受阻/失败待处理 → 失败，明确完成/合并 → 完成。关闭/停止/放弃/未知不能冒充成功。归档镜像可隐藏它；删除本地镜像不停止源工单，后续仍可能重新导入。普通新建看板卡仍走原执行方式，不会悄悄交给 SuperAgent。

关键实现：[原生 UI](<src/client.js>)、[结构化 relay](<src/relay-agent.js>)、[同一 Host SDK](<src/relay-sdk.js>)、[Agent world](<src/relay-world.js>)、[durable outbox](<src/outbox-store.js>)、[Source](<src/source.js>)、[附件仓库](<src/source-attachments.js>)、[原看板 provider](<src/taskboard.js>)。架构与验证边界见[原生对话设计](<docs/native-conversation-design.md>)；隔离 probes 见[原生 relay 说明](<experiments/native-relay/README.md>)和[附件准入说明](<experiments/native-attachments/README.md>)。

依赖原型 SourceKind 与部分非稳定管理接口；升级必须重验 SDK、DOM shim、执行补丁和中央 guard。当前单机单 owner / 单 repo，不能作为多租户隔离。公开 issue 不包含凭据、认证 URL、私有对话、附件或原始执行日志。

MIT，见[许可证](<LICENSE>)。
