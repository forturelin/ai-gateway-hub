# AI-Gateway-Hub

> 本地 AI API 网关。汇聚多个外部 API 供应商，通过自定义映射关系对外暴露统一端点，支持 OpenAI / Anthropic 协议全矩阵双向转换。

**版本**：v1.3.0  
**完成时间**：2026 年 5 月 20 日

---

## 功能概览

### 网关核心

- **多供应商汇聚** — 同时接入多个 OpenAI / Anthropic 兼容协议供应商，统一管理
- **协议全矩阵转换** — OpenAI ↔ Anthropic 双向自动转换，任意客户端对接任意供应商
- **灵活映射规则** — 自定义模型别名，一个映射下可挂多条转发规则
- **5 种切换策略** — 固定 / 顺序 / 随机 / 最少使用 / **时间段轮换**（按周期自动切换，支持当前生效指示、强制激活、延长窗口、实时倒计时）
- **独立 SK 鉴权** — 每个映射持有独立的本地密钥，互不干扰
- **流式支持** — OpenAI SSE / Anthropic SSE 全路径流式透传

### 提示缓存与长会话（v1.3.0+）

- **OpenAI 原生 Responses 透传** — OpenAI 供应商可启用 `supportsNativeResponses`，`/v1/responses` 直接转发到上游 `/responses`，保留 `previous_response_id`、`store`、reasoning 与工具调用状态
- **Prompt Cache 自动优化** — 为 OpenAI 注入稳定 `prompt_cache_key` / `prompt_cache_retention`，为 Anthropic 自动补 cache breakpoint，提升长上下文与工具型对话的缓存命中率
- **缓存预热防抖** — 同一稳定前缀并发请求会短暂排队，减少首轮缓存尚未写入时的重复 cache miss
- **缓存用量透传** — 协议转换时保留 OpenAI `cached_tokens` 与 Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`，日志和统计可以完整还原缓存读写

### 费用与统计

- **实时计费** — 内置 17 款模型定价（含缓存读写），按 OpenAI / Anthropic 官方缓存口径估算费用，支持自定义覆盖和请求级价格快照
- **Token 八维统计** — 输入 / 输出 / 缓存读 / 缓存写 / 输入输出Token / 总Token / 总费用 / 错误，统一展示在数据看板、用量分析、使用日志三个页面
- **数据看板** — 今日 / 本月统计卡片 + 详细 Token 明细 + 模型消耗分布 + 供应商占比 + 近期请求
- **用量分析** — 5 段时间范围（1 天 ~ 12 个月），趋势图 + 供应商 / 模型分析表 + 详细 Token 明细

### 日志

- **请求日志** — 365 天完整保留；显示别名、推理强度、缓存读写等多维信息；按日期 / 供应商 / 模型 / 状态筛选；JSON / CSV 导出；无日期筛选时自动限 10 页保护浏览器
- **推理强度智能识别** — 自动提取 Anthropic `thinking`（enabled / adaptive / budget_tokens）、OpenAI `reasoning_effort`、Cherry Studio `output_config.effort` 等多种格式
- **系统日志** — SSE 实时推送，5 级颜色过滤（INFO / WARN / ERROR / SUCCESS / DEBUG）
- **自动清理** — 仅通过修改保留天数触发自动删减，无手动删除按钮，避免误操作

### 界面

- **8 个功能页** — 数据看板、使用日志、API 配置、聊天测试、用量分析、价格管理、系统日志、系统设置
- **7 套主题** — 浅色 / 深色 / 跟随系统 / 海洋蓝 / 森林绿 / 日落紫 / 暖纸黄
- **聊天测试** — 页面内直接调试对话，支持流式 / 非流式，温度可调

### 运维

- **后台单实例运行** — PID 文件 + 端口探测双保险
- **交互式控制面板** — 数字菜单操作，一键启动 / 停止 / 重启
- **配置备份与还原** — 一键导出 / 导入供应商、映射、价格、设置
- **跨平台** — Windows（.bat）/ Linux & macOS（.sh）

### 网络与跨网段（v1.2.0+）

- **监听地址可切换** — 系统设置 → 网络监听，下拉在 `127.0.0.1`（仅本机）/ `0.0.0.0`（开放局域网/内网）之间切换
- **防火墙一键管理** — 自动探测规则状态；一键复制「开放端口」/「移除规则」管理员命令；独立辅助脚本 `bin/setup-firewall.{bat,sh}`（Linux 自动 ufw → firewalld → iptables 级联）
- **Loopback 双绑定防劫持** — 监听 `0.0.0.0` 时同进程同时占住 `127.0.0.1:PORT`，防止 VSCode Remote-SSH 端口转发或其他进程在 Windows 上抢占 loopback 导致 curl 超时
- **多 IP 展示** — 自动枚举本机所有 IPv4，告诉团队成员该用哪个地址访问

> ⚠ **安全提示**：监听 `0.0.0.0` + 防火墙开放 = 局域网任何人都能尝试访问网关。请为每个映射设置足够长的随机本地 SK（`localSk`），定期轮换；不需要跨网段时切回 `127.0.0.1` 并移除防火墙规则。

---

## 协议转换矩阵

| 客户端协议 | 供应商协议 | 状态 | 说明 |
|-----------|-----------|------|------|
| OpenAI → OpenAI | ✅ | 直通 + 流式 |
| OpenAI → Anthropic | ✅ | 自动转换，非流式回包装为 SSE |
| Anthropic → Anthropic | ✅ | 直通 + 流式 |
| Anthropic → OpenAI | ✅ | 自动转换，SSE 收集后转 Anthropic 格式 |

---

## 快速启动

### 前置条件

- Node.js ≥ 18

### 安装与启动

```bash
cd ai-gateway-hub
npm install

# 方式一：交互式控制面板（推荐）
# Windows
bin\ai-gateway.bat
# Linux / macOS
chmod +x bin/ai-gateway.sh
./bin/ai-gateway.sh

# 方式二：npm 命令
npm run start:bg     # 后台启动
npm run status       # 查看状态
npm run logs         # 查看日志
npm run stop         # 停止
npm run restart      # 重启

# 方式三：前台运行（开发调试）
npm start            # Ctrl+C 退出
```

启动后浏览器访问 `http://127.0.0.1:44559`。

### 切换到局域网/内网访问（团队多人共用一个网关）

打开 Web UI → **系统设置 → 网络监听**：

1. 监听地址下拉切到 `0.0.0.0`（开放局域网/内网），保存
2. 点击「📋 复制开放端口命令」，粘贴到 **管理员 PowerShell** 执行（一次性，重启不丢）
3. 按提示重启服务：`npm run restart`
4. 团队成员把 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 改成 `http://<本机 IP>:44559`，使用各自映射的 `localSk` 即可

⚠ 开启局域网监听后，务必：① 为每个映射设置足够长的随机 `localSk` ② 定期轮换 ③ 不需要时切回 `127.0.0.1`。详见 [#网络与跨网段](#网络与跨网段v120)。

---

## 使用流程

### 1. 添加供应商

打开 Web UI → **API 配置** → **输入 API**：

1. 点击「添加供应商」，选择协议类型（OpenAI / Anthropic）
2. 填写别名、地址（BaseURL）、密钥（API Key）
3. 点击「探测模型」拉取可用模型列表，勾选需要的模型
4. 点击「校验」确认密钥有效

### 2. 创建映射

**API 配置** → **映射关系**：

1. 点击「新建映射」，填写名称，选择类型（openai / anthropic）
2. 设置本地密钥（localSk），客户端将用此密钥访问
3. 选择切换策略：
   - **固定 / 顺序 / 随机 / 最少使用** — 经典策略
   - **时间段轮换** — 多账号摊费用首选；可设轮换周期（≥30 分钟），同窗口内所有请求走同一个 provider，到期自动切下一个；支持强制激活某规则、延长窗口、实时倒计时
4. 展开映射 → 点击「新增规则」→ 选择供应商、客户端模型名、映射模型名

### 3. 配置客户端

**API 配置** → **输出端点** 页面有完整示例。核心配置：

```bash
# OpenAI 协议客户端
export OPENAI_BASE_URL=http://127.0.0.1:44559/v1
export OPENAI_API_KEY=<映射的 localSk>

# Anthropic 协议客户端（如 Claude Code）
export ANTHROPIC_BASE_URL=http://127.0.0.1:44559
export ANTHROPIC_API_KEY=<映射的 localSk>
```

> 映射类型不限制端点：任何 SK 均可在 `/v1/responses` 和 `/v1/messages` 两个端点使用，网关自动处理协议转换。

---

## 控制脚本

运行 `bin/ai-gateway.bat`（Windows）或 `./bin/ai-gateway.sh`（Linux/macOS）进入交互菜单：

```
╔══════════════════════════════════════════╗
║        AI-Gateway-Hub 控制面板           ║
╚══════════════════════════════════════════╝
  状态: ● 运行中 (PID 12345)  地址: http://127.0.0.1:44559

  1  启动服务
  2  停止服务
  3  重启服务
  4  查看状态
  5  查看日志（最近 100 行）
  0  退出
```

也支持直接传参：`bin/ai-gateway.bat start`、`./bin/ai-gateway.sh restart`。

---

## 配置文件

`config.json`（项目根目录）：

```json
{
  "port": 44559,
  "host": "127.0.0.1",
  "configDir": "~/.ai-gateway-hub",
  "logging": {
    "enabled": true,
    "retentionDays": 365
  }
}
```

通过环境变量 `AGH_CONFIG=path/to/config.json` 指向自定义配置文件。

---

## 数据存储

所有运行数据存储在 `~/.ai-gateway-hub/`（Windows: `C:\Users\<用户>\.ai-gateway-hub\`）：

| 文件 | 说明 |
|------|------|
| `api-providers.json` | 供应商配置 |
| `route-mappings.json` | 映射关系与转发规则 |
| `pricing.json` | 用户自定义价格（覆盖内置默认） |
| `usage-stats.json` | 聚合统计（daily / monthly / byProvider / byModel） |
| `usage-history.json` | 请求历史（365 天自动清理） |
| `request-logs/YYYY-MM-DD.jsonl` | 每日请求详细日志（含请求体 / 响应体、推理强度、token 详情） |
| `request-logs/.index.json` | 日聚合索引 v2（含缓存 token 总和），快速汇总查询 |
| `settings.json` | 系统设置 |
| `server.pid` | 后台进程 PID |
| `server.log` | 后台运行日志 |

---

## 内置价格表

20 条内置定价（2026-05-13），单位 USD / 1M tokens。可在「价格管理」页面自定义覆盖。

**OpenAI 兼容**（14 条）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 |
|------|------|------|--------|--------|
| gpt-5.2 | 1.75 | 14.00 | 0.175 | 0 |
| gpt-5.4 | 2.50 | 15.00 | 0.25 | 0 |
| gpt-5.4-mini | 0.75 | 4.50 | 0.75 | 0 |
| gpt-5.5 | 5.00 | 30.00 | 0.50 | 0 |
| gpt-5.6-sol | 5.00 | 30.00 | 0.50 | 0 |
| gpt-5.6-terra | 2.50 | 15.00 | 0.25 | 0 |
| gpt-5.6-luna | 1.00 | 6.00 | 0.10 | 0 |
| gpt-5.3-codex | 1.75 | 14.00 | 0.175 | 0 |
| minimax-m2.7 | 0.299 | 1.20 | 0.06 | 0 |
| glm-5 | 0.60 | 1.92 | 0.06 | 0 |
| glm-5.1 | 1.40 | 4.40 | 0.26 | 0 |
| gemini-3.1-pro | 2.00 | 12.00 | 0.20 | 0 |
| deepseek-v4-pro | 3.00 | 6.00 | 0.25 | 0 |
| deepseek-v4-flash | 1.00 | 2.00 | 0.02 | 0 |

**Anthropic**（4 条）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 |
|------|------|------|--------|--------|
| claude-opus-4-7 | 5.00 | 25.00 | 0.50 | 0 |
| claude-opus-4-8 | 5.00 | 25.00 | 0.50 | 0 |
| claude-fable-5 | 10.00 | 50.00 | 1.00 | 0 |
| claude-mythos-5 | 10.00 | 50.00 | 1.00 | 0 |

---

## API 端点

### 网关端点（客户端调用）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/responses` | OpenAI Responses API |
| POST | `/v1/messages` | Anthropic Messages |
| GET | `/v1/models` | 返回当前 SK 对应的可用模型列表 |
| GET | `/health` | 健康检查 |

### 管理接口（Web UI 使用）

| 模块 | 端点 |
|------|------|
| 供应商 | `GET/POST /api/providers`、`GET/PUT/DELETE /api/providers/:id`、`POST .../discover`、`POST .../validate` |
| 映射 | `GET/POST /api/mappings`、`GET/PUT/DELETE /api/mappings/:id` |
| 价格 | `GET /api/pricing`、`PUT /api/pricing/:key`、`DELETE /api/pricing/:key`、`POST /api/pricing` |
| 用量 | `GET /api/usage/*`（overview / daily / monthly / providers / models / history / range） |
| 日志 | `GET /api/logs`、`GET /api/logs/export`、`GET /api/logs/settings`、`PUT /api/logs/settings` |
| 系统 | `GET /api/settings`、`PUT /api/settings`、`GET /api/syslog/stream`（SSE） |
| 备份 | `GET /api/backup`（下载）、`POST /api/import`（还原） |

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express + ES Modules |
| 前端 | Alpine.js 3 + Chart.js 4（CDN，无构建步骤） |
| 存储 | JSON 文件（无数据库依赖） |
| 依赖 | express、cors（仅 2 个生产依赖） |

## 协议

MIT

---

更新历史详见 [CHANGE.md](CHANGE.md)。
