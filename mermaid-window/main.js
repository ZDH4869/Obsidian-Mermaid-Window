const obsidian = require("obsidian");
const { Plugin, Notice } = obsidian;
let loadMermaid = null;
try {
  if (typeof obsidian.loadMermaid === "function") loadMermaid = obsidian.loadMermaid;
} catch (error) {
  loadMermaid = null;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 12;
const ZOOM_STEP = 1.18;
const EDGE_SCROLL_ZONE = 46;

// Obsidian 1.15+ 使用 Pele 绘制 Mermaid。Pele 默认在容器宽度小于 640px 时
// 会把 LR/RL 流程图自动改成 TB 布局；插件本身是放大查看工具，应保留代码里
// 书写的方向。这里留出一点余量，避免主题给 .mermaid 加 padding 后实际测量宽度不足。
const MIN_MERMAID_LAYOUT_WIDTH = 720;

const PELE_THEME_VARS = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  "--pele-error",
  "--pele-font",
  "--pele-font-mono",
  "--pele-radius",
  "--pele-title-weight",
  "--pele-heading-weight",
  "--pele-bold-weight",
  "--pele-series-1",
  "--pele-series-2",
  "--pele-series-3",
  "--pele-series-4",
  "--pele-series-5",
  "--pele-series-6",
  "--pele-series-7",
  "--pele-series-8",
  "--link-color",
  "--font-mermaid",
  "--font-monospace",
];

const SERIES_FALLBACKS = [
  "#4c78a8",
  "#f58518",
  "#54a24b",
  "#e45756",
  "#72b7b2",
  "#eeca3b",
  "#b279a2",
  "#9d755d",
];

module.exports = class MermaidWindowPlugin extends Plugin {
  async onload() {
    this.instances = new Set();
    this.unloaded = false;

    this.registerMarkdownPostProcessor((el) => {
      window.setTimeout(() => this.enhanceMermaid(el), 0);
    });

    this.observeDynamicMermaid();

    // Obsidian 1.15 的 Pele 自带缩放；它的缩放会改 SVG viewBox，与插件的
    // CSS transform 叠加后会双重缩放。插件已有完整工具栏，这里关闭自带缩放。
    this.ensurePeleCompat();

    this.addCommand({
      id: "reset-visible-mermaid-diagrams",
      name: "Reset visible Mermaid diagrams",
      callback: () => {
        let count = 0;
        for (const instance of this.instances) {
          if (document.body.contains(instance.container)) {
            instance.reset();
            count += 1;
          }
        }
        new Notice(`Reset ${count} Mermaid diagram${count === 1 ? "" : "s"}.`);
      },
    });
  }

  onunload() {
    this.unloaded = true;
    if (this.mutationObserver) this.mutationObserver.disconnect();
    if (this.peleCompatTimer) window.clearInterval(this.peleCompatTimer);
    const currentPele = window.pele;
    if (currentPele && currentPele.__mermaidWindowCompat === true && currentPele.__mermaidWindowOriginal) {
      try {
        window.pele = currentPele.__mermaidWindowOriginal;
      } catch (error) {
        // 忽略：某些环境不允许替换全局对象
      }
    } else if (this.peleWrapper && window.pele === this.peleWrapper && this.peleOriginal) {
      try {
        window.pele = this.peleOriginal;
      } catch (error) {
        // 忽略：某些环境不允许替换全局对象
      }
    }
    for (const instance of this.instances) instance.destroy();
    this.instances.clear();
  }

  observeDynamicMermaid() {
    let queued = false;
    this.mutationObserver = new MutationObserver((mutations) => {
      if (queued) return;
      if (!mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => this.nodeMayContainMermaid(node)))) {
        return;
      }
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        this.enhanceMermaid(document.body);
      });
    });

    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.mutationObserver.disconnect());
  }

  ensurePeleCompat() {
    if (this.peleCompatReady) return;
    const applyPatch = () => {
      if (this.unloaded) return false;
      const pele = window.pele;
      if (!pele || typeof pele.mount !== "function") return false;
      if (pele.__mermaidWindowCompat === true) {
        this.peleCompatReady = true;
        return true;
      }

      const wrapper = Object.create(pele);
      Object.defineProperty(wrapper, "mount", {
        configurable: true,
        writable: true,
        value: function (el, source, options = {}) {
          return pele.mount.call(pele, el, source, {
            ...options,
            zoom: false,
            autoDirection: false,
          });
        },
      });
      wrapper.__mermaidWindowCompat = true;
      wrapper.__mermaidWindowOriginal = pele;

      try {
        window.pele = wrapper;
      } catch (error) {
        return false;
      }
      this.peleCompatReady = window.pele === wrapper;
      if (this.peleCompatReady) {
        this.peleOriginal = pele;
        this.peleWrapper = wrapper;
      }
      return this.peleCompatReady;
    };

    if (applyPatch()) return;

    // 提前加载 Pele，尽量赶在 Obsidian 第一次渲染 Mermaid 之前完成包装。
    if (loadMermaid) {
      try {
        loadMermaid().then(() => applyPatch()).catch(() => {});
      } catch (error) {
        // 旧版本 Obsidian 没有 loadMermaid
      }
    }

    if (this.peleCompatTimer) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (applyPatch() || Date.now() - started > 15000) {
        window.clearInterval(timer);
        if (this.peleCompatTimer === timer) this.peleCompatTimer = null;
      }
    }, 100);
    this.peleCompatTimer = timer;
    this.register(() => window.clearInterval(timer));
  }

  nodeMayContainMermaid(node) {
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
    if (node instanceof SVGElement) {
      return Boolean(node.closest?.(".mermaid, .mermaid-rendered")) ||
        (node.getAttribute("id") || "").toLowerCase().includes("mermaid");
    }
    return Boolean(
      node.matches(".mermaid, .mermaid-rendered") ||
      node.querySelector(".mermaid, .mermaid-rendered, svg[id^='mermaid']")
    );
  }

  enhanceMermaid(root) {
    if (this.unloaded) return;
    if (!this.peleCompatReady) this.ensurePeleCompat();
    // Pele 生成的 SVG 没有 mermaid-* 的 id，而且图内可能还有嵌套的小 SVG
    //（例如图标）。这里只处理 .mermaid 的直接子 SVG，避免把图标也包进缩放容器。
    const candidates = root.querySelectorAll(
      ".mermaid > svg, .mermaid svg.pele, .mermaid-rendered > svg, .markdown-rendered svg[id^='mermaid'], svg[id^='mermaid']"
    );

    for (const svg of candidates) {
      const host = svg.closest(".mermaid, .mermaid-rendered");
      if (!host || !host.parentElement) continue;
      if (host.closest(".mfz-container") || host.dataset.mfzEnhanced === "true") continue;
      if (host.closest(".canvas-wrapper")) continue;
      if (!this.looksLikeMermaid(svg)) continue;

      const instance = new MermaidZoomInstance(
        host,
        svg,
        () => this.instances.delete(instance),
        () => {
          if (host.isConnected && !this.unloaded) this.enhanceMermaid(document.body);
        }
      );
      this.instances.add(instance);
    }
  }

  looksLikeMermaid(svg) {
    if (svg.closest(".mermaid, .mermaid-rendered")) return true;
    const id = svg.getAttribute("id") || "";
    return id.toLowerCase().includes("mermaid");
  }
};

class MermaidZoomInstance {
  constructor(host, svg, onDestroy, onDetached) {
    this.host = host;
    this.svg = svg;
    this.onDestroy = onDestroy;
    this.onDetached = onDetached;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.activePointers = new Map();
    this.lastPinch = null;
    this.dragStart = null;
    this.frame = null;
    this.win = null;
    this.syncQueued = false;
    this.released = false;

    this.originalParent = host.parentElement;
    this.originalNextSibling = host.nextSibling;
    this.originalHostStyle = host.getAttribute("style");
    this.svgOriginalStyle = svg.getAttribute("style");
    this.diagramKind = this.detectDiagramKind();

    this.build();
    this.bind();
    this.syncSvg();
    this.autoSizeContainer();
    this.reset();
    this.autoSizeSoon();
    this.resetSoon();
  }

  build() {
    this.host.dataset.mfzEnhanced = "true";
    this.host.classList.add("mfz-mermaid-host");
    this.layoutWidth = this.getLayoutWidth();

    this.container = document.createElement("div");
    this.container.className = `mfz-container mfz-kind-${this.diagramKind}`;
    this.container.tabIndex = 0;
    this.container.dataset.mfzKind = this.diagramKind;

    this.viewport = document.createElement("div");
    this.viewport.className = "mfz-viewport";

    this.content = document.createElement("div");
    this.content.className = "mfz-content";

    this.toolbar = document.createElement("div");
    this.toolbar.className = "mfz-toolbar";

    this.zoomOutButton = this.button("−", "缩小", () => this.zoomAtCenter(1 / ZOOM_STEP));
    this.zoomInButton = this.button("+", "放大", () => this.zoomAtCenter(ZOOM_STEP));
    this.resetButton = this.button("⟲", "重置并自适应", () => this.reset());
    this.windowButton = this.button("⤢", "在新窗口打开", () => this.openWindow());

    this.toolbar.append(
      this.zoomOutButton,
      this.zoomInButton,
      this.resetButton,
      this.windowButton
    );

    this.help = document.createElement("div");
    this.help.className = "mfz-help";
    this.help.textContent = "滚轮缩放，拖拽平移，Shift/横向滚轮左右移动，拖动右下角调整大小，⤢ 在新窗口打开";

    // 包装 .mermaid 节点，而不是把其中的 SVG 拆出来。
    // Pele 会观察 .mermaid 的子节点并在主题/尺寸变化时重绘，拆出 SVG 会被重绘覆盖。
    this.originalParent.insertBefore(this.container, this.originalNextSibling);
    this.content.appendChild(this.host);
    this.viewport.appendChild(this.content);
    this.container.append(this.viewport, this.toolbar, this.help);

    // 给 Pele 一个不小于 720px 的测量宽度，避免宽流程图被自动改成纵向布局。
    this.host.style.setProperty("width", `${this.layoutWidth}px`, "important");
    this.host.style.setProperty("max-width", "none", "important");
  }

  getLayoutWidth() {
    const width = Math.round(this.host.getBoundingClientRect().width || this.host.clientWidth || 0);
    let padding = 0;
    try {
      const style = getComputedStyle(this.host);
      padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    } catch (error) {
      // 读取失败时按无内边距处理
    }
    return Math.max(MIN_MERMAID_LAYOUT_WIDTH + padding, width);
  }

  detectDiagramKind() {
    const classText = Array.from(this.svg.classList || []).join(" ").toLowerCase();
    const ariaText = (this.svg.getAttribute("aria-roledescription") || "").toLowerCase();
    const labelText = (this.svg.getAttribute("aria-label") || "").toLowerCase();
    const text = `${classText} ${ariaText} ${labelText}`;

    if (text.includes("sequence") || text.includes("sequencediagram")) return "sequence";
    if (text.includes("flowchart") || text.includes("graph")) return "flowchart";
    if (text.includes("classdiagram")) return "class";
    if (text.includes("statediagram")) return "state";
    if (text.includes("gantt")) return "timeline";
    return "generic";
  }

  getProfile() {
    if (this.diagramKind === "sequence") {
      return {
        minHeight: this.container.clientWidth < 640 ? 320 : 300,
        maxHeightRatio: 0.78,
        maxHeight: 900,
        extraHeight: 104,
        fitMode: "width",
        padding: this.container.clientWidth < 640 ? 18 : 36,
      };
    }

    return {
      minHeight: this.container.clientWidth < 640 ? 260 : 220,
      maxHeightRatio: 0.72,
      maxHeight: 760,
      extraHeight: 72,
      fitMode: "contain",
      padding: this.container.clientWidth < 640 ? 18 : 32,
    };
  }

  button(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  bind() {
    this.abortController = new AbortController();
    const options = { signal: this.abortController.signal };
    const passiveFalse = { signal: this.abortController.signal, passive: false };

    this.viewport.addEventListener("wheel", (event) => this.onWheel(event), passiveFalse);
    // 如果 Pele 自带的缩放还未来得及禁用（首次渲染早于包装），在捕获阶段
    // 拦下它的 Ctrl/⌘+滚轮和双击缩放，避免与插件缩放叠加。
    this.viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    }, { signal: this.abortController.signal, capture: true, passive: false });
    this.viewport.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.zoomAt(event.clientX, event.clientY, ZOOM_STEP * ZOOM_STEP);
    }, { signal: this.abortController.signal, capture: true });
    this.viewport.addEventListener("pointerdown", (event) => this.onPointerDown(event), options);
    this.viewport.addEventListener("pointermove", (event) => this.onPointerMove(event), options);
    this.viewport.addEventListener("pointerup", (event) => this.onPointerUp(event), options);
    this.viewport.addEventListener("pointercancel", (event) => this.onPointerUp(event), options);
    this.container.addEventListener("click", () => this.focus(), options);
    this.container.addEventListener("keydown", (event) => this.onKeyDown(event), options);

    this.resizeObserver = new ResizeObserver(() => {
      this.autoSizeSoon();
      if (this.isNearInitialFit()) this.resetSoon();
    });
    this.resizeObserver.observe(this.container);

    // Pele 在主题、字体或可用宽度变化时会重绘 SVG（直接替换 .mermaid 的子节点）。
    // 监听并接管新的 SVG，避免继续操作已经被移除的旧节点。
    this.hostObserver = new MutationObserver(() => {
      if (this.syncQueued) return;
      this.syncQueued = true;
      window.clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => {
        this.syncQueued = false;
        this.syncSvg();
      }, 0);
    });
    this.hostObserver.observe(this.host, { childList: true });

    // Obsidian 的 Live Preview 会复用 .mermaid 节点：可能把它从本容器里
    // detach 后插入到另一个代码块。此时释放实例，让新位置重新增强。
    this.contentObserver = new MutationObserver(() => {
      if (this.released) return;
      if (!this.container.contains(this.host)) this.release();
    });
    this.contentObserver.observe(this.content, { childList: true });
  }

  syncSvg() {
    if (this.released) return;
    const next = this.host.querySelector(":scope > svg") ||
      this.host.querySelector("svg.pele") ||
      this.host.querySelector("svg[id^='mermaid']");
    if (!next || next === this.svg) return;

    this.svg = next;
    this.svg.dataset.mfzEnhanced = "true";
    this.svgOriginalStyle = next.getAttribute("style");
    this.lastAutoWidth = 0;

    // 直接同步一次，不依赖 requestAnimationFrame（后台标签页/窗口隐藏时
    // rAF 可能被暂停，导致新 SVG 沿用旧尺寸）。
    this.autoSizeContainer(true);
    this.reset();
  }

  focus() {
    document.querySelectorAll(".mfz-container.is-focused").forEach((el) => {
      if (el !== this.container) el.classList.remove("is-focused");
    });
    this.container.classList.add("is-focused");
  }

  onKeyDown(event) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomAtCenter(ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.zoomAtCenter(1 / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      this.reset();
    }
  }

  onWheel(event) {
    event.preventDefault();
    this.focus();

    const rect = this.viewport.getBoundingClientRect();
    const nearLeft = event.clientX - rect.left < EDGE_SCROLL_ZONE;
    const nearRight = rect.right - event.clientX < EDGE_SCROLL_ZONE;
    const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || nearLeft || nearRight;

    if (horizontalIntent && !event.ctrlKey && !event.metaKey) {
      const direction = event.deltaX || event.deltaY;
      this.x -= direction;
      this.apply();
      return;
    }

    const delta = event.deltaY || event.deltaX;
    const factor = Math.exp(-delta * 0.0015);
    this.zoomAt(event.clientX, event.clientY, factor);
  }

  onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    this.focus();
    this.viewport.setPointerCapture(event.pointerId);
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size === 1) {
      this.dragStart = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: this.x,
        y: this.y,
      };
    } else if (this.activePointers.size === 2) {
      this.dragStart = null;
      this.lastPinch = this.getPinchState();
    }
  }

  onPointerMove(event) {
    if (!this.activePointers.has(event.pointerId)) return;
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size === 2) {
      const pinch = this.getPinchState();
      if (!pinch || !this.lastPinch) return;
      const factor = pinch.distance / Math.max(1, this.lastPinch.distance);
      this.zoomAt(pinch.centerX, pinch.centerY, factor);
      this.x += pinch.centerX - this.lastPinch.centerX;
      this.y += pinch.centerY - this.lastPinch.centerY;
      this.lastPinch = pinch;
      this.apply();
      return;
    }

    if (!this.dragStart || this.dragStart.pointerId !== event.pointerId) return;
    this.x = this.dragStart.x + event.clientX - this.dragStart.pointerX;
    this.y = this.dragStart.y + event.clientY - this.dragStart.pointerY;
    this.apply();
  }

  onPointerUp(event) {
    this.activePointers.delete(event.pointerId);
    this.lastPinch = this.activePointers.size === 2 ? this.getPinchState() : null;
    this.dragStart = null;
  }

  getPinchState() {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return null;
    const [a, b] = points;
    return {
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  zoomAtCenter(factor) {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  zoomAt(clientX, clientY, factor) {
    const rect = this.viewport.getBoundingClientRect();
    const oldScale = this.scale;
    const nextScale = clamp(oldScale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === oldScale) return;

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const contentX = (localX - this.x) / oldScale;
    const contentY = (localY - this.y) / oldScale;

    this.scale = nextScale;
    this.x = localX - contentX * nextScale;
    this.y = localY - contentY * nextScale;
    this.apply();
  }

  autoSizeSoon(force = false) {
    window.requestAnimationFrame(() => this.autoSizeContainer(force));
  }

  autoSizeContainer(force = false) {
    if (!force && this.container.style.height && !this.container.dataset.mfzAutoHeight) return;

    const bounds = this.getSvgBounds();
    const width = this.container.clientWidth || this.layoutWidth || 800;
    if (!bounds.width || !bounds.height || !width) return;
    if (!force && this.container.dataset.mfzAutoHeight && Math.abs(width - (this.lastAutoWidth || 0)) < 2) return;

    const profile = this.getProfile();
    const aspectHeight = width * (bounds.height / bounds.width);
    const maxHeight = Math.min(window.innerHeight * profile.maxHeightRatio, profile.maxHeight);
    const nextHeight = Math.round(clamp(aspectHeight + profile.extraHeight, profile.minHeight, maxHeight));

    this.container.style.height = `${nextHeight}px`;
    this.container.dataset.mfzAutoHeight = "true";
    this.lastAutoWidth = width;
  }

  resetSoon() {
    window.requestAnimationFrame(() => this.reset());
  }

  reset() {
    const viewport = this.viewport.getBoundingClientRect();
    const bounds = this.getSvgBounds();
    if (!viewport.width || !viewport.height || !bounds.width || !bounds.height) return;

    this.content.style.width = `${bounds.width}px`;
    this.content.style.height = `${bounds.height}px`;
    this.svg.style.width = `${bounds.width}px`;
    this.svg.style.height = `${bounds.height}px`;
    this.svg.style.maxWidth = "none";

    const profile = this.getProfile();
    const padding = profile.padding;
    const availableWidth = Math.max(1, viewport.width - padding * 2);
    const availableHeight = Math.max(1, viewport.height - padding * 2);
    const widthScale = availableWidth / bounds.width;
    const containScale = Math.min(widthScale, availableHeight / bounds.height, 1);
    const sequenceScale = Math.min(widthScale, 1);
    const scale = profile.fitMode === "width" ? sequenceScale : containScale;

    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.x = (viewport.width - bounds.width * this.scale) / 2 - bounds.x * this.scale;
    this.y = profile.fitMode === "width" ? padding - bounds.y * this.scale : (viewport.height - bounds.height * this.scale) / 2 - bounds.y * this.scale;
    this.initialFit = { scale: this.scale, x: this.x, y: this.y };
    this.apply();
  }

  getSvgBounds() {
    const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
    if (viewBox && viewBox.width && viewBox.height && viewBox.width > 0 && viewBox.height > 0) {
      return { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height };
    }

    try {
      const box = this.svg.getBBox();
      if (box && box.width && box.height) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    } catch (error) {
      // 某些浏览器在 SVG 未挂载或未绘制完成时会抛错
    }

    const rect = this.svg.getBoundingClientRect();
    return { x: 0, y: 0, width: rect.width || 800, height: rect.height || 500 };
  }

  isNearInitialFit() {
    if (!this.initialFit) return true;
    return (
      Math.abs(this.scale - this.initialFit.scale) < 0.001 &&
      Math.abs(this.x - this.initialFit.x) < 1 &&
      Math.abs(this.y - this.initialFit.y) < 1
    );
  }

  apply() {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.content.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    });
  }

  openWindow() {
    let electron = null;
    try {
      electron = window.require("electron");
    } catch (error) {
      electron = null;
    }

    if (!electron || !electron.remote || !electron.remote.BrowserWindow) {
      new Notice("无法创建独立窗口（需桌面端 Obsidian）。");
      return;
    }

    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }

    const bounds = this.getSvgBounds();
    const bw = Math.round(bounds.width) || 800;
    const bh = Math.round(bounds.height) || 600;
    const winWidth = Math.max(420, Math.min(bw + 120, Math.round(window.screen.availWidth * 0.9)));
    const winHeight = Math.max(300, Math.min(bh + 140, Math.round(window.screen.availHeight * 0.9)));
    const colors = getThemeColors();
    const themeVars = getMermaidThemeVars(this.host, colors);
    const windowBg = themeVars["--pele-bg"] || colors.bg;

    let win = null;
    try {
      win = new electron.remote.BrowserWindow({
        width: winWidth,
        height: winHeight,
        title: "Mermaid 流程图",
        autoHideMenuBar: true,
        backgroundColor: windowBg,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
      });
    } catch (error) {
      new Notice("创建独立窗口失败：" + (error && error.message ? error.message : error));
      return;
    }

    this.win = win;
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });

    const html = buildWindowHtml(this.svg.outerHTML, colors, themeVars);
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  }

  teardown() {
    if (this.abortController) this.abortController.abort();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.hostObserver) this.hostObserver.disconnect();
    if (this.contentObserver) this.contentObserver.disconnect();
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    if (this.frame) window.cancelAnimationFrame(this.frame);
    if (this.win && !this.win.isDestroyed()) this.win.close();

    this.host.dataset.mfzEnhanced = "false";
    this.host.classList.remove("mfz-mermaid-host");
    if (this.svg) this.svg.removeAttribute("data-mfz-enhanced");
    if (this.svg && this.svg.isConnected !== false) {
      if (this.svgOriginalStyle === null) this.svg.removeAttribute("style");
      else this.svg.setAttribute("style", this.svgOriginalStyle);
    }
    if (this.originalHostStyle === null) this.host.removeAttribute("style");
    else this.host.setAttribute("style", this.originalHostStyle);
  }

  destroy() {
    if (this.released) return;
    this.released = true;
    this.teardown();

    if (this.originalParent) {
      const next = this.originalNextSibling && this.originalNextSibling.parentNode === this.originalParent
        ? this.originalNextSibling
        : null;
      this.originalParent.insertBefore(this.host, next);
    }
    this.container.remove();
    this.onDestroy();
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.teardown();
    this.container.remove();
    this.onDestroy();

    // 宿主已被 Obsidian 移动到新的代码块。等它落位后重新增强。
    if (this.host.isConnected) {
      window.setTimeout(() => {
        if (this.onDetached) this.onDetached();
      }, 0);
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getThemeColors() {
  let bg = "#ffffff";
  let text = "#333333";
  let muted = "#888888";
  let border = "#dddddd";
  let panel = "#f5f5f5";
  let accent = "#5b7bd5";
  let error = "#e45756";
  let isDark = false;
  try {
    const cs = getComputedStyle(document.body);
    bg = (cs.getPropertyValue("--background-primary") || "").trim() || bg;
    text = (cs.getPropertyValue("--text-normal") || "").trim() || text;
    muted = (cs.getPropertyValue("--text-muted") || "").trim() || muted;
    border = (cs.getPropertyValue("--background-modifier-border") || "").trim() || border;
    panel = (cs.getPropertyValue("--background-secondary") || "").trim() || panel;
    accent = (cs.getPropertyValue("--interactive-accent") || "").trim() || accent;
    error = (cs.getPropertyValue("--text-error") || "").trim() || error;
    isDark = document.body.classList.contains("theme-dark") ||
      document.documentElement.classList.contains("theme-dark");
  } catch (error) {
    // 读取失败时使用默认白色主题
  }
  return { bg, text, muted, border, panel, accent, error, isDark };
}

function getMermaidThemeVars(host, colors) {
  const vars = {};
  const svg = host && host.querySelector("svg");
  const sources = [svg, host, document.body, document.documentElement].filter(Boolean);
  const sourceStyles = sources.map((source) => getComputedStyle(source));
  const bodyStyle = getComputedStyle(document.body);

  for (const name of PELE_THEME_VARS) {
    for (const style of sourceStyles) {
      const value = (style.getPropertyValue(name) || "").trim();
      if (value) {
        vars[name] = value;
        break;
      }
    }
  }

  // 同时带上基础主题变量，保证主题里 color-mix()/var() 写法的值在独立窗口
  // 中也能继续解析。
  const baseVars = [
    "--background-primary",
    "--background-secondary",
    "--background-primary-alt",
    "--text-normal",
    "--text-muted",
    "--background-modifier-border",
    "--background-modifier-border-hover",
    "--interactive-accent",
    "--text-error",
    "--font-text",
    "--font-interface",
    "--radius-s",
    "--font-semibold",
    "--bold-weight",
    "--color-red",
    "--color-orange",
    "--color-yellow",
    "--color-green",
    "--color-cyan",
    "--color-blue",
    "--color-purple",
    "--color-pink",
  ];
  for (const name of baseVars) {
    if (vars[name]) continue;
    for (const style of sourceStyles) {
      const value = (style.getPropertyValue(name) || "").trim();
      if (value) {
        vars[name] = value;
        break;
      }
    }
  }

  vars["--pele-bg"] = vars["--pele-bg"] || colors.bg;
  vars["--pele-fg"] = vars["--pele-fg"] || colors.text;
  vars["--pele-muted"] = vars["--pele-muted"] || colors.muted;
  vars["--pele-line"] = vars["--pele-line"] || colors.text;
  vars["--pele-surface"] = vars["--pele-surface"] || colors.panel;
  vars["--pele-surface-alt"] = vars["--pele-surface-alt"] || colors.panel;
  vars["--pele-border"] = vars["--pele-border"] || colors.border;
  vars["--pele-accent"] = vars["--pele-accent"] || colors.accent;
  vars["--pele-critical"] = vars["--pele-critical"] || colors.error;
  vars["--pele-error"] = vars["--pele-error"] || colors.error;
  vars["--pele-font"] = vars["--pele-font"] || bodyStyle.fontFamily || "system-ui, sans-serif";
  vars["--pele-font-mono"] = vars["--pele-font-mono"] || "monospace";
  vars["--pele-radius"] = vars["--pele-radius"] || "4px";
  vars["--pele-title-weight"] = vars["--pele-title-weight"] || "600";
  vars["--pele-heading-weight"] = vars["--pele-heading-weight"] || "600";
  vars["--pele-bold-weight"] = vars["--pele-bold-weight"] || "700";
  vars["--link-color"] = vars["--link-color"] || colors.accent;

  const seriesNames = ["blue", "orange", "green", "red", "cyan", "yellow", "purple", "pink"];
  for (let i = 0; i < seriesNames.length; i += 1) {
    const name = `--pele-series-${i + 1}`;
    if (!vars[name]) {
      vars[name] = (bodyStyle.getPropertyValue(`--color-${seriesNames[i]}`) || "").trim() || SERIES_FALLBACKS[i];
    }
  }

  return vars;
}

function serializeCssVariables(vars) {
  return Object.entries(vars)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}:${String(value).replace(/[\r\n]+/g, " ")};`)
    .join("");
}

function buildWindowHtml(svgMarkup, colors, themeVars) {
  const themeCss = serializeCssVariables(themeVars || {});
  const tpl = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Mermaid 流程图</title>
<style>
  :root{
    ${themeCss}
    --bg: var(--pele-bg, ${colors.bg});
    --panel: ${colors.panel};
    --fg: var(--pele-fg, ${colors.text});
    --muted: var(--pele-muted, ${colors.muted});
    --border: var(--pele-border, ${colors.border});
    color-scheme: ${colors.isDark ? "dark" : "light"};
  }
  html,body{margin:0;height:100%;overflow:hidden;background:var(--pele-bg,var(--bg));font-family:var(--pele-font,system-ui,"Microsoft YaHei",sans-serif);color:var(--fg);}
  #toolbar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:6px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--border);z-index:10;user-select:none;}
  #toolbar .title{font-size:13px;color:var(--muted);margin-right:auto;}
  #toolbar button{width:30px;height:30px;font-size:15px;line-height:1;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}
  #toolbar button:hover{filter:brightness(0.9);}
  #viewport{position:fixed;top:44px;left:0;right:0;bottom:0;overflow:hidden;cursor:grab;}
  #viewport:active{cursor:grabbing;}
  #content{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform;}
  #content svg{display:block;max-width:none;}
  .pele a.internal-link{fill:var(--link-color,var(--fg));}
</style>
</head>
<body>
<div id="toolbar">
  <button id="zo" title="缩小">−</button>
  <button id="zi" title="放大">+</button>
  <button id="zr" title="重置/适应窗口">⟲</button>
  <span class="title">滚轮缩放 · 拖拽平移 · Esc 关闭</span>
  <button id="zc" title="关闭">✕</button>
</div>
<div id="viewport"><div id="content">__SVG__</div></div>
<script>
(function(){
  var viewport=document.getElementById('viewport');
  var content=document.getElementById('content');
  var svg=content.querySelector('svg');
  var scale=1,x=0,y=0,MIN=0.05,MAX=12;
  function clamp(v,a,b){return Math.min(b,Math.max(a,v));}
  function apply(){content.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';}
  function svgSize(){
    if(svg.viewBox&&svg.viewBox.baseVal&&svg.viewBox.baseVal.width){var v=svg.viewBox.baseVal;return {x:v.x||0,y:v.y||0,w:v.width,h:v.height};}
    try{var b=svg.getBBox();return {x:b.x||0,y:b.y||0,w:b.width,h:b.height};}catch(e){}
    var r=svg.getBoundingClientRect();return {x:0,y:0,w:r.width||800,h:r.height||600};
  }
  function fit(){
    var s=svgSize(),pad=20,vw=viewport.clientWidth,vh=viewport.clientHeight;
    scale=clamp(Math.min((vw-pad*2)/s.w,(vh-pad*2)/s.h),MIN,MAX);
    x=(vw-s.w*scale)/2-s.x*scale;y=(vh-s.h*scale)/2-s.y*scale;apply();
  }
  function zoomAt(cx,cy,factor){
    var r=viewport.getBoundingClientRect(),old=scale,ns=clamp(old*factor,MIN,MAX);
    if(ns===old)return;
    var lx=cx-r.left,ly=cy-r.top,cx2=(lx-x)/old,cy2=(ly-y)/old;
    scale=ns;x=lx-cx2*ns;y=ly-cy2*ns;apply();
  }
  viewport.addEventListener('wheel',function(e){e.preventDefault();zoomAt(e.clientX,e.clientY,Math.exp(-e.deltaY*0.0015));},{passive:false});
  var dragging=false,sx=0,sy=0,ox=0,oy=0;
  viewport.addEventListener('pointerdown',function(e){dragging=true;sx=e.clientX;sy=e.clientY;ox=x;oy=y;viewport.setPointerCapture(e.pointerId);});
  viewport.addEventListener('pointermove',function(e){if(!dragging)return;x=ox+(e.clientX-sx);y=oy+(e.clientY-sy);apply();});
  viewport.addEventListener('pointerup',function(){dragging=false;});
  viewport.addEventListener('pointercancel',function(){dragging=false;});
  document.getElementById('zo').addEventListener('click',function(){var r=viewport.getBoundingClientRect();zoomAt(r.left+r.width/2,r.top+r.height/2,1/1.18);});
  document.getElementById('zi').addEventListener('click',function(){var r=viewport.getBoundingClientRect();zoomAt(r.left+r.width/2,r.top+r.height/2,1.18);});
  document.getElementById('zr').addEventListener('click',fit);
  function closeWin(){
    try{window.require('electron').remote.getCurrentWindow().close();}
    catch(e){window.close();}
  }
  document.getElementById('zc').addEventListener('click',closeWin);
  window.addEventListener('keydown',function(e){if(e.key==='Escape'){closeWin();}});
  window.addEventListener('resize',fit);
  fit();
})();
</script>
</body>
</html>`;

  return tpl.replace("__SVG__", () => svgMarkup);
}
