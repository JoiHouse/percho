import type { ExtensionWidgetPlacement, ExtensionWidgetView } from "@percho/shared";

/**
 * 扩展 `ctx.ui.setWidget` 的 GUI 桥（每会话一个）。
 *
 * SDK 契约：content 为字符串行，或 `(tui, theme) => Component` 工厂。TUI 宿主在每次重绘时调用
 * `component.render(width)`；不少扩展（如 pi-plans 任务面板）从不调用 `requestRender`，完全依赖
 * TUI 的重绘循环取最新状态。GUI 没有这个循环，所以这里用两条触发路径模拟：
 * - 扩展调用 `tui.requestRender()` → 节流后立即重绘；
 * - 存在工厂型 widget 时按固定间隔重绘，仅在输出变化时推送。
 *
 * 输出剥离 ANSI 后作为纯文本行推给 renderer（扩展主题色是终端色盘，不跟随 GUI 亮暗主题）。
 */

export interface WidgetComponent {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
}

export type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;
export type WidgetContent = string[] | WidgetFactory | undefined;

export interface WidgetHostOptions {
	/** 传给工厂的 Theme（与 ctx.ui.theme 同一实例） */
	theme: unknown;
	/** 全量快照推送（仅在内容变化时调用） */
	publish: (widgets: ExtensionWidgetView[]) => void;
	/** 渲染宽度（列）；默认 100 */
	width?: number;
	/** 重绘轮询间隔；默认 1000ms */
	pollMs?: number;
	/** requestRender 节流；默认 100ms */
	throttleMs?: number;
	/** 渲染异常上报（不影响其他 widget） */
	onError?: (key: string, error: unknown) => void;
}

interface WidgetEntry {
	placement: ExtensionWidgetPlacement;
	source: string;
	lines?: string[];
	component?: WidgetComponent;
}

export const WIDGET_DEFAULT_WIDTH = 100;
export const WIDGET_MAX_LINES = 80;

// CSI（含 SGR）、OSC（含 OSC 8 超链接，BEL 或 ST 结尾）及其余两字节转义
const ANSI_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离终端转义序列必须匹配控制字符
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** 剥 ANSI、去行尾空白、去首尾空行、限制行数 */
export function normalizeWidgetLines(lines: readonly unknown[]): string[] {
	const out = lines.map((line) => stripAnsi(String(line ?? "")).replace(/\s+$/u, ""));
	while (out.length && out[0] === "") out.shift();
	while (out.length && out[out.length - 1] === "") out.pop();
	if (out.length > WIDGET_MAX_LINES) {
		const hidden = out.length - (WIDGET_MAX_LINES - 1);
		return [...out.slice(0, WIDGET_MAX_LINES - 1), `… (+${hidden} lines)`];
	}
	return out;
}

export class ExtensionWidgetHost {
	private readonly entries = new Map<string, WidgetEntry>();
	private readonly width: number;
	private readonly pollMs: number;
	private readonly throttleMs: number;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private lastPublished = "[]";
	private disposed = false;

	constructor(private readonly options: WidgetHostOptions) {
		this.width = options.width ?? WIDGET_DEFAULT_WIDTH;
		this.pollMs = options.pollMs ?? 1000;
		this.throttleMs = options.throttleMs ?? 100;
	}

	/** ExtensionUIContext.setWidget 的实现体 */
	set(
		key: string,
		content: WidgetContent,
		placement: ExtensionWidgetPlacement | undefined,
		source: string,
	): void {
		if (this.disposed) return;
		this.release(key);
		if (content === undefined) {
			this.entries.delete(key);
		} else if (Array.isArray(content)) {
			this.entries.set(key, { placement: placement ?? "aboveEditor", source, lines: [...content] });
		} else if (typeof content === "function") {
			let component: WidgetComponent;
			try {
				component = content(this.tuiStub(), this.options.theme);
			} catch (error) {
				this.options.onError?.(key, error);
				this.entries.set(key, {
					placement: placement ?? "aboveEditor",
					source,
					lines: [`[widget error] ${errorText(error)}`],
				});
				this.syncPolling();
				this.flush();
				return;
			}
			this.entries.set(key, { placement: placement ?? "aboveEditor", source, component });
		} else {
			return;
		}
		this.syncPolling();
		this.flush();
	}

	/** 当前快照（同步渲染全部 widget） */
	snapshot(): ExtensionWidgetView[] {
		const views: ExtensionWidgetView[] = [];
		for (const [key, entry] of this.entries) {
			let raw: unknown[];
			if (entry.component) {
				try {
					const rendered = entry.component.render(this.width);
					raw = Array.isArray(rendered) ? rendered : [];
				} catch (error) {
					this.options.onError?.(key, error);
					raw = [`[widget error] ${errorText(error)}`];
				}
			} else {
				raw = entry.lines ?? [];
			}
			const lines = normalizeWidgetLines(raw);
			if (lines.length) views.push({ key, placement: entry.placement, lines, source: entry.source });
		}
		return views;
	}

	/** 渲染并在变化时推送 */
	flush(): void {
		if (this.disposed) return;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const views = this.snapshot();
		const serialized = JSON.stringify(views);
		if (serialized === this.lastPublished) return;
		this.lastPublished = serialized;
		this.options.publish(views);
	}

	dispose(): void {
		if (this.disposed) return;
		const hadContent = this.lastPublished !== "[]";
		for (const key of this.entries.keys()) this.release(key);
		this.entries.clear();
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.pollTimer = undefined;
		this.flushTimer = undefined;
		this.disposed = true;
		if (hadContent) this.options.publish([]);
	}

	private scheduleFlush(): void {
		if (this.disposed || this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, this.throttleMs);
		unref(this.flushTimer);
	}

	private syncPolling(): void {
		const needsPolling = [...this.entries.values()].some((entry) => entry.component);
		if (needsPolling && !this.pollTimer) {
			this.pollTimer = setInterval(() => this.flush(), this.pollMs);
			unref(this.pollTimer);
		} else if (!needsPolling && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private release(key: string): void {
		const component = this.entries.get(key)?.component;
		if (!component?.dispose) return;
		try {
			component.dispose();
		} catch (error) {
			this.options.onError?.(key, error);
		}
	}

	/** 工厂拿到的最小 TUI：只提供重绘请求与终端尺寸；GUI 无键盘焦点/覆盖层 */
	private tuiStub(): unknown {
		const width = this.width;
		return {
			requestRender: () => this.scheduleFlush(),
			terminal: { columns: width, rows: 40 },
		};
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unref(timer: unknown): void {
	(timer as { unref?: () => void } | undefined)?.unref?.();
}
