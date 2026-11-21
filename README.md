# Antigravity Taskbar Status

> Windows 任务栏嵌入式状态栏，实时展示 Google Antigravity 后台 Agent 执行进度与任务状态。

![Antigravity Taskbar Status 演示](docs/demo.gif)

---

## 🌟 特性

- **任务栏原生嵌入**：紧贴 Windows 11 任务栏展示，支持深浅任务栏主题自动匹配（读取 `SystemUsesLightTheme`），自适应显示器/DPI 变更。
- **纯文本无感呈现**：无多余背景框或悬浮胶囊，背景 100% 透明，还原纯粹极简体验。
- **鼠标 100% 点击穿透**：全透明区域对鼠标事件完全穿透，不阻碍任务栏原有图标的点击与右键操作。
- **任务栏零多余图标**：采用原生无图标常驻机制（`skipTaskbar: true`），任务栏自身绝不弹出多余的进程图标。
- **像素级基线对齐**：单色状态指示灯（运行中蓝色 `✦`、等待中橙色 `⧗`、已就绪绿色 `✔`/`●`、异常红色 `✖`），与文本基线（Baseline）1:1 绝对对齐。
- **原生 Hook 协议驱动**：接入 `SessionStart`、`PreInvocation` 与 `Stop` 钩子，通过命名管道实时接收精确会话路径与终态事件，同时兼容 Antigravity 桌面端、CLI (`agy`) 与 IDE。
- **生命周期自动跟随**：基于进程树精准绑定 Antigravity GUI 主进程（兼容提权运行与 Windows 11 24H2+），关闭宿主时自动优雅退出，纯 CLI 模式下在空闲 3 分钟后自动回收。

---

## 📋 环境要求

- **操作系统**：Windows 10 / Windows 11（全面兼容 24H2+，无需 WMIC）
- **Node.js**：`>= 18.0.0`
- **宿主环境**：Google Antigravity（桌面端 / CLI / IDE）

---

## 🚀 快速开始

### 1. 安装插件

将本项目克隆或放置到您的 Antigravity 全局插件目录下（如目录不存在请先创建）：

```powershell
# 默认插件目录位于用户主目录下的 .gemini/config/plugins/
New-Item -ItemType Directory -Force -Path "$HOME/.gemini/config/plugins" | Out-Null
cd "$HOME/.gemini/config/plugins"
git clone https://github.com/nuclearmilk/antigravity-taskbar.git
```

### 2. 安装运行时依赖

进入插件目录并安装运行时所需的 Electron 依赖：

```bash
cd antigravity-taskbar
npm install
```

### 3. 启用与管理

放置在 `~/.gemini/config/plugins/` 目录下的插件会被 Antigravity **自动发现并默认启用**，无需手动修改 `~/.gemini/config/config.json`。

如需开启、关闭或管理插件，推荐通过以下官方方式操作：

- 在 Antigravity 的 **Customizations（自定义）** 页面中直接切换开关；
- 或使用 Antigravity CLI 命令：

```bash
agy plugin enable antigravity-taskbar
agy plugin disable antigravity-taskbar
```

重新打开 Antigravity 或开启任意对话，任务栏即可自动展示 Agent 的实时运行状态；也可在插件目录手动执行 `npm start` 进行独立预览测试。

---

## ⚙️ 可选布局与行为配置

默认居中贴合主显示器任务栏。如需调整位置（例如避开 Windows 11 居中任务栏图标）或行为，可在插件数据目录 `${PLUGIN_DATA}/settings.json`（独立运行时默认位于系统临时目录 `%TEMP%\antigravity-taskbar\settings.json`）创建配置文件：

```json
{
  "align": "center",
  "offsetX": 0,
  "width": 600,
  "visibleOnFullScreen": false
}
```

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `align` | `"center" \| "left" \| "right"` | `"center"` | 水平对齐方式（居中 / 靠左 / 靠右） |
| `offsetX` | `number` | `0` | 水平微调偏移量（像素，正数向右，负数向左） |
| `width` | `number` | `600` | 状态栏窗口宽度（像素，最小 160） |
| `visibleOnFullScreen` | `boolean` | `false` | 仅 macOS 生效（Electron `setVisibleOnAllWorkspaces` 的全屏控制受限于平台原生 API，Windows 上置顶层级按 `screen-saver` 保持） |

也支持通过环境变量临时覆盖：`ANTIGRAVITY_TASKBAR_ALIGN`、`ANTIGRAVITY_TASKBAR_OFFSET_X`、`ANTIGRAVITY_TASKBAR_WIDTH`、`ANTIGRAVITY_TASKBAR_FULLSCREEN`。

> **提示（避开 Windows 11 居中任务栏图标）**：如果任务栏图标居中导致文字重叠，可将配置调整到托盘左侧空白区，例如：
>
> ```json
> {
>   "align": "right",
>   "offsetX": -260,
>   "width": 360
> }
> ```

---

## 🔄 更新与排查

### 更新插件

```powershell
cd "$HOME/.gemini/config/plugins/antigravity-taskbar"
git pull
npm install
```

更新代码后，重启 Antigravity（或先结束旧的 `electron.exe` 状态栏进程），下次触发对话时即会自动拉起新版本。

### 查看运行日志

运行日志会自动轮转（单文件上限 `512KB`），默认位置为：

- 插件托管运行：`${PLUGIN_DATA}/taskbar.log`
- 独立启动或未注入 `PLUGIN_DATA` 时：`%TEMP%\antigravity-taskbar\taskbar.log`

---

## 🧪 运行测试

```bash
npm test
```

---

## 📁 目录结构

```text
antigravity-taskbar/
├── core/
│   ├── detector.js      # 异步多端会话兜底探测器（antigravity / cli / ide）
│   ├── tailer.js        # 流式 UTF-8 增量字节日志监听器
│   ├── parser.js        # 解析 Agent 工具调用、并行状态、思考与异常事件
│   └── index.js         # 核心事件协调器（支持 Hook 推送与历史静默回放）
├── desktop/
│   ├── helpers.cjs      # 进程树主进程识别、布局计算、命名管道与日志轮转工具
│   ├── launcher.js      # Hook stdin 解析、命名管道探活与 CIM/WMIC 独立启动器
│   ├── preload.cjs      # Electron contextBridge 安全预加载脚本
│   └── runner.cjs       # 沙箱隔离、透明穿透置顶的 Electron 任务栏渲染窗口
├── ui/
│   └── index.html       # 任务栏双行排版与自适配主题指示灯界面
├── test/                # 零依赖 Node.js 单元测试 (node --test)
├── hooks.json           # Antigravity 生命周期钩子配置（SessionStart / PreInvocation / Stop）
├── plugin.json          # Antigravity 插件元数据
└── package.json         # Node.js 项目配置与依赖说明
```

---

## 📄 开源协议

本项目采用 [MIT](LICENSE) 协议开源。
