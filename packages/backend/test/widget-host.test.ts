import type { ExtensionWidgetView } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUiContext } from "../src/session/ui-context";
import {
	ExtensionWidgetHost,
	normalizeWidgetLines,
	stripAnsi,
	WIDGET_MAX_LINES,
	type WidgetFactory,
} from "../src/session/widget-host";

function makeHost(overrides: Partial<ConstructorParameters<typeof ExtensionWidgetHost>[0]> = {}) {
	const published: ExtensionWidgetView[][] = [];
	const host = new ExtensionWidgetHost({
		theme: { fg: (_c: string, t: string) => t },
		publish: (views) => published.push(views),
		...overrides,
	});
	return { host, published };
}

describe("stripAnsi / normalizeWidgetLines", () => {
	it("剥离 SGR、truecolor、OSC 8 超链接", () => {
		expect(stripAnsi("\u001b[38;2;122;162;247m✓ Task-1\u001b[39m \u001b[1mdone\u001b[22m")).toBe(
			"✓ Task-1 done",
		);
		expect(stripAnsi("\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007")).toBe("link");
	});

	it("去行尾空白、首尾空行，超长截断并标注", () => {
		expect(normalizeWidgetLines(["", "a  ", "", "b", ""])).toEqual(["a", "", "b"]);
		const many = Array.from({ length: WIDGET_MAX_LINES + 5 }, (_, i) => `l${i}`);
		const out = normalizeWidgetLines(many);
		expect(out).toHaveLength(WIDGET_MAX_LINES);
		expect(out.at(-1)).toBe("… (+6 lines)");
	});
});

describe("ExtensionWidgetHost", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("字符串行立即推送，undefined 移除并推空快照", () => {
		const { host, published } = makeHost();
		host.set("k", ["\u001b[32mhello\u001b[0m"], undefined, "ext");
		expect(published.at(-1)).toEqual([
			{ key: "k", placement: "aboveEditor", lines: ["hello"], source: "ext" },
		]);
		host.set("k", undefined, undefined, "ext");
		expect(published.at(-1)).toEqual([]);
	});

	it("工厂按 TUI 契约收到 (tui, theme)，render 用固定宽度", () => {
		const { host, published } = makeHost({ width: 72 });
		const factory = vi.fn<WidgetFactory>((tui, theme) => {
			expect(typeof (tui as { requestRender: unknown }).requestRender).toBe("function");
			expect((tui as { terminal: { columns: number } }).terminal.columns).toBe(72);
			expect(typeof (theme as { fg: unknown }).fg).toBe("function");
			return { render: (width) => [`w=${width}`] };
		});
		host.set("dash", factory, "belowEditor", "pi-plans");
		expect(factory).toHaveBeenCalledOnce();
		expect(published.at(-1)).toEqual([
			{ key: "dash", placement: "belowEditor", lines: ["w=72"], source: "pi-plans" },
		]);
	});

	it("不调 requestRender 的组件靠轮询刷新，内容不变不重复推送", () => {
		const { host, published } = makeHost({ pollMs: 1000 });
		let state = "running";
		host.set("dash", () => ({ render: () => [state] }), undefined, "");
		expect(published).toHaveLength(1);
		vi.advanceTimersByTime(3000);
		expect(published).toHaveLength(1);
		state = "done";
		vi.advanceTimersByTime(1000);
		expect(published.at(-1)?.[0]?.lines).toEqual(["done"]);
		expect(published).toHaveLength(2);
	});

	it("requestRender 节流合并为一次重绘", () => {
		const { host, published } = makeHost({ pollMs: 60_000, throttleMs: 100 });
		let n = 0;
		let tui: { requestRender: () => void } | undefined;
		host.set(
			"k",
			(t) => {
				tui = t as typeof tui;
				return { render: () => [`n=${n}`] };
			},
			undefined,
			"",
		);
		n = 1;
		tui?.requestRender();
		tui?.requestRender();
		n = 2;
		tui?.requestRender();
		expect(published).toHaveLength(1);
		vi.advanceTimersByTime(100);
		expect(published).toHaveLength(2);
		expect(published.at(-1)?.[0]?.lines).toEqual(["n=2"]);
	});

	it("渲染异常只影响自身 widget，并上报错误", () => {
		const onError = vi.fn();
		const { host, published } = makeHost({ onError });
		host.set("ok", ["fine"], undefined, "");
		host.set(
			"bad",
			() => ({
				render: () => {
					throw new Error("boom");
				},
			}),
			undefined,
			"",
		);
		expect(published.at(-1)?.map((w) => w.lines)).toEqual([["fine"], ["[widget error] boom"]]);
		expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
	});

	it("替换与 dispose 时调用组件 dispose，停止轮询并推空快照", () => {
		const { host, published } = makeHost({ pollMs: 1000 });
		const first = vi.fn();
		const second = vi.fn();
		host.set("k", () => ({ render: () => ["a"], dispose: first }), undefined, "");
		host.set("k", () => ({ render: () => ["b"], dispose: second }), undefined, "");
		expect(first).toHaveBeenCalledOnce();
		host.dispose();
		expect(second).toHaveBeenCalledOnce();
		expect(published.at(-1)).toEqual([]);
		const count = published.length;
		vi.advanceTimersByTime(5000);
		host.set("k", ["late"], undefined, "");
		expect(published).toHaveLength(count);
	});
});

describe("makeUiContext.setWidget", () => {
	it("透传 key / content / placement 与来源", () => {
		const onWidget = vi.fn();
		const ui = makeUiContext({ onWidget });
		const factory = () => ({ render: () => [], invalidate: () => {} });
		ui.setWidget("a", ["x"]);
		ui.setWidget("b", factory, { placement: "belowEditor" });
		ui.setWidget("a", undefined);
		expect(onWidget.mock.calls.map((call) => call.slice(0, 3))).toEqual([
			["a", ["x"], undefined],
			["b", factory, "belowEditor"],
			["a", undefined, undefined],
		]);
	});

	it("缺省依赖时 setWidget 仍为 no-op", () => {
		expect(() => makeUiContext({}).setWidget("a", ["x"])).not.toThrow();
	});
});
