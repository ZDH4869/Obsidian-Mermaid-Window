# Mermaid Window —— Obsidian 插件

让 Markdown 里的 **Mermaid 流程图**支持缩放/平移，并可**一键在独立窗口打开**（窗口可拖动到其他显示器）。

## 功能特性

- **笔记内**：滚轮缩放、拖拽平移、双击放大、右下角拖拽调整容器大小
- **工具栏**（悬浮图右上角）：缩小 / 放大 / 重置自适应 / 在新窗口打开（⤢）
- **独立窗口**：
  - 真正的系统窗口，可拖到任意显示器、可调整大小
  - 内部滚轮缩放、拖拽平移
  - `Esc` 或右上角 `✕` 关闭
- **主题绑定**：独立窗口背景自动读取 Obsidian 当前主题颜色（浅色主题即为白色），流程图显示与原笔记一致

## 目录结构

```
mermaid-window/
├── manifest.json   # 插件清单
├── main.js         # 插件主逻辑
└── styles.css      # 笔记内样式
```

## 安装

### 方式一：手动安装

1. 将 `mermaid-window` 文件夹整个复制到你的库：`<你的库>/.obsidian/plugins/`
2. 重启 Obsidian（或重新加载）
3. 设置 → 第三方插件 → 启用 **Mermaid Window**
4. 若已安装 **Mermaid Flow Zoom**，请停用/卸载，避免重复增强

### 方式二：AI Agent 一键安装

见同目录《一键安装提示词.md》，把该提示词投喂给任意 AI Agent 自动完成。

## 使用

1. 打开含 ` ```mermaid ` 代码块的笔记
2. 鼠标悬浮流程图 → 右上角出现工具栏
3. 点「⤢」→ 弹出独立窗口

## 注意事项

- 仅桌面端可用（`isDesktopOnly: true`，依赖 Electron `remote`）
- 基于 MIT 协议的开源项目 [Mermaid Flow Zoom](https://github.com/change-wyc/mermaid-flow-zoom) 修改
