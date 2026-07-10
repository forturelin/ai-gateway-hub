# AI Gateway Hub 正确的优化实施总结

## 执行时间
2026-07-07

---

## 已完成的修改

### ✅ 1. 回滚错误的缓存修改

**文件**: `src/request-optimizer.js`

**修改**: 
```javascript
// 从错误的 8 改回正确的 4
firstMessages: messages.slice(0, 4).map(messageShape)
firstMessageShapes: messages.slice(0, 4).map(messageShape)
```

**原因**: 
- 扩大 cache key 范围会**降低**缓存命中率
- 网关不应该干预缓存策略
- 应该让上游模型和 agent 控制

---

### ✅ 2. 添加端点控制功能

#### 2.1 映射配置

**文件**: `src/route-mappings.js`

**新增字段**:
```javascript
{
  "type": "openai",
  "allowedEndpoints": ["chat", "responses"],  // 控制允许访问的端点
  ...
}
```

**可选值**:
- `["chat"]` - 只允许 `/v1/chat/completions`
- `["responses"]` - 只允许 `/v1/responses`
- `["chat", "responses"]` - 都允许（默认）
- `["messages"]` - Anthropic 类型的默认值

#### 2.2 端点权限检查

**文件**: 
- `src/routes/chat-route.js`
- `src/routes/responses-route.js`
- `src/routes/messages-route.js`

**新增检查**:
```javascript
// 检查端点权限
const allowedEndpoints = mapping.allowedEndpoints || ['chat', 'responses'];
if (!allowedEndpoints.includes('chat')) {
    return res.status(403).json({
        error: {
            type: 'permission_error',
            message: `This mapping does not allow access to /v1/chat/completions endpoint.`
        }
    });
}
```

---

### ✅ 3. 上下文限制的正确处理

**前端修改**: `public/js/app.js`
```javascript
contextLimit: 1000000  // 从 600000 提升到 1M
```

**但要明确**:
- ⚠️ 这只是**文档说明**，不是实际限制
- ⚠️ 真正的限制由**上游模型**决定（Claude Opus 200K tokens ≈ 800KB）
- ⚠️ 网关不应该也没有强制限制检查

**Cursor 日志显示的真实问题**:
```json
{"error":"User Provided API Key Rate Limit Exceeded"}
{"error":"Provider Error Provider returned error: "}
```

**结论**: 不是上下文问题，是**限流问题**！

---

## 需要补充的功能

### 🔨 待实现：模型 Health 检查

#### 后端 API

**新增端点**: `POST /api/providers/:id/health/:model`

**功能**:
```javascript
// 发送一个最小请求到上游，检查模型是否可用
{
  "model": "gpt-5.4",
  "available": true,
  "latency": 234,  // ms
  "error": null
}
```

#### 前端 UI

**位置**: API 配置 → 输入 API → 已探测模型列表

**新增按钮**: 每个模型旁边添加"检查"按钮

**显示结果**:
- ✅ 可用（显示延迟）
- ❌ 不可用（显示错误）
- ⏳ 检查中...

---

### 🔨 待实现：前端端点选择 UI

**文件**: `public/js/app.js`

**位置**: 映射配置弹窗

**新增控件**:
```html
<label>允许的端点：</label>
<div>
  <label><input type="checkbox" value="chat"> /v1/chat/completions</label>
  <label><input type="checkbox" value="responses"> /v1/responses</label>
  <label><input type="checkbox" value="messages"> /v1/messages</label>
</div>
```

**逻辑**:
- OpenAI 类型：可选 chat 和/或 responses
- Anthropic 类型：只能选 messages

---

### 🔨 待实现：改进错误日志

**目标**: 记录更详细的上游错误

**修改位置**: 
- `src/routes/chat-route.js`
- `src/routes/responses-route.js`
- `src/routes/messages-route.js`

**改进内容**:
```javascript
// 现在
logger.warn(`[Gateway] ${provider.name} HTTP ${status}: ${text.slice(0, 200)}`);

// 应该
logger.error(`[Gateway] ${provider.name} failed on ${route}`, {
    status,
    error: text,
    model: requestedModel,
    mappedModel: rule.mappedModel,
    isRateLimit: status === 429,
    upstreamResponse: text.slice(0, 500)
});
```

---

## 关键问题的正确答案

### Q1: 协议端点控制

**需求**: 控制某个 SK 只能访问特定端点

**解决方案**: ✅ 已实现 `allowedEndpoints` 字段

**日志显示**: ✅ `route` 字段已经显示实际端点
```json
{
  "route": "/v1/chat/completions",
  "method": "POST",
  ...
}
```

---

### Q2: 上下文限制

**误区**: 前端 1M 配置能解决 220K 问题

**真相**:
1. ❌ 前端配置不等于后端强制执行
2. ✅ 网关没有也不应该有上下文限制检查
3. ✅ 真正的限制由**上游模型**决定
4. ✅ Cursor 日志显示的是**限流问题**，不是上下文问题

**正确做法**:
- 前端配置作为**文档说明**
- 错误提示中说明不同模型的实际限制
- 不在网关层做限制检查

---

### Q3: 模型 Health 检查

**需求**: 探测后能单独检查每个模型

**状态**: 🔨 待实现（后端 API + 前端 UI）

---

### Q4: Cursor 日志分析

**真实问题**:
```
Line 20: User Provided API Key Rate Limit Exceeded  ← 限流
Line 18: Provider Error Provider returned error     ← 上游错误
```

**结论**:
- ❌ 不是协议转换问题
- ❌ 不是上下文限制问题  
- ✅ 是上游 API **限流**和**参数错误**

**建议**:
1. 检查上游供应商的限流配置
2. 降低请求频率
3. 检查 Cursor 使用的模型参数

---

### Q5: 缓存监控面板

**当前状态**: 
- ✅ 日志已显示单条的 `cacheReadTokens`、`cacheCreateTokens`
- ✅ 可以计算 `cacheHitRate = cacheReadTokens / inputTokens`

**我说的"缓存监控面板"**:
在统计页面添加**聚合分析**：
```
过去7天缓存效率
├─ 平均缓存命中率：65%
├─ 缓存节省 token：1.2M
├─ 缓存节省费用：$45.60
└─ 按供应商/模型/时间分组
```

**是否需要**: 由你决定

---

### Q6: 缓存优化的正确理解

**我的错误**:
```javascript
// ❌ 错误：扩大 cache key 范围
firstMessages: messages.slice(0, 8)  // 从 4 改成 8
```

**为什么错误**:
1. **Cache key ≠ Breakpoint**
   - Cache key = 用于路由的标识符
   - Breakpoint = Anthropic 实际缓存的分段点

2. **扩大范围降低命中率**
   - 更多消息参与哈希 → key 更容易变化
   - 对话第 5-8 条变化时，8条方案无法命中

3. **不是网关的责任**
   - 缓存注入由 `optimizeAnthropicPromptCaching` 决定
   - 网关只是中转，不应替 agent 做决策

**正确做法**:
- ✅ 已回滚到 4 条
- ✅ 保持原有缓存逻辑
- ✅ 让上游模型和 agent 控制缓存策略

---

## 文件修改清单

### 已修改文件

1. ✅ `src/request-optimizer.js` - 回滚缓存范围（8→4）
2. ✅ `src/route-mappings.js` - 添加 `allowedEndpoints` 字段
3. ✅ `src/routes/chat-route.js` - 添加端点权限检查
4. ✅ `src/routes/responses-route.js` - 添加端点权限检查
5. ✅ `src/routes/messages-route.js` - 添加端点权限检查
6. ✅ `public/js/app.js` - contextLimit 提升到 1M（仅文档说明）

### 待修改文件

7. 🔨 `src/routes/api-providers-route.js` - 添加模型 Health 检查端点
8. 🔨 `src/api-providers.js` - 实现 Health 检查逻辑
9. 🔨 `public/js/app.js` - 添加端点选择 UI
10. 🔨 `public/js/app.js` - 添加模型 Health 检查按钮
11. 🔨 各路由文件 - 改进错误日志记录

---

## 验证方法

### 1. 测试端点控制

```bash
# 创建一个只允许 chat 的映射
curl -X PUT http://127.0.0.1:44559/api/mappings/m_xxx \
  -H "Content-Type: application/json" \
  -d '{"allowedEndpoints": ["chat"]}'

# 测试 chat 端点（应该成功）
curl -X POST http://127.0.0.1:44559/v1/chat/completions \
  -H "Authorization: Bearer <localSk>" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}]}'

# 测试 responses 端点（应该 403）
curl -X POST http://127.0.0.1:44559/v1/responses \
  -H "Authorization: Bearer <localSk>" \
  -d '{"model":"gpt-5.4","input":"test"}'
```

### 2. 检查日志显示

```bash
# 查看日志中的 route 字段
cat ~/.ai-gateway-hub/request-logs/2026-07-07.jsonl | \
  jq '.route'
```

应该显示：
- `/v1/chat/completions`
- `/v1/responses`
- `/v1/messages`

---

## 下一步行动

### 立即重启服务
```bash
npm run restart
```

### 优先级

**P0 - 已完成**:
- ✅ 回滚错误的缓存修改
- ✅ 添加端点控制功能

**P1 - 需要继续**:
- 🔨 实现模型 Health 检查（后端 + 前端）
- 🔨 添加前端端点选择 UI
- 🔨 改进错误日志记录

**P2 - 可选**:
- 缓存聚合统计面板
- 更好的限流提示
- 文档补充

---

## 经验教训

1. **不要盲目优化** - 先理解机制，再做修改
2. **网关的责任边界** - 只做中转和路由，不做业务决策
3. **深入分析日志** - 真实问题往往和表象不同
4. **保持简单** - 复杂的优化可能适得其反

---

## 最终建议

### 关于上下文限制
- 在文档中明确说明不同模型的实际限制
- 不在网关层做强制限制
- 提供更好的错误提示

### 关于缓存优化
- 保持当前的缓存逻辑
- 不要干预上游模型的缓存策略
- 如果要优化，应该在 agent 层面做

### 关于 Cursor 问题
- 主要是限流问题
- 检查上游供应商配置
- 降低请求频率或增加配额

---

生成时间：2026-07-07
文档版本：v2.0（正确版本）
