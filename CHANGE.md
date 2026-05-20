# 更新日志

本文档记录 AI-Gateway-Hub 的版本变更历史。

---

## v1.3.0 — 2026-05-20

### 新增

- **Prompt Cache 自动优化**
  - OpenAI 请求自动派生稳定 `prompt_cache_key`，并为支持的上游附加 `prompt_cache_retention`
  - Anthropic 请求自动规范化 tools，并在 system / 近期 user 消息处注入 cache breakpoint
  - 新增缓存预热防抖，同一稳定前缀的并发请求短暂排队，降低首轮缓存未写入导致的重复 cache miss
- **OpenAI 原生 Responses API 透传**
  - 供应商新增 `supportsNativeResponses` 开关，启用后 `/v1/responses` 直连上游 `/responses`
  - 保留 `previous_response_id`、`store`、reasoning、工具调用 ID 等字段，适配 Codex CLI 等长会话客户端
  - 流式响应字节级透传，同时旁路提取 `usage` 用于日志、统计和费用估算
- **缓存读写统计增强**
  - 供应商统计、用量分析、请求日志补齐缓存读 / 缓存写聚合
  - 协议转换时保留 OpenAI `cached_tokens` 与 Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`
  - 映射规则的“当前 / 固定”状态扩展到同一输入模型的多规则场景

### 修复

- **OpenAI 缓存计费口径** — 按官方口径将 `inputTokens - cacheReadTokens` 作为普通输入计费，`cacheReadTokens` 单独按 cached input 价格计费，避免缓存命中部分重复按普通价计算
- **Anthropic 缓存字段保真** — Anthropic 的 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 分别计价，不对 Anthropic 输入做 OpenAI 式相减
- **流式用量捕获** — OpenAI / Anthropic SSE 路径都能捕获最终 usage，避免流式请求缓存 token 统计缺失

### 测试

- 新增 prompt cache 注入、Anthropic cache breakpoint、缓存优化和路由 UI 相关测试脚本

---

## v1.2.0 — 2026-05-19

### 新增

- **跨网段访问支持** — 监听地址可在 `127.0.0.1`（仅本机）与 `0.0.0.0`（开放局域网/内网)之间切换，让团队多台机器、内网服务器、笔记本统一走同一个网关
  - **系统设置 → 网络监听** 新增卡片，下拉切换监听模式，保存后引导一键重启
  - 实时显示当前生效的监听地址 + 本机 IPv4 列表（多网卡环境自动枚举）
- **防火墙规则一键管理**
  - 监听 `0.0.0.0` 时自动探测 Windows 防火墙规则是否已存在（`netsh advfirewall firewall show rule`）
  - 状态徽章三态:✅ 已配置 / ⚠ 未配置 / ⏸ 仅本机无需配置
  - 一键复制「开放端口管理员命令」/「移除规则管理员命令」,粘贴到管理员 PowerShell 即可
  - 附带独立辅助脚本 `bin/setup-firewall.bat`(Windows) / `bin/setup-firewall.sh`(Linux,自动检测 ufw → firewalld → iptables 级联)
- **Loopback 双绑定防劫持**(Windows 关键修复)
  - 监听 `0.0.0.0` 时同进程同时显式绑定 `127.0.0.1:PORT`,抢在 VSCode Remote-SSH 端口转发 / 其它本地服务之前占住 loopback
  - Windows TCP "more specific match wins" 路由规则下,这避免 `curl 127.0.0.1:PORT` 被路由到错误进程导致超时
  - 若 loopback 已被他人占用,启动时打印黄色警告 + 给出 `netstat -ano | findstr :PORT` 诊断命令,不阻塞主服务

### 安全提示

- ⚠️ **监听 `0.0.0.0` + 防火墙开放 = 局域网任何人都能尝试访问网关。**强烈建议:
  - 为每个映射设置足够长的随机本地 SK(`localSk`),不要用 `sk-test` 等默认值
  - 定期轮换映射 SK
  - 不需要跨网段时切回 `127.0.0.1`,并移除防火墙规则

---

## v1.1.0 — 2026-05-14

### 新增

- **时间段轮换策略** — 第 5 种切换策略，专为多账号摊费用设计
  - 按可配置周期（≥30 分钟）自动轮换 provider，窗口内缓存命中率最大化
  - **强制激活** — 在规则上 hover 显示"激活"按钮，一键锁定到指定规则
  - **延长窗口** — 一键将当前窗口再延长一个周期，到期自动恢复轮换
  - **倒计时** — 信息栏实时显示距下次切换时间
  - **当前生效指示** — 同 inputModel 多规则时，绿色徽章标记当前命中的规则
- **使用日志增强**
  - 新增"别名"列：显示 provider 的人类可读名称（autolink-yujie 等）
  - 新增"推理强度"列：智能识别 Anthropic `thinking` (enabled/adaptive/budget_tokens)、OpenAI `reasoning_effort`、Cherry Studio `output_config.effort` 等多种格式
  - 详细 Token 统计条：输入 / 输出 / 缓存读 / 缓存写 / 输入输出Token / 总Token / 总费用 / 错误，8 项指标一目了然
  - 无日期筛选时自动限制 10 页，防止网页爆炸
- **数据看板 / 用量分析增强**
  - 新增 8 项详细 Token 统计条，与使用日志样式统一
  - 用量分析的 totals 接口扩展返回 `cacheReadTokens` / `cacheCreateTokens`
- **映射关系页面优化**
  - 折叠详情压缩为单行信息栏（类型 / 转发 / 秘钥 / 策略），节省纵向空间
  - 新增"刷新"按钮，方便手动重载数据

### 修复

- **导入配置后立即生效** — 导入备份不再需要重启服务，自动清空 providers/mappings 内存缓存并重新加载
- **使用日志缓存 Token 显示** — 索引文件升级到 v2，包含 `totalCacheReadTokens` / `totalCacheCreateTokens`，旧索引自动重建
- **映射切换 Tab 空白** — 修复 Alpine.js 深层嵌套模板在 x-show 切换时不更新的问题，providers 加载后强制 re-render mapping 卡片
- **导出文件名带时分秒** — `ai-gateway-hub-backup-2026-05-14-09-33-39.json`，避免同日多次备份覆盖

### 移除

- **会话粘性策略 (sticky)** — 移除（实测同一智能体/同项目的 system prompt 一致，会全部命中同一 provider，无法分散负载，与设计初衷不符）
- **删除日志按钮** — 系统日志页"清空"按钮移除，避免误操作；日志只能通过修改保留天数自动清理

---

## v1.0.0 — 2026-05-13

首个正式发布版本。

### 核心功能

- **多供应商汇聚** — 同时接入多个 OpenAI / Anthropic 兼容协议供应商
- **协议全矩阵转换** — OpenAI ↔ Anthropic 双向自动转换
- **灵活映射规则** — 自定义模型别名，多规则转发
- **4 种切换策略** — 固定 / 顺序 / 随机 / 最少使用
- **独立 SK 鉴权** — 每个映射独立的本地密钥
- **流式支持** — OpenAI SSE / Anthropic SSE 全路径流式透传

### 计费与日志

- **实时计费** — 内置 17 款模型定价（含缓存读写）
- **请求日志** — 365 天完整保留，按日期 / 供应商 / 模型 / 状态筛选，JSON / CSV 导出
- **数据看板** — 今日 / 本月统计 + 模型消耗分布 + 供应商占比
- **用量分析** — 5 段时间范围（1 天 ~ 12 个月）

### 界面与运维

- **8 个功能页** — 数据看板、使用日志、API 配置、聊天测试、用量分析、价格管理、系统日志、系统设置
- **7 套主题** — 浅色 / 深色 / 跟随系统 / 海洋蓝 / 森林绿 / 日落紫 / 暖纸黄
- **后台单实例运行** — PID 文件 + 端口探测双保险
- **配置备份与还原** — 一键导出 / 导入
- **跨平台** — Windows / Linux / macOS
