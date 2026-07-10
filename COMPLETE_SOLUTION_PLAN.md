# AI Gateway Hub - 完全透传方案

## 核心问题

**你说得完全对**：网关应该**完全透传**，不应该干预任何缓存、优化逻辑。

当前问题：
1. ❌ 网关在注入 `cache_control`
2. ❌ 网关在生成 `prompt_cache_key`
3. ❌ 网关在做"缓存预热"
4. ❌ 网关在做"thinking 优化"
5. ❌ 这些干预可能**降低**缓存命中率（从 95% 降低）

---

## 缓存干预的位置

### 1. Anthropic Messages 路由
**文件**: `src/routes/messages-route.js`
- Line 73: `optimizeAnthropicPromptCaching(optimizedBody, { cacheTtl }).body`
- Line 64: `withAnthropicPromptCacheWarmup()`

### 2. OpenAI Chat 路由
**文件**: `src/routes/chat-route.js`
- Line 264: `withOpenAIPromptCacheKey(body, context)`
- Line 61: `withAnthropicPromptCacheWarmup()`

### 3. OpenAI Responses 路由
**文件**: `src/routes/responses-route.js`
- Line 381: `withOpenAIPromptCacheKey(_prepareNativeResponsesBody(body), context)`
- Line 456: `withOpenAIPromptCacheKey(body, context)`
- Line 524: `withAnthropicPromptCacheWarmup()`

### 4. Format Bridge
**文件**: `src/providers/format-bridge.js`
- Line 252: `optimizeAnthropicPromptCaching(out, { skipIfPresent: false, cacheTtl: options.cacheTtl }).body`

---

## 解决方案

### 方案A：完全禁用（推荐）

**原则**：网关只做协议转换和路由，不做任何优化

**实施**：
1. 添加全局开关 `disableCacheIntervention: true`
2. 当开关启用时，**完全跳过**所有缓存相关逻辑
3. 直接转发原始请求

**修改位置**：
- `src/routes/settings-route.js` - 添加开关
- 三个路由文件 - 检查开关，跳过缓存逻辑
- `src/providers/format-bridge.js` - 跳过缓存注入

### 方案B：保留开关（当前）

**当前状态**：
```javascript
bedrockOptimizer: {
  enabled: true,
  thinking: true,
  cacheInjection: true,
  cacheTtl: '1h'
}
```

**问题**：
- 默认启用，用户不知道
- 可能干扰 agent 的缓存策略
- 可能降低缓存命中率

**建议改为**：
```javascript
bedrockOptimizer: {
  enabled: false,  // 默认禁用
  thinking: false,
  cacheInjection: false,
  cacheTtl: '5m'
}
```

---

## 问题3：上下文限制声明

**你的需求**：
```
gpt-5.4 → 需要申明 max_tokens 宏
gpt-5.5 → 需要申明 max_tokens 宏
opus-4.8 → 需要在模型名后加 [1m]
```

**解决方案**：

### 选项1：在供应商配置中添加模型元数据

**Schema**:
```javascript
{
  "selectedModels": ["gpt-5.4", "opus-4.8"],
  "modelMetadata": {
    "gpt-5.4": {
      "maxContextTokens": 1000000,
      "displayName": "gpt-5.4 [1M]"
    },
    "opus-4.8": {
      "maxContextTokens": 1000000,
      "displayName": "claude-opus-4.8 [1M]"
    }
  }
}
```

### 选项2：全局模型配置文件

**文件**: `model-specs.json`
```json
{
  "models": {
    "gpt-5.4": {"maxTokens": 1000000, "vendor": "openai"},
    "gpt-5.5": {"maxTokens": 1000000, "vendor": "openai"},
    "claude-opus-4.8": {"maxTokens": 1000000, "vendor": "anthropic"}
  }
}
```

### 选项3：前端显示标注

在模型列表显示时自动添加 `[1M]` 标签

**你倾向于哪种方式？**

---

## 问题4：模型健康检查

**需求**：
- 每个模型都能单独检查
- 连续点击多个，正常显示所有结果
- 不阻塞 UI

**实施方案**：

### 后端 API
```javascript
POST /api/providers/:providerId/health
Body: { models: ["gpt-5.4", "gpt-5.5"] }

Response: {
  "gpt-5.4": {
    "status": "available",
    "latency": 234,
    "testedAt": "2026-07-07T..."
  },
  "gpt-5.5": {
    "status": "error",
    "error": "Rate limit exceeded",
    "testedAt": "2026-07-07T..."
  }
}
```

### 前端 UI
```javascript
// 模型列表每个模型旁边
<button @click="checkModelHealth(model)">
  <span x-show="!checking[model.id]">检查</span>
  <span x-show="checking[model.id]">⏳</span>
</button>
<span x-show="healthStatus[model.id]">
  <span x-show="healthStatus[model.id].status === 'available'" 
        class="text-green-600">
    ✓ 可用 ({{healthStatus[model.id].latency}}ms)
  </span>
  <span x-show="healthStatus[model.id].status === 'error'" 
        class="text-red-600">
    ✗ {{healthStatus[model.id].error}}
  </span>
</span>
```

---

## 问题5：端点选择 UI

**你的问题**：一个 key 都是一个类型输出？还是按输出模型？

**我的理解**：
- 一个 mapping（一个 key）→ 控制允许的端点
- 不是按模型，是按整个 mapping

**推荐方案**：

### UI 设计
```
映射配置
├─ 名称：主力映射
├─ 类型：○ OpenAI  ○ Anthropic
├─ 本地密钥：sk-xxxxx
└─ 允许的端点：（仅 OpenAI 类型显示）
    ☑ /v1/chat/completions
    ☑ /v1/responses
```

### 逻辑
- Anthropic 类型：固定只能用 `/v1/messages`
- OpenAI 类型：可以选择 `chat` 和/或 `responses`
- 默认：都勾选（向后兼容）

**这样设计对吗？**

---

## 问题6：日志显示协议

**需求**：UI 显示具体是哪个协议端点

**当前状态**：
日志已经有 `route` 字段：
```json
{
  "route": "/v1/chat/completions",
  "method": "POST",
  ...
}
```

**需要改进的地方**：

### 1. 使用日志页面
在"使用日志"表格中添加"协议"列：
```
时间 | 协议 | 供应商 | 模型 | Token | 费用
-----|------|--------|------|-------|-----
14:30| chat | OpenAI | gpt-5.4 | 1.2K | $0.02
14:31| resp | OpenAI | gpt-5.4 | 0.8K | $0.01
14:32| msg  | Claude | opus-4.8| 2.1K | $0.05
```

### 2. 协议显示映射
```javascript
const protocolLabels = {
  '/v1/chat/completions': 'Chat',
  '/v1/responses': 'Responses',
  '/v1/messages': 'Messages'
};
```

**需要实现吗？**

---

## 问题7：缓存聚合面板

**需求**：统计页面显示缓存效率

### 设计方案

#### 位置
数据看板或用量分析页面

#### 内容
```
📊 缓存效率统计（过去7天）

总览
├─ 平均缓存命中率：68.5%
├─ 缓存读取 Token：2,345,678
├─ 缓存创建 Token：456,789
├─ 缓存节省费用：$89.23
└─ 提示：缓存命中率 = 缓存读取 / 总输入

趋势图
[折线图：每日缓存命中率]

按供应商分组
├─ OpenAI：命中率 72%, 节省 $45.67
├─ Claude：命中率 65%, 节省 $43.56
└─ ...

按模型分组
├─ gpt-5.4：命中率 75%, 节省 $32.11
├─ opus-4.8：命中率 62%, 节省 $28.45
└─ ...

缓存效率排行
1. gpt-5.4 @ provider-A：命中率 85%
2. opus-4.8 @ provider-B：命中率 78%
3. ...
```

#### 计算公式
```javascript
// 缓存命中率
cacheHitRate = cacheReadTokens / inputTokens

// 缓存节省费用
cacheSavings = cacheReadTokens * (inputPrice - cachePrice)

// 缓存创建成本
cacheCreationCost = cacheCreateTokens * cacheWritePrice
```

**需要实现吗？在哪个页面？**

---

## 实施优先级

请你确认每个功能的优先级：

### P0 - 必须立即做
- [ ] 问题2：**完全禁用缓存干预**（默认关闭）
- [ ] 问题6：日志显示协议列

### P1 - 重要
- [ ] 问题1：改进错误处理和日志
- [ ] 问题4：模型健康检查
- [ ] 问题5：端点选择 UI

### P2 - 增强
- [ ] 问题3：上下文限制声明
- [ ] 问题7：缓存聚合面板

---

## 请你回答

1. **问题2**：完全禁用缓存干预，默认关闭？还是完全移除代码？
2. **问题3**：上下文声明用哪种方式？供应商配置？全局文件？前端显示？
3. **问题5**：端点选择的设计对吗？
4. **问题6**：日志显示协议，具体怎么显示？简写（chat/resp/msg）还是全名？
5. **问题7**：缓存面板放在哪个页面？数据看板？用量分析？
6. **优先级**：请确认 P0/P1/P2 的优先级

我等你确认后立即开始实施。
