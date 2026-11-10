# CLI 与运行维护

[返回 README](../README.md)

下列 CLI 示例从源码根目录执行；`workspace_dir` 指向已配置的工作区，须先替换真实协调聊天 ID。

### CLI 生命周期

下例适用于 bash/zsh。替换 ID 后执行；所有台账命令都显式携带入口身份。`check` 是不需要 caller 的静态检查例外。`list` 等台账命令首次运行会创建数据库。

```sh
caller_thread='REPLACE_WITH_COORDINATOR_THREAD_ID'
dispatch=(node dispatch.ts --config "$workspace_dir/config/dispatcher.json"
  --entry coordinator --caller-host local --caller-thread "$caller_thread")

"${dispatch[@]}" recover
"${dispatch[@]}" list
"${dispatch[@]}" create --key request-001 --project demo \
  --title '修复登录校验' --scope local \
  --authorization '用户在当前协调聊天明确授权本地修复及测试，不部署'
```

从返回 JSON 获取 `id` 后：

```sh
task_id='REPLACE_WITH_RETURNED_TASK_ID'
cat > /tmp/dispatch-contract.json <<'JSON'
{"request_id":"request-001","description":"修复登录校验","acceptance":"有效输入通过、无效输入被拒绝并有验证证据","boundaries":"仅 demo 项目，不部署","next_action":"核实结果并向用户汇报"}
JSON
"${dispatch[@]}" contract "$task_id" --file /tmp/dispatch-contract.json
"${dispatch[@]}" prepare "$task_id"
```

`prepare` 原子领取资源并返回 `attempt`。**此时尚未发送消息**。协调方调用原生 `send_message_to_thread` 一次，消息中包含任务 ID、attempt、正式 cwd、目标、范围、完成标准、报告位置和占用范围。发送成功后登记真实回执：

```sh
attempt_id='REPLACE_WITH_RETURNED_ATTEMPT'
"${dispatch[@]}" sent "$task_id" --attempt "$attempt_id" --receipt '真实工具成功回执或消息定位'
```

等待使用原生 `wait_threads`。协调方核实实现和验证证据后逐级推进：

```sh
"${dispatch[@]}" progress "$task_id" --stage implemented --evidence '已核实的改动与报告定位'
"${dispatch[@]}" progress "$task_id" --stage verified --evidence '已核实的测试结果'
# 创建 /tmp/dispatch-report.json，格式见下文；填写当前 attempt、revision、真实来源及证据
"${dispatch[@]}" report "$task_id" --file /tmp/dispatch-report.json
"${dispatch[@]}" finish "$task_id" --evidence '协调方确认验收标准满足，无待核事项'
```

同一人类请求沿用相同 key；不同目标、授权、路由不能复用旧 key。`discussion` 不派发，讨论得到结论后可直接 `finish`。`local` 验证后结束；`deploy` 还必须按顺序登记 `deployed`、`live_verified` 才能结束。工具成功或聊天回合结束不等于任务完成。

### 中断恢复与取消

| 情况 | 操作 |
| --- | --- |
| 发送超时、额度中断或结果不明 | `uncertain TASK --evidence '中断位置'`，保留占用，先核实目标历史 |
| 找到原发送消息 | 用原 attempt 补记 `sent`，不得重新派发 |
| 确认原消息完全未送达 | `reconcile-unsent TASK --evidence '目标历史及工具证据'`，恢复 pending 后才能重试 |
| 已送达任务执行中断 | 在原聊天续接同一任务，保留任务 ID，不使用 reconcile-unsent 重派 |
| 用户取消 | 确认执行方停止或安全交接后，`cancel TASK --evidence '取消与停止证据'` |
| 资源被占用 | `list` / `show TASK` 核实，不能因超时抢锁或删除数据库 |

`cancel` 不会实际终止聊天，资源锁不会自动过期。`needs_review` 任务需核实后恢复 running（可用原 attempt 补记明确回执），才能 finish。证据字段由协调方填写，CLI 无法判断证据真实性。

### 等待游标

将原生等待工具的结构化返回值保存为临时 JSON 后运行 `merge-polls FILE`。它接受如下规范化结构，只保存游标，不保存消息内容：

```json
{"polls":[{"thread":{"hostId":"local","id":"TARGET_THREAD_ID"},"cursor":"RETURNED_CURSOR","expected_version":0}]}
```

只合并实际返回的项；未返回目标的游标保留。`list` 的游标可用作后续等待的 `afterCursor`。若宿主返回结构不同，调用方须先规范化，不能把整个工具消息封装直接传入。

配置可显式通过 `--config` 提供，也兼容环境变量 `ZEO_DISPATCH_CONFIG`（历史名称保留）。完整参数以 `node dispatch.ts --help` 和各子命令 `--help` 为准。

## 数据与维护

数据库目录权限为 0700、主文件为 0600，使用 SQLite WAL。运行配置、数据库、凭据和私人聊天 ID 不应提交到公开仓库；本仓库仅包含合成示例和测试。请在你的实际工作区也忽略 `.local/` 和私人配置，源码仓库的 `.gitignore` 不会作用于其他工作区。

备份活跃数据库使用 SQLite backup API，不只复制主文件。项目权限撤销后原入口仍可 list/show/context/recover；核实执行方停止后可 cancel。其他执行操作拒绝。入口本身解绑时由有授权的管理者恢复绑定收尾，不自动清理旧锁。旧版无 entry 任务默认拒绝操作，迁移时人工核实来源与授权，不编造回执。


## 状态与恢复命令

`recover` 返回当前入口所有未结束任务、任务约定、revision、权限是否仍有效及下一步提示。启动和上下文恢复先调用它，核对最新人类要求及目标历史。request key 是稳定的来源请求标识，同一请求重试和恢复必须复用；来源无 ID 时只生成一次，并从 recover 找回。

```sh
"${dispatch[@]}" context "$task_id"
"${dispatch[@]}" state "$task_id" --status awaiting_input --evidence '需要用户提供验收样例'
"${dispatch[@]}" state "$task_id" --status running --evidence '用户已提供样例，执行方继续'
"${dispatch[@]}" rework "$task_id" --evidence '发现遗漏，重新实现并验证'
```

状态路径：pending → dispatching → running → completed。发送不确定进入 needs_review，经真实回执恢复或凭未送达证据回到 pending。running 可进入 blocked / awaiting_input / failed，凭证据恢复 running；这些状态保留锁。任意非终态可在安全交接后 cancel。discussion 为 pending → completed。progress 只允许 running，local 必须 verified，deploy 必须 live_verified 才能 finish。

rework 仅针对已确认送达的活动任务，重置 stage 为 planned、revision 加一、清除旧 report，保留 attempt 和锁；随后通知同一目标继续当前版本。旧验收不能用于新版本。需求约定需要改变时安全取消并创建新请求，不能静默覆盖原授权。

`report TASK --file FILE` 的 JSON 格式：

```json
{"attempt":"CURRENT_ATTEMPT","revision":1,"host":"local","thread":"TARGET_THREAD_ID","evidence":"当前结果的消息定位及验收核对摘要"}
```

执行任务 finish 前必须有当前版本的匹配 report；CLI 检查关联字段，证据真实性仍由协调方核实。旧数据库新增 task_context、cursor_versions 表，原任务和事件不重写；旧活动任务可在核实历史后登记 report，旧 pending 任务需先补 contract 才能 prepare。测试用 Python 参考实现仅为历史兼容对照，不能作为新版生产入口。

## 等待与游标并发

每轮 wait_threads 最多等待 60 秒；单次超时不代表任务失败，持续跟进到验收完成、取消或明确需要人工处理。用户消息沿用宿主机制，中断后先 recover 再继续。无自动化时结束回复不会后台唤醒。

merge-polls 中 expected_version 必须取自发起该轮等待前的 list 游标，首次为 0；每次保存成功版本加一。迟到响应版本不符则整次事务回滚，重新读取最新游标再发起等待；不可比较或解析不透明 cursor 字符串，也不可用新 version 强行保存旧响应。部分目标返回只更新这些目标。
