# SCES-Management-Desktop-Electron — Agents

本目录的 Claude Code 子代理定义位于根目录 `.claude/agents/`（Claude Code 实际加载的位置）。

## 可用代理

| 代理             | 用途                                                          |
| ---------------- | ------------------------------------------------------------- |
| `desktop-dev`    | 管理端开发（Electron 主进程/renderer、db、gateway 双模、IPC） |
| `desktop-review` | 管理端审查（数据一致性、导出完整性、离线/在线双模对称性）     |
| `architect`      | 架构评审（数据模型、状态机、权限矩阵、在线化迁移）            |
