# Agent Note: 移动端侧边板在自动折叠断点以下以可滑出抽屉呈现

Status: implemented

[English](2026-08-14-mobile-sidebar-drawer.md) | 中文

## 问题

在 `SIDEBAR_AUTO_COLLAPSE` 断点（`columns.ts`，1024px）以下，交付的 shell 把侧边板折叠成 56px 固定边栏，手动 toggle 通过*挤压* center 列来重新展开（`stores.ts` 的 `narrowExpanded`）。在手机上这种交互很糟：边栏占据对话所需的竖向边缘空间，重新展开不是覆盖而是收窄了对话记录。产品诉求是移动端的标准模式——侧边板收起为覆盖式抽屉，滑动或按钮打开，选完会话即收起，让用户落回详情。

grid 列 + 挤压模型表达不了这种交互：流内列无法覆盖兄弟列，而 store 仅有的 `toggleSidebar` 是翻转语义，无法"确保关闭"——但选择会话、点击遮罩、按 Escape 都必须无视先前状态地关闭。

## 决策

断点以下侧边板脱离 grid，以 absolute 覆盖抽屉呈现（frame 上的 `data-narrow`，`AppFrame.module.css`）。grid 的侧边板轨道为零（对话占满视口），`sidebarCol` 变为 `position: absolute` 平移到左边缘之外；`data-drawer-open` 将其滑入，`data-drawer-dragging` 在跟手拖拽时暂停过渡。`narrowExpanded` 仍扮演开/关位（`drawerOpen = narrow && panels.narrowExpanded`），但其效果从挤压 center 改为呈现抽屉——宽度偏好原样保留，因此越过断点加宽时恢复宽屏布局。

store 与 `ctx.layout`（`ILayout` / `LayoutController`）新增两个显式动作：`openSidebar` 与 `closeSidebar`，镜像 `openDetails` / `closeDetails` 这一对。`closeSidebar` 是抽屉遮罩、Escape、选会话所需的"确保关闭"路径；`toggleSidebar` 对宽屏边栏切换和品牌按钮保持不变。

打开入口是移动端的标准组合：`ConversationRoot` 中的 ☰ 按钮（一条 `@media (max-width: 1023px)` 顶栏，hero 与 active 阶段均可见，通过 `ConversationInjected` 接到 `ctx.layout.openSidebar()`），以及一条左边缘 Pointer Events 呈现条——跟手移动并在超过 `SIDEBAR_DRAWER`（320px）的 40% 时提交。关闭方式对称：选择会话、点击遮罩、按 Escape，或在遮罩上左滑超过阈值。Pointer Events 用一条代码路径同时覆盖触摸与鼠标；拖拽复用现有 `DragHandle` 形态（指针捕获 + rAF），因此不引入任何手势库。遮罩复用 Modal 的 token（`--dsw-alias-bg-mask-1`、`--dsw-mask-blur`）。

选会话收起通过订阅 `useSessions(s => s.current)` 配合 ref 比较的 effect 实现，与 frame 已用于在会话切换时关闭 details 的模式一致；`current` 在每条选择路径上都变动，包括从 hero 的 `undefined` → 首个会话。纯函数 `computeColumns` 求解器未改动——窄屏分支只是喂入 sidebar 偏好 0，并写出 grid 模板 `0 minmax(0, 1fr) …`。

## 考虑过的替代方案

- **保留 56px 边栏作为打开入口（边栏 + 覆盖）**：拒绝——常驻边栏仍占用边缘空间，与"收起"诉求冲突；抽屉的本意是被召唤前不可见。
- **引入手势库**（`framer-motion`、`react-swipeable`）：拒绝——项目零手势依赖，边缘/遮罩跟手拖拽是对现有指针捕获 + rAF `DragHandle` 模式的轻量复用；为一个过渡引入库得不偿失。
- **用 `toggleSidebar` 关闭**：拒绝——翻转语义无法保证目标状态；遮罩、Escape、选会话需要确定性的关闭，因此显式的 `closeSidebar`（镜像 `closeDetails`）才是正确的形态。

## 后果

- 1024px 以下对话占满视口；56px 边栏仅作为宽屏折叠态保留。`SIDEBAR_DRAWER = 320`（`max-width: 85%`）是抽屉几何常量。
- 打开入口按设计跨包：`ui-conversation` 注入 `openSidebar`（`ctx.layout`），`ui-layout` 拥有抽屉几何与手势。`ConversationSlotProps` 通过 `ConversationInjected` 获得 `openSidebar`。
- 桌面窗口被拖到 1024px 以下同样获得抽屉（断点共享，不分裂出仅移动端的值），在每个窄宽度上都以覆盖层取代挤压展开。
- ☰ 顶栏在窄屏 active 会话上叠加在会话 header 之上——作为标准移动端双层顶栏予以接受。
