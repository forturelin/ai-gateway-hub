# 需要你确认的问题

## 已完成的修改

### ✅ 1. 缓存干预默认禁用
**文件**: `src/routes/settings-route.js`
**修改**: `bedrockOptimizer` 默认全部关闭
```javascript
bedrockOptimizer: { 
  enabled: false,      // 从 true 改为 false
  thinking: false,     // 从 true 改为 false
  cacheInjection: false, // 从 true 改为 false
  cacheTtl: '5m'       // 从 '1h' 改为 '5m'
}
```

**效果**: 
- 新安装默认不干预缓存
- 已有用户需要在设置中手动关闭
- 完全透传 agent 的请求

---

## 需要你确认的问题

### 问题1：Cursor 错误处理

**Cursor 日志显示的错误**:
```
Provider Error Provider returned error: 
User Provided API Key Rate Limit Exceeded
```

**当前问题**:
- 上游返回空错误信息
- 限流错误没有被正确处理

**我的方案**:
1. 完整记录上游错误（包括响应体）
2. 遇到 429 限流时，自动尝试下一个 provider
3. 添加详细的错误日志

**需要确认**: 
- ✅ 是否需要自动重试下一个 provider？
- ✅ 是否需要记录完整的上游响应（可能很大）？

---

### 问题2：缓存干预 - 完全移除还是保留开关？

**当前状态**: 
- 已设置默认关闭
- 代码仍然存在，可以通过设置启用

**选项A**: 保留开关（当前）
- ✅ 高级用户可以启用
- ✅ 向后兼容
- ❌ 代码复杂

**选项B**: 完全移除代码
- ✅ 代码简洁
- ✅ 完全透传
- ❌ 无法恢复

**你的选择**: A 还是 B？

**我的建议**: 选 A，但在 UI 中明确标注"**不推荐启用，会降低缓存命中率**"

---

### 问题3：上下文限制声明

**你的需求**:
```
gpt-5.4, gpt-5.5 → 需要向上游申明 max_tokens 宏
claude-opus-4.8 → 需要在模型名后加 [1M] 标识
```

**选项A**: 在供应商配置中添加
```json
{
  "id": "p_xxx",
  "selectedModels": ["gpt-5.4"],
  "modelMetadata": {
    "gpt-5.4": {
      "contextLimit": 1000000,
      "displayName": "gpt-5.4 [1M]"
    }
  }
}
```

**选项B**: 全局配置文件
```json
// model-specs.json
{
  "gpt-5.4": {"context": 1000000},
  "gpt-5.5": {"context": 1000000},
  "claude-opus-4.8": {"context": 1000000}
}
```

**选项C**: 仅前端显示
- 探测模型后，自动识别并显示 `[1M]` 标签
- 不存储到配置

**你的选择**: A、B 还是 C？

**我的建议**: 选 C（最简单），或者 B（可维护）

---

### 问题4：模型健康检查

**需求**: 连续点击多个模型，都能正常显示结果

**方案**: 并发检查 + 实时更新状态

```javascript
// 前端逻辑
async checkModelHealth(model) {
  this.healthStatus[model.id] = { status: 'checking' };
  
  try {
    const res = await fetch(`/api/providers/${provider.id}/health`, {
      method: 'POST',
      body: JSON.stringify({ models: [model.id] })
    });
    const data = await res.json();
    
    this.healthStatus[model.id] = {
      status: data[model.id].status,
      latency: data[model.id].latency,
      error: data[model.id].error
    };
  } catch (err) {
    this.healthStatus[model.id] = { status: 'error', error: err.message };
  }
}
```

**后端实现**: 发送最小测试请求
```javascript
{
  "model": "gpt-5.4",
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 1
}
```

**需要确认**:
- ✅ 这个方案可以吗？
- ✅ 测试请求用 max_tokens=1 行吗？
- ✅ 是否需要缓存检查结果（5分钟内不重复检查）？

---

### 问题5：端点选择 UI

**设计方案**:

```
映射配置弹窗
├─ 名称: [输入框]
├─ 类型: ○ OpenAI  ○ Anthropic
├─ 本地密钥: [输入框] [生成]
└─ 允许的端点: (仅 OpenAI 类型显示)
    ☑ /v1/chat/completions
    ☑ /v1/responses
    提示: Anthropic 类型固定使用 /v1/messages
```

**逻辑**:
- 默认全选（向后兼容）
- Anthropic 类型不显示此选项
- 至少选一个

**需要确认**:
- ✅ 这个设计可以吗？
- ✅ 是否需要在映射列表中显示允许的端点？

---

### 问题6：日志显示协议

**当前日志**:
```json
{
  "route": "/v1/chat/completions",
  "timestamp": "...",
  ...
}
```

**UI 显示方案**:

**选项A**: 新增"协议"列（简写）
```
时间     | 协议 | 供应商  | 模型      | Token | 费用
---------|------|---------|-----------|-------|------
14:30:45 | Chat | OpenAI  | gpt-5.4   | 1.2K  | $0.02
14:31:12 | Resp | OpenAI  | gpt-5.4   | 0.8K  | $0.01
14:32:08 | Msg  | Claude  | opus-4.8  | 2.1K  | $0.05
```

**选项B**: 新增"端点"列（完整路径）
```
时间     | 端点                   | 供应商  | 模型
---------|------------------------|---------|----------
14:30:45 | /v1/chat/completions   | OpenAI  | gpt-5.4
14:31:12 | /v1/responses          | OpenAI  | gpt-5.4
```

**选项C**: 在现有"路由"列显示
```
路由                        | 供应商  | 模型
----------------------------|---------|----------
POST /v1/chat/completions   | OpenAI  | gpt-5.4
POST /v1/responses          | OpenAI  | gpt-5.4
```

**你的选择**: A、B 还是 C？

**我的建议**: 选 A（最清晰）

---

### 问题7：缓存聚合面板

**需求**: 统计页面显示缓存效率

**方案**: 在"用量分析"页面添加"缓存效率"标签

```
用量分析
├─ 总览      (现有)
├─ 供应商    (现有)
├─ 模型      (现有)
└─ 缓存效率  (新增) ← 显示聚合数据
    ├─ 总览卡片
    │   ├─ 平均命中率: 68.5%
    │   ├─ 缓存读取: 2.3M tokens
    │   ├─ 缓存创建: 456K tokens
    │   └─ 节省费用: $89.23
    ├─ 趋势图 (每日命中率)
    ├─ 按供应商分组
    └─ 按模型分组
```

**计算公式**:
```javascript
命中率 = cacheReadTokens / inputTokens
节省费用 = cacheReadTokens × (inputPrice - cacheReadPrice)
```

**需要确认**:
- ✅ 这个设计可以吗？
- ✅ 放在"用量分析"页面合适吗？
- ✅ 还需要其他指标吗？

---

## 你的回答清单

请逐一回答：

### 问题1 (Cursor 错误)
- [ ] 是否自动重试下一个 provider？
- [ ] 是否记录完整上游响应？

### 问题2 (缓存干预)
- [ ] A. 保留开关（默认关闭）
- [ ] B. 完全移除代码

### 问题3 (上下文声明)
- [ ] A. 供应商配置
- [ ] B. 全局配置文件
- [ ] C. 仅前端显示

### 问题4 (模型健康检查)
- [ ] 方案是否可行？
- [ ] max_tokens=1 是否可行？
- [ ] 是否需要缓存结果？

### 问题5 (端点选择 UI)
- [ ] 设计是否可以？
- [ ] 是否在列表中显示端点？

### 问题6 (日志显示协议)
- [ ] A. 简写（Chat/Resp/Msg）
- [ ] B. 完整路径
- [ ] C. 在路由列显示

### 问题7 (缓存聚合面板)
- [ ] 设计是否可以？
- [ ] 放在用量分析页面？
- [ ] 还需要其他指标？

---

## 我的建议汇总

基于你的需求，我建议：

1. **Cursor 错误**: ✅ 自动重试，✅ 完整日志
2. **缓存干预**: **A** - 保留开关（已默认关闭）
3. **上下文声明**: **C** - 仅前端显示（最简单）
4. **健康检查**: ✅ 可行，max_tokens=1，缓存5分钟
5. **端点选择**: ✅ 可以，在列表显示
6. **日志协议**: **A** - 简写（最清晰）
7. **缓存面板**: ✅ 可以，放用量分析

**请你确认后，我立即开始实施所有功能。**
