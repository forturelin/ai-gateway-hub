# AI Gateway Hub 优化方案

## 问题分析与解决方案

### 1. 协议转换完整性检查

**现状分析**：
通过代码审查，发现所有协议转换路径**已经完整实现**：

| 客户端协议 | 上游协议 | 实现文件 | 状态 |
|-----------|---------|---------|------|
| `/v1/chat/completions` → OpenAI | `chat-route.js:106-166` | ✅ 已实现 |
| `/v1/chat/completions` → Anthropic | `chat-route.js:58-102` | ✅ 已实现（通过 format-bridge） |
| `/v1/responses` → OpenAI | `responses-route.js:542-675` | ✅ 已实现（含 Native 透传） |
| `/v1/responses` → Anthropic | `responses-route.js:520-540` | ✅ 已实现（通过 format-bridge） |
| `/v1/messages` → Anthropic | `messages-route.js:52-74` | ✅ 已实现 |
| `/v1/messages` → OpenAI | `messages-route.js:76-135` | ✅ 已实现（通过 format-bridge） |

**Cursor 中断问题可能原因**：
1. **不是协议转换问题** - 所有转换路径已完整
2. **可能是前端模型探测问题** - UI 在探测模型后需要补充逻辑
3. **可能是缓存配置问题** - 缓存优化可能影响响应

**建议**：
- 检查前端 `discoverModels` 功能，确保探测后正确显示模型列表
- 添加详细的错误日志，定位 Cursor 中断的具体原因

---

### 2. 上下文长度限制提升

**现状**：
- 前端硬编码 `contextLimit: 600000` (600K)
- 后端没有上下文长度验证/限制
- 问题出现在 220K 左右

**优化方案**：
1. **提升前端默认值到 1M**
   - `app.js:1637, 1652, 1660` 修改 `contextLimit: 1000000`
   
2. **添加模型级别的上下文配置**
   - 不同模型支持不同的上下文长度
   - Claude Opus 4.x: 200K tokens (~800KB)
   - GPT-5.x: 128K-1M tokens
   
3. **检查 220K 问题根源**
   - 可能是 JSON 解析限制（Express body-parser 默认 100KB）
   - 可能是缓存 key 生成时的限制

**实施**：
```javascript
// 修改前端默认值
contextLimit: 1000000  // 从 600000 提升到 1M

// 检查后端 Express 配置
app.use(express.json({ limit: '10mb' }))  // 确保足够大
```

---

### 3. 缓存命中率优化

**现有缓存机制**：
1. **Anthropic 缓存注入** - `optimizeAnthropicPromptCaching`
   - 自动在 system 末尾和倒数第二条消息添加 cache_control
   
2. **OpenAI 缓存 Key** - `withOpenAIPromptCacheKey`
   - 生成稳定的 `prompt_cache_key` 基于 system + tools + 前 4 条消息
   
3. **缓存预热防抖** - `withPromptCacheWarmup`
   - 同一前缀的并发请求排队，避免重复 cache miss

**可能影响缓存命中的因素**：

1. **Claude Code Attribution 字段**
   - `x-anthropic-billing-header: cc_version=...` 会改变哈希
   - 已有 `stripClaudeCodeAttribution` 处理，但可能不完整

2. **消息顺序和内容微小变化**
   - JSON 序列化顺序不稳定
   - 已有 `stableStringify` 处理，但可能有遗漏

3. **缓存 Key 计算范围过小**
   - 当前只使用前 4 条消息，长对话可能不够
   - 建议：使用前 8-10 条消息或动态调整

4. **缓存 TTL 不一致**
   - 5m vs 1h 会导致不同的 cache key
   - 建议：统一使用 1h TTL

**优化措施**：

```javascript
// 1. 增加 cache key 覆盖范围
firstMessages: messages.slice(0, 8).map(messageShape)  // 从 4 提升到 8

// 2. 添加缓存命中率监控
logRequest({
  ...
  cacheHitRate: cacheReadTokens / (inputTokens + cacheReadTokens),
  prefixStability: cachePrefixDiagnostics.prefixHash
})

// 3. 优化 cache_control 注入逻辑
// 确保 tools 定义也参与缓存
if (out.tools?.length) {
  out.system = (out.system || '') + '\n' + JSON.stringify(out.tools);
  out.system = [{ type: 'text', text: out.system, cache_control: { type: 'ephemeral' } }];
}
```

---

### 4. 前端 UI 模型探测后续问题

**问题描述**：
"输入 API 的页面，在探测模型之后，缺少..." （描述不完整）

**猜测可能的问题**：
1. 探测模型后，模型列表显示为空
2. 探测模型后，保存按钮不可用
3. 探测模型后，没有自动勾选模型
4. 探测模型后，验证按钮状态未更新

**需要确认的具体症状**：
- 探测按钮点击后有无加载提示？
- 模型列表是否正确展示？
- 是否有错误提示？

**建议改进**：
```javascript
// 添加探测后的反馈
async discoverProviderModels() {
  this.providerModal.discovering = true;
  this.providerModal.discoverError = '';
  try {
    const res = await fetch('/api/providers/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: this.providerModal.form.type,
        baseUrl: this.providerModal.form.baseUrl,
        apiKey: this.providerModal.form.apiKey
      })
    });
    const data = await res.json();
    if (!res.ok) {
      this.providerModal.discoverError = data.error || '探测失败';
      this.toast('error', '探测失败', this.providerModal.discoverError);
      return;
    }
    this.providerModal.form.models = data.models || [];
    
    // 改进：自动勾选所有模型
    if (this.providerModal.form.models.length > 0) {
      this.providerModal.form.models.forEach(m => m.enabled = true);
      this.toast('success', `成功探测到 ${this.providerModal.form.models.length} 个模型`);
    } else {
      this.toast('warn', '未探测到可用模型');
    }
  } catch (err) {
    this.providerModal.discoverError = err.message;
    this.toast('error', '探测异常', err.message);
  } finally {
    this.providerModal.discovering = false;
  }
}
```

---

## 实施优先级

### P0 - 立即修复
1. ✅ 提升 contextLimit 到 1M（前端 3 处修改）
2. ✅ 检查 Express body-parser 限制
3. ✅ 增加缓存 key 覆盖范围（4→8 条消息）

### P1 - 重要改进
4. 添加前端模型探测后的完善反馈
5. 统一缓存 TTL 为 1h
6. 添加缓存命中率监控到日志

### P2 - 增强功能
7. 添加模型级别的上下文配置
8. 优化 cache_control 注入逻辑（含 tools）
9. 添加详细的调试日志定位 Cursor 问题

---

## 测试计划

1. **上下文长度测试**
   - 发送 300KB、500KB、800KB、1MB 的请求
   - 验证是否正常处理

2. **缓存命中率测试**
   - 连续发送相似对话，统计命中率
   - 对比优化前后的改进

3. **协议转换测试**
   - 测试所有 6 种转换路径
   - 验证流式和非流式场景

4. **UI 测试**
   - 测试模型探测流程
   - 验证错误提示和成功反馈

---

## 代码修改清单

### 1. `public/js/app.js`
- Line 1637: `contextLimit: 1000000`
- Line 1652: `contextLimit: editing.contextLimit || 1000000`
- Line 1660: `contextLimit: 1000000`

### 2. `src/request-optimizer.js`
- Line 171: `firstMessages: messages.slice(0, 8).map(messageShape)`

### 3. `src/server.js` (需要检查)
- 确认 `express.json({ limit })` 配置

### 4. `src/prompt-cache-utils.js`
- 优化 cache_control 注入逻辑

---

## 监控指标

添加以下监控指标到请求日志：

```javascript
{
  cacheHitRate: cacheReadTokens / (inputTokens || 1),
  cacheEfficiency: (inputTokens - cacheReadTokens) / (inputTokens || 1),
  prefixStability: cachePrefixDiagnostics.prefixHash,
  contextSize: cachePrefixDiagnostics.totalChars
}
```
