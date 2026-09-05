# DESIGN — Noobty Web UI

> 设计定稿 v1。配合 [PRODUCT.md](./PRODUCT.md) 与 [CONTEXT.md](./CONTEXT.md)(术语)阅读。实现于 `web/`,令牌源文件 `web/src/styles/app.css`。

## 1. Design Read

产品寄存器(product):设计服务于任务,界面应当"消失在任务后面"。这是聊天式传输工具,不是营销页:克制、密度适中、组件词汇全局一致。

**场景句**:文件在书桌上的台式机和口袋里的手机之间流动——白天窗边明亮的手机屏幕,深夜书房里暗色的显示器。→ 双主题一等公民,默认跟随系统,提供手动切换并持久化。

**情绪**:千兆交换机的指示灯——冷静、可靠、微微极客。颜色克制(单一品牌色),数字用等宽字体,余下交给留白与层级。

**色彩策略**:Restrained(着色中性色 + 品牌色 ≤10% 面积)。品牌色同时承担"连接/活动"语义——品牌色即"活的颜色"。

## 2. 色彩(OKLCH)

种子色 `oklch(0.650 0.100 200)`(palette.mjs seed-125):冷静的青蓝,网络指示灯的颜色。主色在其 ±10° 色相内取值。

### 令牌表

| 令牌 | 亮色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `--bg` | `oklch(1 0 0)` | `oklch(0.14 0 0)` | 页面底 |
| `--surface` | `oklch(0.965 0.005 220)` | `oklch(0.19 0.012 230)` | 侧栏、面板、气泡 |
| `--surface-2` | `oklch(0.925 0.008 220)` | `oklch(0.24 0.014 230)` | hover、活跃填充、代码 |
| `--line` | `oklch(0.9 0.01 220)` | `oklch(0.27 0.015 230)` | 描边、分隔 |
| `--ink` | `oklch(0.21 0.02 240)` | `oklch(0.92 0.008 220)` | 正文(≥7:1) |
| `--muted` | `oklch(0.47 0.025 230)` | `oklch(0.63 0.02 225)` | 次要文字(≥4.5:1) |
| `--primary` | `oklch(0.52 0.11 205)` | `oklch(0.82 0.09 205)` | 主按钮、在线态、进度 |
| `--on-primary` | 白 | `oklch(0.14 0 0)` | primary 之上的文字 |
| `--primary-soft` | `oklch(0.95 0.03 205)` | `oklch(0.26 0.05 205)` | 选中底、信息条 |
| `--primary-ink` | `oklch(0.42 0.10 205)` | `oklch(0.72 0.10 205)` | 深底上的链接/强调文字 |
| `--danger` | `oklch(0.55 0.19 25)` | `oklch(0.70 0.16 25)` | 删除、失败 |
| `--warning` | `oklch(0.62 0.13 70)` | `oklch(0.75 0.12 75)` | 存储告警、过期 |

规则:亮色模式主按钮 = primary 白字;暗色模式主按钮 = primary 深字(明暗两套都过 WCAG AA)。在线/已连接复用 primary;离线用 muted;失败用 danger;过期/容量告警用 warning。**全站只有一个品牌色相**,状态色仅在语义处出现。

### 主题机制

`<html data-theme="light|dark">`;默认跟随 `prefers-color-scheme`,手动选择写 `localStorage`。入口 `index.html` 内联脚本先行赋值,避免闪色。

## 3. 字体

| 角色 | 字体 | 说明 |
| --- | --- | --- |
| UI 全族 | 系统栈:`system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif` | CJK 优先,零加载成本,各平台原生质感 |
| 数据 | Geist Mono(`@fontsource`,自托管) | 文件大小/速度/进度/时间戳/中枢地址/存储数字;`tabular-nums` |

字号(固定 rem,产品界面不用流式字号):12 辅助、13 次要、14 正文默认、15 消息正文与输入、16 标题、20 引导页标题。行高:正文 1.6,标题 1.3。字重:400 / 500(按钮、强调)/ 600(标题)。中英混排不手动加空格,依赖字体原生间距。

## 4. 布局

**断点**:`<1024px` 移动结构,`≥1024px` 桌面结构(结构性折叠,非缩放)。

**桌面**:`280px 侧栏 + 1fr 会话区` 双栏,整体 `min-h-[100dvh]`。侧栏自上而下:身份块(本机名 + 编辑)→ 会话列表(大厅置顶,设备按在线优先)→ 存储表 → 底部(中枢地址/版本/主题切换)。会话区:头部(对端名 + 在线态 + 模式提示)→ 消息流 → 发送器。消息列最大宽 720px 居中,气泡最大 78%。

**移动**:两屏栈式导航——会话列表屏(身份头部、大厅卡、设备列表、底部存储表)⇄ 会话屏(返回 + 对端头部 + 消息流 + 发送器)。触控目标 ≥ 40px。

**形状锁**:基础圆角 10px(按钮/输入/卡片);气泡 14px(发送角 4px);胶囊只用于状态小标签。阴影只用于浮层(dialog/toast),着底色色调,模糊 ≤ 24px;平面元素用描边分层,不用卡片套卡片。

## 5. 组件清单与状态

每个交互组件具备:default / hover / focus-visible / active / disabled / loading / error。

| 组件 | 要点 |
| --- | --- |
| Button | primary / secondary / ghost / danger-ghost;active `scale-[0.98]`;加载态内嵌 spinner 禁点 |
| IconButton | 40×40,tooltip 可选 |
| Field/Input | 标签在上、帮助文字在下、错误在下(danger);placeholder 不当标签 |
| Dialog | 原生 `<dialog>` + backdrop;160ms 淡入 + 0.98→1;Esc 关闭;用于注册/重命名/删除确认 |
| Toast | 底部居中,180ms 上滑,4s 自愈;`aria-live=polite`;错误类常驻可手动关 |
| PresenceDot | 在线 primary 实心;离线 muted 描边;连接中 primary 呼吸(唯一循环动画,reduced-motion 关闭) |
| ConversationRow | 设备图标(桌面/手机)+ 名称 + 最后一条摘要(单行截断)+ 相对时间 + 未读数胶囊;选中态 `primary-soft` |
| TextBubble | 己方 `primary` 白字(桌面)/`primary-soft`(暗色)…统一:己方 primary、对方 surface;hover 浮出 复制/删除 |
| FileCard | 图标按类型、名称截断、大小(等宽)、状态行;状态机:上传中%(进度条+速度)→ 已寄存·等待取件 → 已取件;下载中%(速度)→ 完成(另存);失败(重试);已过期(warning);删除需确认 |
| FileGroupCard | 多文件行堆叠 + 聚合进度;逐行独立状态 |
| ImageCard | `<img src="/api/files/{id}">` 直连;载入前占位(比例保留),失败回退文件卡 |
| Composer | 自增高输入;附件按钮;粘贴文件即加入;Enter 发送 / Shift+Enter 换行;多文件队列条(逐个进度) |
| DropOverlay | 拖拽悬停全窗虚线框:"松开发送到〈会话〉" |
| StorageMeter | 已用/上限(等宽)、比例条;>80% 变 warning;注明保留期 |
| HubStatus | 已连接(静默)/ 连接中(呼吸)/ 已断线(顶部横幅 + 重试按钮,`aria-live=assertive`) |
| Skeleton | 历史加载:3 行气泡形骨架;列表加载:3 行行形骨架 |
| EmptyState | 大厅空/无设备/无消息,各配一句"下一步"文案 |

**空态与错误是设计的一部分**:每个空态教用户下一步;错误给动作(重试),不给报错脸。

## 6. 动效

产品寄存器:150–250ms,只传达状态,无编排式入场,无循环装饰。

| 场景 | 规格 |
| --- | --- |
| 新消息进入 | 180ms 淡入 + 上移 6px(ease-out);历史加载不动画 |
| 在线态变化 | 圆点 150ms 交叉淡入 |
| 进度条 | `transform: scaleX`(GPU),数值直接更新不补间 |
| Dialog / Toast | 160–180ms 淡入(+0.98 缩放 / 上滑) |
| 拖拽遮罩 | 140ms 淡入 |
| 断线横幅 | 200ms 下滑入场 |
| 按钮按压 | `scale-[0.98]` |
| 连接中圆点 | 1.6s 呼吸,**全站唯一**循环动画 |

`prefers-reduced-motion: reduce` → 全部退化为瞬时或纯淡入,呼吸停止。动效仅动 `transform` / `opacity`。

## 7. 图标

Phosphor(`@phosphor-icons/react`),regular 字重,全站一族。按需具名导入:`PaperPlaneTilt`(发送)、`Paperclip`(附件)、`ArrowDownToLine`(取件)、`Trash`、`Copy`、`Check`、`X`、`Warning`、`CircleNotch`(加载)、`Desktop`/`DeviceMobile`(设备)、`Broadcast`(大厅)、`HardDrives`(存储)、`Plugs`/`PlugsConnected`(中枢状态)、`PencilSimple`(重命名)、`ArrowCounterClockwise`(重试)。不手绘 SVG,不混第二族。

## 8. 文案与术语(zh-CN)

领域词严格沿用 CONTEXT.md:中枢、设备、大厅、寄存、直转、取件。

| 场景 | 文案 |
| --- | --- |
| 注册引导 | "给这台设备起个名字"/"它会出现在其他设备的联系人列表里" |
| 发送 | 发送 / 取件 / 另存 / 复制 / 删除 / 重试 |
| 文件态 | 上传中 / 已寄存 · 等待取件 / 已取件 / 下载中 / 已保存 / 已过期 / 失败,点按重试 |
| 大厅空态 | "发到这里的内容,所有设备都可见可取" |
| 断线 | "与中枢断开了连接" + 重试 |
| 过期说明 | "寄存文件保留 {N} 天,到期自动清理" |

数字格式:大小 `1.8 GB / 4.2 MB`(等宽);速度 `12.4 MB/s`;时间 今天 14:32 / 昨天 / 9月3日。中文界面,品牌名 Noobty 保留拉丁字形。

## 9. 可访问性

对比度全部过 WCAG AA(正文 4.5:1;等宽数字 14px 加权);焦点环 `outline 2px primary, offset 2px`;Enter/Shift+Enter/Esc 键盘语义;Toast 与断线横幅 `aria-live`;状态不单靠颜色(圆点伴随文字);触控 ≥ 40px。

## 11. v1.1 交互增补(体验打磨轮)

在 v1 基础上增补的交互,延续"状态先于装饰"的原则,动效仍限 150–250ms 与 transform/opacity:

| 交互 | 规格 |
| --- | --- |
| 回到底部按钮 | 消息流距底 >240px 时浮现(淡入+上移);离底期间收到新消息,按钮累计计数徽标;点击平滑回底(reduced-motion 立即) |
| 吸附日期分隔 | 滚动时日期行吸附在消息流顶部,`bg/85 + backdrop-blur` 保证可读 |
| 加载更早的历史 | 分页 50 条;顶部"查看更早的消息"按钮,加载后锚点恢复滚动位置,不跳动 |
| 文本复制 | 文本气泡 hover 浮出复制动作,成功以 toast 确认 |
| 图片灯箱 | 点按图片以原生 `<dialog>` 放大查看(0.98→1 淡入),Esc/背景点击/关闭按钮退出 |
| 发送失败恢复 | 文本发送失败自动回填输入框,不丢内容;上传失败的任务条内联"重试" |
| 切换会话聚焦 | 桌面端切换会话后输入框自动聚焦;手机端不弹键盘 |
| 存储面板 | 百分比常显;进度条带 80% 告警刻度;点击展开详情(已用/上限、保留期限、容量告警策略),grid-rows 过渡 |
| 消息流无障碍 | 滚动容器 `role="log" aria-live="polite"`;骨架屏 `aria-busy` |

性能约定:会话行与消息行按行订阅 store 切片(父级不订阅整表),消息行 `memo`,长列表 `content-visibility: auto`;进度条不加补间(数字与填充必须一致)。

## 10. 技术实现注记

- **栈**:React 19 + Vite + TypeScript + Tailwind v4(`@tailwindcss/vite`)+ zustand + `motion/react` + Phosphor + `@fontsource/geist-mono`。原 Vue 脚手架为零代码占位模板,已替换;构建命令不变(`npm ci && npm run build`),产物仍由 server 托管于 `web/dist`。
- **Mock 模式**:`?mock=1`(或 `VITE_MOCK=1`)拦截 fetch/WS,内置内存中枢模拟,用于无服务端时开发与视觉验证;生产构建不受影响。
- **上传**:分块(服务端 `chunk_size`)+ 断点续传(`X-Noobty-Offset`,恢复时先 `GET /api/uploads/{id}`);≤256MB 计算 sha256 参与秒传/续传匹配,更大文件按 名字+大小 匹配。
- **下载**:fetch 流式读取计进度,Range 断点(会话内),完成后 blob 触发另存;图片消息直接 `<img>` 指向文件端点。
- **WS**:心跳 25s,指数退避重连(1s 起,封顶 15s);`hello` 同步设备快照,`presence` 增量更新;消息渲染后回 `ack_message`。
- **PWA**:`manifest.webmanifest` + 图标,手机可加桌面图标;v1 不含 Service Worker 离线缓存。
- 性能:图标具名导入(tree-shake);动效只 transform/opacity;历史列表 `content-visibility: auto`。
