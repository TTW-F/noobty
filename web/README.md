# Noobty Web UI

Noobty 的统一网页界面:手机浏览器、PC 浏览器与 Tauri 托盘壳共用这一套界面。设计定稿见根目录 [DESIGN.md](../DESIGN.md),产品上下文见 [PRODUCT.md](../PRODUCT.md),接口契约见 [docs/API.md](../docs/API.md)。

## 技术栈

React 19 + Vite + TypeScript + Tailwind CSS v4 + zustand + Phosphor Icons + Geist Mono(自托管)。构建产物由中枢服务器托管于 `web/dist`。

## 开发

```bash
npm ci
npm run dev        # 开发服务器;/api 代理到 localhost:7317
npm run build      # 类型检查 + 产物构建
```

### Mock 模式(无需中枢)

服务端未启动时,可用内置的内存中枢模拟完整的收发体验:

```bash
# 浏览器打开 http://localhost:5173/?mock=1
```

Mock 会拦截 fetch 与 WebSocket,预置设备、历史消息、存储用量,并模拟对方回复,用于界面开发、演示与视觉回归(`node scripts/shoot.mjs <端口>` 可批量截图到 `.shots/`)。Mock 与 server M1 实现同契约:删除返回 204、大厅被拒绝(M2)、消息仅 text/file 两种。

### 真机联调

```bash
cd ../server && cargo run          # 真实中枢 :7317
npm run dev                        # 本开发服务器已代理 /api(含 WS)
node scripts/e2e.mjs http://localhost:5199   # 双浏览器上下文全链路用例
```

E2E 覆盖:双设备注册、在线状态、文本/图片/文件互发、取件下载、删除跨设备同步、大厅 M2 门控、刷新后身份与双向历史。

## 结构

```
src/
  styles/app.css     设计令牌(OKLCH 双主题)+ 基础样式
  lib/               类型契约、REST 客户端、WS 客户端、分块上传、流式下载、格式化
  store/hub.ts       应用状态(zustand):连接、设备、会话、消息、传输
  mock/hub.ts        内存中枢模拟(?mock=1 启用)
  components/        侧栏、会话视图、消息组件、发送器、引导屏、基础件
  scripts/shoot.mjs  视觉验收截图脚本(Playwright + 系统 Edge)
```

## 实现注记

- 上传:分块 + 断点续传;≤128MB 计算 sha256 参与服务端匹配,更大文件按 名字+大小 匹配。
- 下载:fetch 流式计进度,会话内 Range 断点;图片消息经 fetch 取 blob 预览。
- WebSocket:`web/src/lib/ws.ts` 为客户端参考实现——25s 心跳;Full Jitter 指数退避(`randomInt(0, min(15s, 1s·2^(n-1)))`,学自 Centrifugo/AWS,防惊群);断线横幅可立即重试。重连后由 store 用 `after_seq` 追赶。
- 主题:跟随系统,手动切换持久化于 `localStorage['noobty.theme']`,首帧前内联脚本防闪色。
- 设备身份持久化于 `localStorage['noobty.device.v1']`。
