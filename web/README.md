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

Mock 会拦截 fetch 与 WebSocket,预置设备、历史消息、存储用量,并模拟对方回复,用于界面开发、演示与视觉回归(`node scripts/shoot.mjs <端口>` 可批量截图到 `.shots/`)。生产构建不受影响。

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
- WebSocket:25s 心跳,指数退避重连(1s 起步,15s 封顶),断线横幅可手动重试。
- 主题:跟随系统,手动切换持久化于 `localStorage['noobty.theme']`,首帧前内联脚本防闪色。
- 设备身份持久化于 `localStorage['noobty.device.v1']`。
