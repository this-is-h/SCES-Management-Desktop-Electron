/**
 * SQLite 建表 SQL 与迁移。
 *
 * 表结构对齐 docs/ARCHITECTURE.md §3.8，另加 unit（单位）表支撑授权文件机制（§5.2）。
 * 迁移策略：`PRAGMA user_version` 记录 schema 版本，逐版本执行 MIGRATIONS。
 */

/** 当前 schema 版本（= MIGRATIONS 长度）。 */
export const SCHEMA_VERSION = 18

/** 迁移脚本：MIGRATIONS[i] 将 schema 从版本 i 升级到 i+1。 */
export const MIGRATIONS: string[] = [
  // v1：初始表结构
  `
  -- 单位（一级管理端初始化时创建，授权文件签发主体）
  CREATE TABLE unit (
    id            TEXT PRIMARY KEY,               -- unitId
    name          TEXT NOT NULL,                 -- 单位名称
    unit_type     TEXT NOT NULL DEFAULT 'college', -- 书院/学院/系
    public_key_jwk  TEXT NOT NULL,               -- 单位公钥（授权文件签发）
    private_key_jwk TEXT NOT NULL,               -- 单位私钥（仅本地）
    created_at    INTEGER NOT NULL
  );

  -- 配置模板
  CREATE TABLE config_template (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    revision      INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft/published/archived
    personal      TEXT NOT NULL,                  -- 个人信息字段定义 JSON
    dyf           TEXT NOT NULL,                  -- 德育分项目定义 JSON
    calc          TEXT NOT NULL,                  -- 计算规则 JSON
    rank          TEXT NOT NULL,                  -- 排名范围 JSON
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- 批次
  CREATE TABLE batch (
    id            TEXT PRIMARY KEY,               -- batchId
    year          INTEGER NOT NULL,
    semester      INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft/active/closed
    apply_start_at INTEGER,
    apply_end_at  INTEGER,
    config_template_id TEXT REFERENCES config_template(id),
    calc_mode     TEXT NOT NULL DEFAULT 'weighted', -- weighted/formula
    calc_config   TEXT,                          -- JSON: {dyfWeight, courseWeight} 或公式
    rank_scope    TEXT NOT NULL DEFAULT 'grade', -- JSON 数组: class/major/grade/school/all
    public_key_jwk  TEXT NOT NULL,               -- 公钥（上传服务端）
    private_key_jwk TEXT NOT NULL,               -- 私钥（分发给管理端，仅本地）
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- 学生
  CREATE TABLE student (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL REFERENCES batch(id),
    student_id    TEXT NOT NULL,                 -- 学号
    name          TEXT NOT NULL,
    phone         TEXT,
    grade         TEXT,
    major         TEXT,
    class_name    TEXT,
    id_conflict_locked INTEGER NOT NULL DEFAULT 0, -- 学号冲突锁定
    name_corrected INTEGER NOT NULL DEFAULT 0,     -- 姓名已修正（仅一次）
    UNIQUE(batch_id, student_id)
  );

  -- 申请
  CREATE TABLE apply (
    apply_id      TEXT PRIMARY KEY,              -- applyId
    batch_id      TEXT NOT NULL REFERENCES batch(id),
    student_id    INTEGER NOT NULL REFERENCES student(id),
    status        TEXT NOT NULL,                 -- 见状态机
    current_revision INTEGER NOT NULL DEFAULT 0,
    confirm_level INTEGER,                       -- 3=班级/2=年级/1=校级
    confirm_by    TEXT,
    confirm_at    INTEGER,
    imported_at   INTEGER,
    dyf_confirmed_at INTEGER,
    final_at      INTEGER
  );

  -- 申请版本
  CREATE TABLE apply_revision (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    apply_id      TEXT NOT NULL REFERENCES apply(apply_id),
    revision      INTEGER NOT NULL,
    file_hash     TEXT NOT NULL,                 -- SHA-256
    created_at    INTEGER NOT NULL,
    UNIQUE(apply_id, revision)
  );

  -- 德育分明细
  CREATE TABLE dyf_score (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    apply_id      TEXT NOT NULL REFERENCES apply(apply_id),
    item_code     TEXT NOT NULL,
    category      TEXT NOT NULL,
    applied_score REAL NOT NULL,                 -- 学生申请分
    final_score   REAL,                          -- 审核后分
    max_score     REAL,
    allow_add     INTEGER NOT NULL DEFAULT 0,
    evidence_files TEXT,                         -- 证明材料文件列表 JSON
    UNIQUE(apply_id, item_code)
  );

  -- 课程成绩
  CREATE TABLE course_score (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL REFERENCES batch(id),
    student_id    INTEGER NOT NULL REFERENCES student(id),
    course_name   TEXT NOT NULL,
    score         REAL NOT NULL,
    credit        REAL,
    UNIQUE(batch_id, student_id, course_name)
  );

  -- 综测结果
  CREATE TABLE final_grade (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL REFERENCES batch(id),
    student_id    INTEGER NOT NULL REFERENCES student(id),
    dyf_total     REAL NOT NULL,
    course_total  REAL,
    final_total   REAL,
    rank_class    INTEGER,                       -- 班级排名
    rank_major    INTEGER,                       -- 专业排名（同年级同专业）
    rank_grade    INTEGER,                       -- 年级排名
    rank_school   INTEGER,                       -- 全校排名（可选）
    UNIQUE(batch_id, student_id)
  );

  -- 审计日志
  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT,
    operator      TEXT NOT NULL,
    role          TEXT NOT NULL,                 -- level1/level2/level3
    scope         TEXT NOT NULL,                 -- 数据范围（class/grade/unit）
    action        TEXT NOT NULL,
    target        TEXT,
    detail        TEXT,                          -- 变更前后 JSON
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX idx_student_batch ON student(batch_id);
  CREATE INDEX idx_apply_batch ON apply(batch_id);
  CREATE INDEX idx_audit_batch ON audit_log(batch_id);
  CREATE INDEX idx_audit_created ON audit_log(created_at);
  `,
  // v2：批次增加“是否测试”标记（试用/演示不污染正式数据）。
  `
  ALTER TABLE batch ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_batch_test ON batch(is_test, status);
  `,
  // v3：导入冲突暂存 + 审核/排名查询索引（M3）。
  // 学号冲突（§7.2）不能当场拒绝也不能直接导入：暂存解密后的申请 payload，
  // 由管理端从候选者中指定“正确学生”（只能设置一次），处理后再导入或拒绝。
  `
  CREATE TABLE import_conflict (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL REFERENCES batch(id),
    student_id    TEXT NOT NULL,               -- 冲突学号
    existing_name TEXT NOT NULL,               -- 已有记录姓名
    incoming_name TEXT NOT NULL,               -- 新导入文件姓名
    payload       TEXT NOT NULL,               -- 解密后的申请 payload JSON（处理时导入）
    file_name     TEXT NOT NULL,               -- 原 .dyf 文件名
    file_hash     TEXT NOT NULL,               -- 文件内容 SHA-256
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_import_conflict_batch ON import_conflict(batch_id);

  -- 审核列表（按批次+状态）与排名分组（同班/同年级同专业）查询索引
  CREATE INDEX idx_apply_status ON apply(batch_id, status);
  CREATE INDEX idx_student_scope ON student(batch_id, grade, major, class_name);
  CREATE INDEX idx_final_grade_batch ON final_grade(batch_id);
  `,
  // v4：班级端审核标记（决策 #17）。
  // 只允许全班一次性确认（即整班导出）：确认后 batch.class_reviewed_at 落时间戳，
  // 本端锁定（不可再导入/修改/处理冲突）；导入时校验学生是否已被标记为班级端审核。
  `
  ALTER TABLE batch ADD COLUMN class_reviewed_at INTEGER;
  `,
  // v5：单位绑定配置模板（决策 #20）。
  // 配置与单位绑定：励行书院单位用其配置，测试单位用测试配置；
  // 激活时由服务端下发的 configTemplate.id 写入，批次创建使用单位绑定模板（缺省回退最新已发布模板）。
  `
  ALTER TABLE unit ADD COLUMN config_template_id TEXT;
  `,
  // v6：配置结构统一为 UnitConfig（M5.2，决策 #38）。
  // config_template 表从旧 ConfigTemplate 形态（personal 扁平字段）重建为 UnitConfig 形态
  // （unit 绑定 + class 级联 + student 字段 + dyf 树带内嵌标记）。旧格式与新结构不兼容、无法
  // 逐字段转换，故重建而非 ALTER；旧配置由激活时服务端下发 / 内置种子（seedTemplates）重新填充。
  //
  // 外键处理：batch.config_template_id 外键引用本表。有存量 batch 时直接 DROP 会触发
  // FOREIGN KEY constraint failed，故 DROP 前先把引用置空（batch 靠 resolveCalcFromTemplate 的
  // 「缺省回退最新已发布配置」兜底，决策 #20）。migrate() 已在事务外关外键并在迁移后做
  // foreign_key_check，此处置空进一步保证不留悬挂引用。
  `
  UPDATE batch SET config_template_id = NULL;
  UPDATE unit SET config_template_id = NULL;
  DROP TABLE IF EXISTS config_template;
  CREATE TABLE config_template (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    revision      INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft/published/archived
    unit          TEXT NOT NULL,                  -- UnitConfig.unit（单位绑定）JSON
    class_json    TEXT NOT NULL,                  -- UnitConfig.class（班级级联）JSON（class 为保留字，加 _json 后缀）
    student       TEXT NOT NULL,                  -- UnitConfig.student（学生字段）JSON
    dyf           TEXT NOT NULL,                  -- 德育分项目定义 JSON
    calc          TEXT NOT NULL,                  -- 计算规则 JSON
    rank_json     TEXT NOT NULL,                  -- 排名规则 JSON（rank 为保留字，加 _json 后缀）
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  `,
  // v7：离线模式申请密钥保管（决策 #41/#45）+ 批次申请密钥 keyId。
  // 申请密钥由一级管理端激活时本地生成、跨批次复用、支持跨学年轮换：
  // is_current=1 用于新批次加密对接；历史密钥保留用于解密旧 .dyf。
  // 存量单位密钥（现状 RSA-OAEP）回填为 current，保证在线模式装机升级后仍可解密旧文件。
  // （unit 密钥语义修正为 RSA-PSS 签发密钥、新增 unit_cert/delegation 表留 M-O1B。）
  `
  CREATE TABLE apply_key (
    key_id          TEXT PRIMARY KEY,
    unit_id         TEXT NOT NULL REFERENCES unit(id),
    public_key_jwk  TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,
    is_current      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_apply_key_unit ON apply_key(unit_id, is_current);

  INSERT INTO apply_key (key_id, unit_id, public_key_jwk, private_key_jwk, is_current, created_at)
  SELECT 'legacy-' || id, id, public_key_jwk, private_key_jwk, 1, created_at FROM unit;

  ALTER TABLE batch ADD COLUMN key_id TEXT;
  `,
  // v8:三级授权链(M-O1B,dual-mode/12 §5.1)。
  // 1) unit.private_key_jwk 改为可空:二三级(.dysd 激活)只存单位签发公钥,无签发私钥。
  //    SQLite 无法 ALTER 去除 NOT NULL,故重建 unit 表并迁移数据(migrate() 迁移期已关外键)。
  // 2) unit_cert:服务商签发的单位证书(.dysc),二三级授权的信任锚;一级导入后方可签发下级。
  // 3) delegation:一级签发的下级授权(.dysd)台账,支持续期后批量重签 + 审计。
  // unit.public_key_jwk 自 v7 起即由激活写入 RSA-PSS 单位签发密钥(申请密钥进 apply_key)。
  `
  CREATE TABLE unit_v8 (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    unit_type          TEXT NOT NULL DEFAULT 'college',
    public_key_jwk     TEXT NOT NULL,
    private_key_jwk    TEXT,                          -- 可空:二三级无单位签发私钥
    config_template_id TEXT,
    created_at         INTEGER NOT NULL
  );
  INSERT INTO unit_v8 (id, name, unit_type, public_key_jwk, private_key_jwk, config_template_id, created_at)
    SELECT id, name, unit_type, public_key_jwk, private_key_jwk, config_template_id, created_at FROM unit;
  DROP TABLE unit;
  ALTER TABLE unit_v8 RENAME TO unit;

  CREATE TABLE unit_cert (
    unit_id       TEXT PRIMARY KEY REFERENCES unit(id),
    license_id    TEXT NOT NULL,
    sign_key_id   TEXT NOT NULL,
    apply_key_id  TEXT NOT NULL,
    not_after     INTEGER NOT NULL,
    cert_json     TEXT NOT NULL,          -- .dysc 全文,签发 .dysd 时逐字节内嵌
    imported_at   INTEGER NOT NULL
  );

  CREATE TABLE delegation (
    delegation_id     TEXT PRIMARY KEY,
    unit_id           TEXT NOT NULL REFERENCES unit(id),
    role              TEXT NOT NULL,      -- level2 / level3
    scope_json        TEXT NOT NULL,      -- { grade?, class? }
    holder_label      TEXT,               -- 备注(如"2025级生物科学1班 张班长")
    bound_fingerprint TEXT,               -- null = 未绑设备
    expires_at        INTEGER NOT NULL,
    issued_at         INTEGER NOT NULL,
    reissued_at       INTEGER,            -- 最近一次重签时间
    revoked_at        INTEGER             -- 一级本地作废标记(离线仅供台账与审计)
  );
  CREATE INDEX idx_delegation_unit ON delegation(unit_id, role);
  `,
  // v9：确认单（学生端签字确认单截图，附在 .dyf 中）落库为文件，本列存其相对 evidence/ 路径。
  //     导入时把 payload.confirmSlip（base64 PNG）落盘，审核端「查看确认单」经 evidence:read 读回展示/保存。
  `
  ALTER TABLE apply ADD COLUMN confirm_slip TEXT;
  `,
  // v10：手动计算排名（决策 #47）。排名不再随分数实时重算，改为管理端手动触发；
  //      ranked_at 记录最近一次排名计算时间，scores_changed_at 记录分数/名单最近变更时间；
  //      导出（整班/表格）前校验 ranked_at >= scores_changed_at，避免用过期排名导出。
  `
  ALTER TABLE batch ADD COLUMN ranked_at INTEGER;
  ALTER TABLE batch ADD COLUMN scores_changed_at INTEGER;
  `,
  // v11：在线状态同步 outbox，保证网络失败/进程重启后可恢复上报。
  `
  CREATE TABLE status_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX idx_status_outbox_pending ON status_outbox(completed_at, next_attempt_at);
  `,
  // v12：记录最近一次成功保存公示表格的时间，用于 .dxy 导出前的一致性门禁。
  `
  ALTER TABLE batch ADD COLUMN table_exported_at INTEGER;
  `,
  // v13：数据修复版本标记。升级前由 db/index.ts 把历史 dyf_score.category 统一为模板 category.code。
  `
  SELECT 1;
  `,
  // v14：保存已签发的加密授权文件快照，支持台账单条导出而无需重新输入原口令。
  `
  ALTER TABLE delegation ADD COLUMN file_json TEXT;
  `,
  // v15：导入即进入统一审核状态，不再区分“待审核/审核中”；兼容旧库一次性迁移。
  `
  UPDATE apply SET status = 'reviewing' WHERE status = 'imported';
  `,
  // v16：同一单位的同一角色+范围只保留一条授权台账；再次签发/重签覆盖原记录。
  `
  ALTER TABLE delegation ADD COLUMN scope_key TEXT;
  UPDATE delegation
  SET scope_key = role || '|' || COALESCE(json_extract(scope_json, '$.grade'), '') || '|' || COALESCE(json_extract(scope_json, '$.class'), '');
  DELETE FROM delegation
  WHERE delegation_id IN (
    SELECT delegation_id FROM (
      SELECT delegation_id,
             ROW_NUMBER() OVER (
               PARTITION BY unit_id, scope_key
               ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
                        COALESCE(reissued_at, issued_at) DESC,
                        issued_at DESC
             ) AS rn
      FROM delegation
    ) WHERE rn > 1
  );
  CREATE UNIQUE INDEX idx_delegation_scope_unique ON delegation(unit_id, scope_key);
  `,
  // v17：德育分 v2 时间线、申请时间摘要与内容寻址证据对象。
  `
  ALTER TABLE apply ADD COLUMN first_entered_at INTEGER;
  ALTER TABLE apply ADD COLUMN last_student_exported_at INTEGER;
  ALTER TABLE apply ADD COLUMN last_imported_at INTEGER;
  ALTER TABLE apply ADD COLUMN last_modified_at INTEGER;
  ALTER TABLE apply ADD COLUMN last_exported_at INTEGER;

  CREATE TABLE timeline_event (
    event_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batch(id),
    apply_id TEXT REFERENCES apply(apply_id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('student', 'admin', 'system')),
    role TEXT,
    scope_json TEXT,
    action TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    revision INTEGER,
    source_file_hash TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_timeline_apply_time ON timeline_event(batch_id, apply_id, occurred_at, event_id);
  CREATE INDEX idx_timeline_batch_time ON timeline_event(batch_id, occurred_at, event_id);

  CREATE TABLE evidence_asset (
    asset_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  UPDATE apply SET last_imported_at = imported_at WHERE last_imported_at IS NULL AND imported_at IS NOT NULL;
  INSERT OR IGNORE INTO timeline_event
    (event_id, batch_id, apply_id, actor_type, role, scope_json, action, occurred_at, created_at)
  SELECT 'legacy:admin.imported:' || apply_id, batch_id, apply_id, 'admin', NULL, NULL,
         'admin.imported', imported_at, imported_at
  FROM apply WHERE imported_at IS NOT NULL;
  `,
  // v18：离线授权链下线（产品切纯在线，决策见 README 在线化说明）：
  // 1) unit 的单位签发密钥列（public_key_jwk/private_key_jwk，RSA-PSS）仅服务离线授权签发
  //    与委派（.dysk/.dysc/.dysd），随 unit-keys/unit-cert/delegation 一并下线 → 重建 unit 剥离两列；
  // 2) unit_cert（.dysc 信任锚）与 delegation（.dysd 台账）为离线分级授权专用 → 整表删除。
  //    申请密钥（apply_key）保留：学生 .dyf 解密仍需要（历史密钥轮换）。
  `
  DROP TABLE IF EXISTS unit_cert;
  DROP TABLE IF EXISTS delegation;
  CREATE TABLE unit_v18 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    config_template_id TEXT REFERENCES config_template(id),
    created_at INTEGER NOT NULL
  );
  INSERT INTO unit_v18 (id, name, unit_type, config_template_id, created_at)
    SELECT id, name, unit_type, config_template_id, created_at FROM unit;
  DROP TABLE unit;
  ALTER TABLE unit_v18 RENAME TO unit;
  `
]
