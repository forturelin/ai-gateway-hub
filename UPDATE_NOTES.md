# AI Gateway Hub - 更新说明

## 版本更新内容

### 1. 缓存完全透传（核心功能）✅

**修改文件：**
- `src/routes/chat-route.js`
- `src/routes/responses-route.js`
- `src/routes/messages-route.js`

**修改内容：**
- 添加 `skipCacheInjection` 标志，默认为 `true`（跳过缓存干预）
- 仅在 `settings.bedrockOptimizer.cacheInjection === true` 时才注入缓存
- 直接透传客户端的 `anthropic-beta` header，不做任何修改
- 移除所有默认的缓存优化逻辑

**效果：**
- 网关默认不做任何缓存干预
- 缓存策略完全由客户端控制

---

### 2. 模型健康检查功能 ✅

**新增 API：**
- `POST /api/providers/:id/health/:model` - 测试单个模型健康状态

**功能特性：**
- 发送简单测试请求（"hi"，10 tokens max）
- 显示响应时间（毫秒）
- 显示健康状态（✓ healthy / ✗ unhealthy）
- 结果持久化显示在按钮旁边

---

### 3. 端点协议控制 ✅

可以控制每个映射允许访问的协议端点：
- `/v1/chat/completions` (Chat)
- `/v1/responses` (Resp)
- `/v1/messages` (Msg)

---

### 4. 日志协议显示 ✅

日志表格新增"协议"列，显示每个请求使用的协议类型。

---

## 数据看板排查

如果数据看板不显示数据，请按以下步骤排查：

1. **清除浏览器缓存并强制刷新（Ctrl+Shift+R）**

2. **检查浏览器控制台（F12）：**
   - Console 标签查看错误信息
   - Network 标签检查 API 请求状态

3. **手动测试 API（浏览器访问）：**
   - http://localhost:44559/api/usage/overview
   - http://localhost:44559/api/usage/monthly?months=1

4. **重启服务：**
   ```bash
   npm run restart
   ```
