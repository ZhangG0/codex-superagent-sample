# 本地研发工作流

Node.js 24.12+，一个本地进程、一个 SQLite 数据库、一个 Dashboard。页面没有新需求输入框；Codex 主会话和飞书是输入渠道。主界面按原始消息、需求分析、拆分任务、分发执行、验证回收、结果通告横向展示，卡片对应一项需求。

## 启动

```sh
cd /absolute/path/utils/workflow
cp config.example.json config.local.json
node server.ts config.local.json
```

访问 http://127.0.0.1:4317 。第一次启动在当前用户的数据目录创建 `workflow.sqlite3` 和 `workflow.token`，权限仅当前用户可读写。端口只绑定回环地址。网页使用同源 HttpOnly cookie，外部调用使用 token 文件。不要把 token 放在 URL 或提交到 Git。默认不自动执行、不创建会话、不发送外部通知。

退出前台服务使用 Ctrl-C。启动过程用独占 PID 文件阻止同一数据库的第二个服务；死亡进程的旧文件经检查后清除。恢复时 prepared/running 进入 needs_review，保留占用，不自动重发。未确认退出的执行必须核对原始会话或进程。数据库 user_version 为 1；不要把旧 dispatcher/bridge 数据库直接当作本服务数据库。

## Codex 主会话输入

主会话读取 [ENTRY.md](ENTRY.md)。使用稳定的人类请求标识，不要每次重试都生成新 ID。先把确切消息写成 JSON 文件，再运行：

```sh
  node cli.ts POST /api/messages /absolute/path/message.json
```

```json
{
  "source": "codex",
  "source_message_id": "stable-human-request-id",
  "conversation_id": "verified-coordinator-thread-id",
  "sender_id": "local-user",
  "project_key": "demo",
  "content": "支持导出包含任务和验收记录的报告"
}
```

API 的接收回执返回 message.requirement_id。重复 ID 相同内容返回原记录，变更内容则冲突。初始消息自动创建需求；计划前的补充可带 requirement_id。已规划或执行后的范围变更暂拒绝自动套用，需要协调者核对并创建关联的新需求；第一版不自动重排已执行的任务图。

## 自动分析与执行

配置 command 是可信适配程序的参数数组，无 shell 拼接。程序从 stdin 接收一个 JSON，stdout 返回一个 JSON，诊断写 stderr。`kind=analyze` 返回需求分析和任务计划，`kind=execute` 返回 outcome、summary、evidence；解析失败视为结果不确定。默认超时 30 分钟。并发上限包括分析与执行，会话和资源锁阻止参与本流程的重复分发。

已有 bridge 同级目录时，可复用支持的 desktop queue 适配器：

```json
{
  "command": ["/absolute/path/feishu-codex-bridge/.venv/bin/python", "/absolute/path/workflow/codex_adapter.py"],
  "coordinator": {"key":"analysis","threadId":"VERIFIED_ANALYSIS_THREAD","projects":["demo"]},
  "workers": [{"key":"dev","threadId":"VERIFIED_WORKER_THREAD","projects":["demo"],"resources":["repo:demo"]}]
}
```

配置中的会话需要通过宿主原生工具核实，并有真实用户的派发授权；本服务不验证 Codex 内部身份。不要将当前处理长任务的主会话当作空闲分析器。资源锁不约束绕过本服务的人工操作或旧 dispatcher。相同目录同时由旧调度流程使用时，先暂停并完成交接。

默认分析完成后停在待确认，必须确认当前 revision 才进入执行队列；已配置项目级人类授权的 automation 模式可自动确认无疑问且未越界的当前计划。任务须包含交付结果、非空验收条件及合法无环依赖。每个任务保留独立 runs，后续任务只在前置任务已验收时领取。Worker 报告完成不等于验收通过。验收通过 Dashboard、获授权协调者 API，或 automation.verifier 独立验证会话完成；包含任务验收和整体验收，不使用开发会话自评作为自动验收。返修新增执行尝试，达到项目 maxAttempts 后停止并通知人工。

暂停只阻止新任务领取，不中断已经发给 Codex 的操作。任务结果不确定时不会因为超时释放占用；核对后向原 run 提交 evidence 非空的最终 report。分析核对后提交原 proposal，并带 reconciliation_evidence。尚无任意终止正在运行 Codex 任务的按钮。

## 飞书作为可选入口

旧 bridge 默认行为不变。切换前先确认旧 jobs 没有 queued/running/needs_review，并停止旧服务再修改配置，避免双重消费。工作流开启时使用统一入口转发，关闭团队工作流后由 Bridge 直接处理；研发状态、任务、执行和结果通知在本服务数据库中管理。旧数据库仅保留历史及旧通知，不自动导入。

在 bridge 配置中增加：

```json
{
  "workflow": {
    "enabled": true,
    "url": "http://127.0.0.1:4317",
    "token_file": "/absolute/path/to/workflow.token",
    "spool_directory": "var/workflow-ingress",
    "project_key": "demo"
  }
}
```

各 bindings 可通过 project_key 指向不同项目。机器人、群和 @ 过滤沿用 bridge。转发失败时原消息暂存在私有文件 spool，收到本服务持久回执后删除；它只是传输缓冲，不另建任务库。缓冲中尚未送达核心服务的消息暂不显示在 Dashboard。重复发送沿用原消息 ID。

需求整体验收后，为每个来源讨论创建一条结果通知。飞书发送可配置 notifications.command 为同一个 codex_adapter.py，并给服务进程设置 WORKFLOW_FEISHU_CONFIG 指向 bridge 配置。适配器复用原飞书凭据和回复接口。通知沿用同一 ID 重试，最多 20 次，失败可人工重试。最终 Codex 通知标为 available，主会话读取 /api/outbox 后回复用户；本服务不会模拟桌面向任意聊天发消息。审批卡片与新任务身份尚未打通，权限审批继续在 Codex 桌面完成。

真实入口切换前，先核实项目范围与执行/验证会话。真实链路验收必须由实际飞书输入和原渠道通知送达证明，不能用伪造来源或合成测试代替。

## 数据与接口

[schema.sql](schema.sql) 是确切库表定义。9 张业务表；runs 增加 requirement_id 和 kind，使分析与执行共用恢复机制，故从设计稿的 96 个字段调整为 98 个。schema migration 使用 user_version，尚无旧数据自动迁移。

- messages：唯一键 source + conversation_id + source_message_id；正文完整保存。
- requirements：需求 ID 贯穿消息、任务、验收、事件和结果。stage 与 state 分开。
- tasks / task_dependencies：可独立验收的交付、依赖和就绪顺序。第一版 priority 固定为 0，可由后续接口扩展。
- runs：独立执行尝试和 dispatch_token。执行结果须关联原 run，旧结果不能验收新尝试。
- reviews：保存验收时的条件与证据，子任务/整体需求分别记录。
- events：时间线。
- resource_locks：领取时事务登记会话和共享资源占用。
- outbox：独立结果送达状态，不因通知失败重新执行研发。

接口均在 /api 下，默认 JSON、请求体最多 256KB：

| 方法与路径 | 用途 |
| --- | --- |
| GET /board | 六阶段数据、执行器配置状态 |
| GET /requirements/:id | 消息、任务、依赖、执行、验收、时间线、通知 |
| POST /messages | Codex/飞书输入；无 Dashboard 输入渠道 |
| POST /requirements/:id/analysis | 保存分析，携带当前 revision |
| POST /requirements/:id/plan | 替换未执行计划，检查依赖和验收条件 |
| POST /requirements/:id/approve | 确认当前 revision，开放执行 |
| POST /requirements/:id/actions | pause / resume / cancel；活跃执行不能取消 |
| GET /queue | 任务队列及依赖/需求暂停原因 |
| POST /claim | 本地获授权执行器领取，携带 worker_key |
| POST /runs/:id/started | 登记开始/心跳与 Codex 轮次 |
| POST /runs/:id/report | 结果、证据，携带 dispatch_token |
| POST /runs/:id/proposal | 分析结果；恢复核对须附依据 |
| POST /reviews | 子任务/整体验收 |
| POST /tasks/:id/reopen | 尚未完成需求中的已验收任务返修 |
| GET /events?after=N | 增量事件 |
| GET /outbox | 通知记录 |
| POST /outbox/:id/retry | 仅重试失败通知 |
| POST /runtime | 当前进程 enabled 开关；不改变启动配置 |

## 验证

```sh
node --test tests/*.test.ts
# 开发依赖可用时
npm run typecheck
# 可选：已安装 Playwright 和 Chrome
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/browser.ui.ts
```

核心测试覆盖完整流程、去重冲突、依赖循环、共享资源、暂停、返修、迟到结果、重启核对、自动分析和执行、HTTP 鉴权与跨域保护。浏览器测试使用隔离临时数据库和合成数据，覆盖六列、筛选、分析、计划确认以及 1440/1024/390/320 宽度。不要把这些测试当作真实飞书—Codex 链路验收或长期无人值守认证。

## 项目级自动推进

可选 automation 配置提供 projects 和 verifier。每个项目包含 root、authorization、allowedSources、resources、maxTasks、maxAttempts、authorizedAfter。它记录已有人类授权，仅对该授权时间之后、匹配来源和项目的工作生效，不由消息正文或模型输出改写。

独立验证会话必须与开发会话分开。运行时在 runs 中记录 verify_task / verify_requirement，检查当前执行和需求 revision，验证结果也遵循暂停、恢复和待核对规则。全流程仍有明确停止点：有疑问、要求额外授权、资源越界、证据不足、返修达到上限、发送/执行不确定。停止原因显示在 Dashboard，并通过 outbox 发出需要处理的通知。

Skill 源码位于 ../SKILL.md。安装更新工具 install-skill.py 会备份已有技能、保留个人元数据和旧调度参考；安装后不意味着自动监听所有 Codex 输入框。


## 消息归属与聊天结果（2026-11-06）

本机已启用 `intake.enabled`。`POST /api/messages` 先持久化原始消息；回执含 `message.id`，识别前 `requirement_id` 可以为空。桥接以消息回执确认转发，不要求立刻建需求。纯问候保留为 ignored；明确需求创建一单；补充结合最近消息和同来源、同聊天、同发送人、同项目的开放需求归并。语义不明确时先发出澄清问题，在看板原始消息列保留“待确认归属”，可在弹框选择新需求或已有需求，也可继续在原渠道回答。不会单凭时间间隔合并。

已有计划或执行收到补充时保存为 pending_change 并暂停后续分发；不强行中断已发出的执行，也不把补充静默应用到旧计划。尚未执行的计划可以在分析结束后点击“核对后重新分析补充”；已经执行的变更需要主会话先核对影响，本次不自动重写已执行计划。普通恢复按钮不能绕过该检查。

分析、执行、验证和归属识别均通过 `result_mailbox.py --run <控制器提供的ID> --file <JSON文件或->` 回传结构化结果。每次执行使用 `.local/returns/<run-id>/` 独立目录，原子持久化回执、校验身份和结果格式；重复相同内容安全，冲突回传拒绝。适配器确认原聊天轮次结束后读取回传，不解析最终聊天正文，缺失回传保留待核对。聊天最终展示正常中文报告，不展示接口 JSON。该目录只是回传缓冲，业务状态仍以同一 SQLite 数据库为准。

数据库版本升级至 2，仍为九张表：允许 outbox.requirement_id 为空，以便在建需求前回复问候或澄清；保留原有记录和索引，迁移前备份。历史已创建需求不自动删除或合并。

## Token 用量

启用 `usage.enabled` 后，服务默认每 30 秒只读采集已绑定聊天的执行日志，不发起模型任务、不恢复聊天。增加第十张表 token_usage，数据库版本为 3。以 invocation_id（执行或消息识别）与原生 turn_id 关联，读取 Codex token_usage_record 的 turn_token_usage；按轮次累计快照覆盖写入，thread_id/turn_id 唯一约束防止重复归属。不会把线程全历史累计值算到当前需求，也不解析模型自行声称的用量。

卡片显示累计 token，详情显示消息识别、分析与拆分、执行、验证四类阶段及每次尝试。一个分析调用同时包含分析和拆分，不人为分摊；排队和通道发送没有模型调用，不另计 token。缓存输入、缓存写入和推理输出作为子项记录，总量以 input_tokens + output_tokens 为准，不将子项再次相加。当前版本不计算费用。

识别成本先绑定 message_id，消息归入需求后动态合并；共享分析与执行成本归需求，不均摊到每条原始消息。纯问候使用本地规则时明确记零；没有可核对日志的记录保持 NULL/未采集。旧格式日志不支持精确归属时不猜测补零。活跃执行或计数异常显示部分采集；失败和返修仍计入实际消耗。历史记录在首次采集时补录，完整且已结束的执行不重复扫描，未采集记录每五分钟重查。日志完整度决定是否能补录；统计范围仅包含工作流已关联的执行轮次。


## 用户数据位置

不配置 database / tokenFile 时，默认目录为：macOS `~/Library/Application Support/codex-superagent-sample/`；Linux `$XDG_DATA_HOME/codex-superagent-sample/`（未设置则 `~/.local/share/codex-superagent-sample/`）；Windows `%LOCALAPPDATA%/codex-superagent-sample/`。可用 WORKFLOW_DATA_DIR 覆盖默认目录。配置中的 database 和 tokenFile 优先，绝对路径直接使用，相对路径仍相对于配置文件解析；JSON 中请使用绝对路径，不使用 `~`。

启动日志和已鉴权的 `/api/board` 的 storage.database 返回实际数据库路径。CLI 默认读取同目录 config.local.json，也可用 WORKFLOW_CONFIG 指定配置；WORKFLOW_TOKEN_FILE 优先指定凭据。旧配置显式使用 .local 时保持原路径，不自动搬迁。

迁移：暂停入口及调度，确认没有正在执行的适配器，停止服务；使用 SQLite backup API 备份并迁移，检查 integrity_check、所有表行数及 user_version；更新本机 database 后重启并检查 API。不要只复制活跃数据库主文件。凭据位置独立配置，迁移数据库不要求更换 token。


Windows 用户的数据库默认位置为 `%LOCALAPPDATA%\codex-superagent-sample\workflow.sqlite3`，通常是 `C:\Users\你的用户名\AppData\Local\codex-superagent-sample\workflow.sqlite3`；LOCALAPPDATA 未设置时回退到用户主目录下 AppData/Local。可在资源管理器地址栏粘贴 `%LOCALAPPDATA%\codex-superagent-sample` 打开，再在 DBeaver 选择实际文件。

Windows JSON 自定义路径推荐写成 `"database": "D:/AgentData/workflow.sqlite3"`；使用反斜杠时必须按 JSON 规则双写。PowerShell 临时覆盖默认数据目录使用 `$env:WORKFLOW_DATA_DIR = "D:\AgentData"`，显式 database / tokenFile 配置仍优先。WSL 按 Linux 规则保存数据，不按 Windows 规则。当前路径规则已有分支测试，尚未在真实 Windows 主机完成整体服务验收；launchd 为 macOS 专用，Windows 需自行运行 Node 服务或配置其服务管理器。


## 表与字段说明

SQLite 无原生 COMMENT ON；schema.sql 中逐表逐字段写明中文注释，并将相同说明保存到 schema_comments。DBeaver 刷新 Tables 后查看该表，或执行：

```sql
SELECT table_name AS 表名, column_name AS 字段名, comment AS 说明
FROM schema_comments
ORDER BY table_name, column_name;
```

column_name 为空字符串表示表说明。时间字段保留 Unix 毫秒时间戳，不变更精度及业务行为。该字典不会自动显示在 DBeaver 原生列 Comment 属性中。


## 团队看板与调度开关

Header 可在全部团队与指定团队之间切换，需求、待归属消息、候选需求和统计同步过滤，并在当前浏览器保存选择。配置可增加 teams 数组：每项含 key、name、projects 及 entries（每项为 source、conversationId），以入口聊天和项目共同确定归属。未配置 teams 时兼容为单一当前团队；未匹配的数据仍可在全部团队查看。connected:false 表示尚未接入，显示迁移提示并禁用团队调度按钮。过滤用于组织数据，不代表鉴权隔离。

“暂停全局调度”阻止全部新分析、执行、验证和归属识别；“暂停当前团队”只阻止匹配团队的新领取。已发送执行保留结果，通知仍可交付。全局与团队开关独立并保存到 scheduler_controls，恢复团队不会绕过全局暂停，恢复全局也不会解除团队暂停。团队内已有单项需求暂停仍然有效。在全部团队视图中，当前团队按钮禁用。


## React 前端

看板源码位于 frontend/src，使用 React + TypeScript、shadcn/ui（Radix 版本）和 Tailwind CSS。shadcn 组件来自官方 new-york 注册表，源码保留在 frontend/src/components/ui，按项目需要维护；参见 https://ui.shadcn.com/docs 。

首次安装运行 npm install；npm start 会先构建前端再启动本地服务。单独运行 npm run build 输出 frontend/dist，服务默认从该目录提供静态资源。修改前端后重新构建并刷新浏览器；修改服务端后另需安全重启服务。直接通过 launchd 启动 Node 前须先完成构建。npm run typecheck 同时检查前后端，npm test 先构建再运行后端测试。页面入口仍为 http://127.0.0.1:4317，不增加第二个前端常驻进程。

团队选择、双调度开关、需求详情、分析与计划编辑、验收返修、消息归属、通知重试及 token 用量由 React 组件管理。弹窗支持 Escape、背景关闭和焦点恢复；自动刷新保留展开状态、滚动位置及未提交输入。Radix 动态滚动锁样式通过每次 HTML 响应生成的 CSP nonce 授权，不开放 unsafe-inline。


## 按团队关闭工作流

选择团队后，header 的“关闭工作流 / 启用工作流”独立于全局和团队调度暂停。状态保存在 scheduler_controls 的 workflow:TEAM 项；默认开启，关闭不会清空已有记录、释放正在执行的资源或改写原暂停状态。关闭时阻止该团队的新登记、归属识别、分析、执行和验证领取，已派发结果及通知继续回收。Bridge 读取共享台账的团队开关，关闭时直接向绑定的 Codex 聊天派发，Workflow 服务可以停止。已登记任务保留，不重复派发。

主入口仍可在用户授权范围内使用原生跨聊天工具直接协调。说“这次不用工作流”只影响本次新需求，不改变团队长期模式，也不能重复派发已有工作流任务。POST /api/messages 可对新的 codex 请求带 workflow:false，返回 mode:direct、registered:false，不创建需求；已有消息重试仍返回原登记回执。团队开关接口为 POST /api/teams/TEAM/workflow，正文 {"enabled":false}；GET /api/board 返回 teams[].workflowEnabled。团队映射仅为本机应用约束，不提供强身份认证隔离。


## 外部入口与目录

飞书入口由独立项目 [feishu-codex-bridge](https://github.com/ZhangG0/feishu-codex-bridge) 提供。Codex 桌面队列适配器复用 Bridge 的队列客户端；将其克隆到主仓库旁边，或设置 FEISHU_CODEX_BRIDGE_DIR 指向 Bridge 根目录。使用自定义数据目录时，两个进程应使用相同的 WORKFLOW_DATA_DIR；自定义数据库路径通过 Bridge 的 workflow.mode_database 对齐。
