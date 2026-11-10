PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
-- 研发需求及当前分析、计划与验收阶段
CREATE TABLE IF NOT EXISTS requirements (
 archived_at INTEGER,
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 所属项目标识
 project_key TEXT NOT NULL,
 -- 标题
 title TEXT NOT NULL,
 -- 需求目标
 goal TEXT NOT NULL DEFAULT '',
 -- 获授权的工作范围
 scope TEXT NOT NULL DEFAULT '',
 -- 验收条件数组（JSON）
 acceptance_json TEXT NOT NULL DEFAULT '[]',
 -- 需求分析内容（JSON）
 analysis_json TEXT NOT NULL DEFAULT '{}',
 -- 工作流所处阶段
 stage TEXT NOT NULL DEFAULT 'inbox',
 -- 当前处理状态
 state TEXT NOT NULL DEFAULT 'pending',
 -- 当前需求版本号
 revision INTEGER NOT NULL DEFAULT 1,
 -- 已批准执行的需求版本号
 approved_revision INTEGER,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL,
 -- 最后更新时间，Unix 毫秒时间戳
 updated_at INTEGER NOT NULL
);
-- 来自 Codex 或飞书的原始消息及需求归属
CREATE TABLE IF NOT EXISTS messages (
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 来源渠道或采集方式
 source TEXT NOT NULL,
 -- 来源系统原始消息标识，用于幂等去重
 source_message_id TEXT NOT NULL,
 -- 来源聊天或群组标识
 conversation_id TEXT NOT NULL,
 -- 原始发送人标识
 sender_id TEXT NOT NULL,
 -- 原始消息或通知正文
 content TEXT NOT NULL,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT REFERENCES requirements(id),
 -- 当前处理状态
 state TEXT NOT NULL DEFAULT 'pending',
 -- 最近一次错误或待核对原因
 error TEXT,
 -- 消息接收时间，Unix 毫秒时间戳
 received_at INTEGER NOT NULL,
 -- 消息处理时间，Unix 毫秒时间戳
 processed_at INTEGER,
 -- 来源附加信息和归属上下文（JSON）
 metadata_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(source,conversation_id,source_message_id)
);
-- 需求拆分后的可独立验收任务
CREATE TABLE IF NOT EXISTS tasks (
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 -- 标题
 title TEXT NOT NULL,
 -- 任务应交付的结果
 deliverable TEXT NOT NULL,
 -- 验收条件数组（JSON）
 acceptance_json TEXT NOT NULL,
 -- 当前处理状态
 state TEXT NOT NULL DEFAULT 'draft',
 -- 调度优先级，数值越大越优先
 priority INTEGER NOT NULL DEFAULT 0,
 -- 优先指定的执行成员标识
 preferred_worker_key TEXT,
 -- 任务需占用的资源名称数组（JSON）
 resources_json TEXT NOT NULL DEFAULT '[]',
 -- 该任务对应的需求版本
 requirement_revision INTEGER NOT NULL,
 -- 同一计划内的任务顺序
 queue_order INTEGER NOT NULL,
 -- 任务可调度时间，Unix 毫秒时间戳
 ready_at INTEGER,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL,
 -- 最后更新时间，Unix 毫秒时间戳
 updated_at INTEGER NOT NULL
);
-- 任务前置依赖关系
CREATE TABLE IF NOT EXISTS task_dependencies (
 -- 关联任务主键
 task_id TEXT NOT NULL REFERENCES tasks(id),
 -- 必须先验收通过的前置任务主键
 depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
 PRIMARY KEY(task_id,depends_on_task_id),
 CHECK(task_id != depends_on_task_id)
);
-- 分析、执行和验证的每次派发尝试
CREATE TABLE IF NOT EXISTS runs (
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 -- 关联任务主键
 task_id TEXT REFERENCES tasks(id),
 -- 调用类型：分析、执行或验证
 kind TEXT NOT NULL,
 -- 执行或验证成员标识
 worker_key TEXT NOT NULL,
 -- 当前任务的执行尝试序号
 attempt INTEGER NOT NULL,
 -- 当前处理状态
 state TEXT NOT NULL,
 -- 单次执行回传凭据，不应输出到日志或公开分享
 dispatch_token TEXT NOT NULL UNIQUE,
 -- 宿主原生聊天轮次标识
 host_turn_id TEXT,
 -- 交接输入及验收上下文（JSON）
 input_json TEXT NOT NULL,
 -- 执行返回的摘要
 output_summary TEXT,
 -- 证据与产物定位数组（JSON）
 evidence_json TEXT NOT NULL DEFAULT '[]',
 -- 最近一次错误或待核对原因
 error TEXT,
 -- 预备派发时间，Unix 毫秒时间戳
 prepared_at INTEGER NOT NULL,
 -- 发送确认时间，Unix 毫秒时间戳
 sent_at INTEGER,
 -- 开始执行时间，Unix 毫秒时间戳
 started_at INTEGER,
 -- 最近心跳时间，Unix 毫秒时间戳
 heartbeat_at INTEGER,
 -- 执行结束时间，Unix 毫秒时间戳
 finished_at INTEGER,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL
);
-- 任务或整体需求的验收意见与证据
CREATE TABLE IF NOT EXISTS reviews (
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 -- 关联任务主键
 task_id TEXT REFERENCES tasks(id),
 -- 关联单次执行主键
 run_id TEXT REFERENCES runs(id),
 -- 验收者身份
 reviewer TEXT NOT NULL,
 -- 验收结论
 verdict TEXT NOT NULL,
 -- 验收时使用的标准快照（JSON）
 criteria_snapshot_json TEXT NOT NULL,
 -- 证据与产物定位数组（JSON）
 evidence_json TEXT NOT NULL,
 -- 验收意见正文
 comment TEXT NOT NULL,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL
);
-- 工作流变更审计时间线
CREATE TABLE IF NOT EXISTS events (
 -- 记录主键
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT REFERENCES requirements(id),
 -- 关联任务主键
 task_id TEXT REFERENCES tasks(id),
 -- 关联单次执行主键
 run_id TEXT REFERENCES runs(id),
 -- 审计事件类型
 type TEXT NOT NULL,
 -- 产生事件的操作者
 actor TEXT NOT NULL,
 -- 事件补充信息（JSON）
 payload_json TEXT NOT NULL,
 -- 关联调用或操作标识
 correlation_id TEXT,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL
);
-- 结果和澄清消息的可靠通知队列
CREATE TABLE IF NOT EXISTS outbox (
 -- 记录主键
 id TEXT PRIMARY KEY,
 -- 关联需求主键；可为空时表示尚未归属需求
 requirement_id TEXT REFERENCES requirements(id),
 -- 来源渠道或采集方式
 source TEXT NOT NULL,
 -- 通知目标信息（JSON）
 destination_json TEXT NOT NULL,
 -- 需回复的原始消息标识
 reply_to_message_id TEXT,
 -- 通知用途，例如结果或澄清
 purpose TEXT NOT NULL,
 -- 原始消息或通知正文
 content TEXT NOT NULL,
 -- 当前处理状态
 state TEXT NOT NULL,
 -- 通知幂等键，防止重复通知
 dedupe_key TEXT NOT NULL UNIQUE,
 -- 通知发送尝试次数
 attempts INTEGER NOT NULL DEFAULT 0,
 -- 下次允许重试时间，Unix 毫秒时间戳
 next_attempt_at INTEGER NOT NULL,
 -- 发送确认时间，Unix 毫秒时间戳
 sent_at INTEGER,
 -- 最近一次错误或待核对原因
 error TEXT,
 -- 创建时间，Unix 毫秒时间戳，保留现有精度
 created_at INTEGER NOT NULL
);
-- 运行占用的共享资源，不表示操作系统锁
CREATE TABLE IF NOT EXISTS resource_locks (
 -- 资源唯一名称
 resource_key TEXT PRIMARY KEY,
 -- 关联单次执行主键
 run_id TEXT NOT NULL REFERENCES runs(id),
 -- 资源领取时间，Unix 毫秒时间戳
 acquired_at INTEGER NOT NULL,
 -- 最近心跳时间，Unix 毫秒时间戳
 heartbeat_at INTEGER NOT NULL,
 -- 资源占用说明
 note TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_queue ON tasks(state,priority DESC,queue_order);
CREATE INDEX IF NOT EXISTS run_status ON runs(state,requirement_id);
CREATE INDEX IF NOT EXISTS requirement_stage ON requirements(stage,updated_at);
CREATE INDEX IF NOT EXISTS requirement_messages ON messages(requirement_id,received_at);
CREATE INDEX IF NOT EXISTS event_requirement ON events(requirement_id,id);
CREATE INDEX IF NOT EXISTS due_notifications ON outbox(state,next_attempt_at);
-- 按调用及原生聊天轮次归属的 token 用量
CREATE TABLE IF NOT EXISTS token_usage (
 -- 工作流调用归属标识
 invocation_id TEXT PRIMARY KEY,
 -- 关联单次执行主键
 run_id TEXT REFERENCES runs(id),
 -- 关联原始消息主键
 message_id TEXT REFERENCES messages(id),
 -- 原生聊天标识
 thread_id TEXT NOT NULL,
 -- 原生聊天轮次标识
 turn_id TEXT,
 -- 工作流所处阶段
 stage TEXT NOT NULL,
 -- 执行所用模型
 model TEXT,
 -- 输入 token 数，包含缓存输入
 input_tokens INTEGER,
 -- 输入中命中缓存的 token 数，不额外计入总量
 cached_input_tokens INTEGER,
 -- 缓存写入 token 数，未采集时为空
 cache_write_input_tokens INTEGER,
 -- 输出 token 数，包含推理子集
 output_tokens INTEGER,
 -- 输出中的推理 token 子集，不额外计入总量
 reasoning_output_tokens INTEGER,
 -- 原生记录的总 token 数
 total_tokens INTEGER,
 -- 用量采集完整性状态
 status TEXT NOT NULL,
 -- 该调用是否已结束：0 否、1 是
 finished INTEGER NOT NULL DEFAULT 0,
 -- 来源渠道或采集方式
 source TEXT NOT NULL,
 -- 采集状态补充说明
 detail TEXT,
 -- 最近采集时间，Unix 毫秒时间戳
 observed_at INTEGER NOT NULL,
 UNIQUE(thread_id,turn_id)
);
CREATE INDEX IF NOT EXISTS usage_run ON token_usage(run_id);
CREATE INDEX IF NOT EXISTS usage_message ON token_usage(message_id);
-- SQLite 不支持 COMMENT ON，以下数据字典供 DBeaver 和 SQL 查询使用。
-- SQLite 表与字段的中文数据字典；column_name 为空字符串表示表说明
CREATE TABLE IF NOT EXISTS schema_comments (
 -- 被说明的表名
 table_name TEXT NOT NULL,
 -- 被说明的字段名；空字符串代表表级说明
 column_name TEXT NOT NULL DEFAULT '',
 -- 表或字段的中文说明
 comment TEXT NOT NULL,
 PRIMARY KEY(table_name,column_name)
);
PRAGMA user_version=4;

-- 字典与源码同步更新；不更改业务字段或时间值。
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','','研发需求及当前分析、计划与验收阶段') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','project_key','所属项目标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','title','标题') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','goal','需求目标') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','scope','获授权的工作范围') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','acceptance_json','验收条件数组（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','analysis_json','需求分析内容（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','stage','工作流所处阶段') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','state','当前处理状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','revision','当前需求版本号') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','approved_revision','已批准执行的需求版本号') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('requirements','updated_at','最后更新时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','','来自 Codex 或飞书的原始消息及需求归属') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','source','来源渠道或采集方式') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','source_message_id','来源系统原始消息标识，用于幂等去重') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','conversation_id','来源聊天或群组标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','sender_id','原始发送人标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','content','原始消息或通知正文') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','state','当前处理状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','error','最近一次错误或待核对原因') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','received_at','消息接收时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','processed_at','消息处理时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('messages','metadata_json','来源附加信息和归属上下文（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','','需求拆分后的可独立验收任务') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','title','标题') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','deliverable','任务应交付的结果') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','acceptance_json','验收条件数组（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','state','当前处理状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','priority','调度优先级，数值越大越优先') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','preferred_worker_key','优先指定的执行成员标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','resources_json','任务需占用的资源名称数组（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','requirement_revision','该任务对应的需求版本') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','queue_order','同一计划内的任务顺序') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','ready_at','任务可调度时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('tasks','updated_at','最后更新时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('task_dependencies','','任务前置依赖关系') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('task_dependencies','task_id','关联任务主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('task_dependencies','depends_on_task_id','必须先验收通过的前置任务主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','','分析、执行和验证的每次派发尝试') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','task_id','关联任务主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','kind','调用类型：分析、执行或验证') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','worker_key','执行或验证成员标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','attempt','当前任务的执行尝试序号') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','state','当前处理状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','dispatch_token','单次执行回传凭据，不应输出到日志或公开分享') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','host_turn_id','宿主原生聊天轮次标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','input_json','交接输入及验收上下文（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','output_summary','执行返回的摘要') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','evidence_json','证据与产物定位数组（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','error','最近一次错误或待核对原因') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','prepared_at','预备派发时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','sent_at','发送确认时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','started_at','开始执行时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','heartbeat_at','最近心跳时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','finished_at','执行结束时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('runs','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','','任务或整体需求的验收意见与证据') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','task_id','关联任务主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','run_id','关联单次执行主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','reviewer','验收者身份') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','verdict','验收结论') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','criteria_snapshot_json','验收时使用的标准快照（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','evidence_json','证据与产物定位数组（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','comment','验收意见正文') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('reviews','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','','工作流变更审计时间线') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','task_id','关联任务主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','run_id','关联单次执行主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','type','审计事件类型') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','actor','产生事件的操作者') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','payload_json','事件补充信息（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','correlation_id','关联调用或操作标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('events','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','','结果和澄清消息的可靠通知队列') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','id','记录主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','requirement_id','关联需求主键；可为空时表示尚未归属需求') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','source','来源渠道或采集方式') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','destination_json','通知目标信息（JSON）') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','reply_to_message_id','需回复的原始消息标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','purpose','通知用途，例如结果或澄清') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','content','原始消息或通知正文') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','state','当前处理状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','dedupe_key','通知幂等键，防止重复通知') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','attempts','通知发送尝试次数') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','next_attempt_at','下次允许重试时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','sent_at','发送确认时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','error','最近一次错误或待核对原因') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('outbox','created_at','创建时间，Unix 毫秒时间戳，保留现有精度') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','','运行占用的共享资源，不表示操作系统锁') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','resource_key','资源唯一名称') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','run_id','关联单次执行主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','acquired_at','资源领取时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','heartbeat_at','最近心跳时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('resource_locks','note','资源占用说明') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','','按调用及原生聊天轮次归属的 token 用量') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','invocation_id','工作流调用归属标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','run_id','关联单次执行主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','message_id','关联原始消息主键') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','thread_id','原生聊天标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','turn_id','原生聊天轮次标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','stage','工作流所处阶段') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','model','执行所用模型') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','input_tokens','输入 token 数，包含缓存输入') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','cached_input_tokens','输入中命中缓存的 token 数，不额外计入总量') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','cache_write_input_tokens','缓存写入 token 数，未采集时为空') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','output_tokens','输出 token 数，包含推理子集') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','reasoning_output_tokens','输出中的推理 token 子集，不额外计入总量') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','total_tokens','原生记录的总 token 数') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','status','用量采集完整性状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','finished','该调用是否已结束：0 否、1 是') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','source','来源渠道或采集方式') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','detail','采集状态补充说明') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('token_usage','observed_at','最近采集时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('schema_comments','','SQLite 表与字段的中文数据字典；column_name 为空字符串表示表说明') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('schema_comments','table_name','被说明的表名') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('schema_comments','column_name','被说明的字段名；空字符串代表表级说明') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments(table_name,column_name,comment) VALUES('schema_comments','comment','表或字段的中文说明') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;

-- 调度开关持久化；全局与团队独立，暂停不表示终止执行。
CREATE TABLE IF NOT EXISTS scheduler_controls (
 -- global 或 team:团队标识
 scope TEXT PRIMARY KEY,
 -- 1 允许新调度，0 暂停
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 -- 最后修改时间，Unix 毫秒时间戳
 updated_at INTEGER NOT NULL
);
INSERT INTO schema_comments VALUES('scheduler_controls','','全局及团队调度开关，持久化暂停状态') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments VALUES('scheduler_controls','scope','global 或 team:团队标识') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments VALUES('scheduler_controls','enabled','1 允许新调度，0 暂停') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
INSERT INTO schema_comments VALUES('scheduler_controls','updated_at','最后修改时间，Unix 毫秒时间戳') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;

INSERT INTO schema_comments VALUES('scheduler_controls','scope','global 全局调度、team:团队 调度暂停、workflow:团队 工作流开关；互相独立') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;

INSERT INTO schema_comments VALUES('requirements','archived_at','归档时间，Unix 毫秒时间戳；NULL 表示未归档') ON CONFLICT(table_name,column_name) DO UPDATE SET comment=excluded.comment;
