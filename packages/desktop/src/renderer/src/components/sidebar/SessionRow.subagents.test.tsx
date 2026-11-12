import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 侧边栏会话行：主会话空闲但子代理（内置 subagent 当前轮运行行 / 扩展登记的子代理）仍在跑时，
 * 行尾显示「工作中」呼吸点 + 进行中数量；没有进行中的子代理时不显示数量。
 */
type Run = { status: string };
const state = vi.hoisted(() => ({
	entry: undefined as
		| undefined
		| {
				pendingPermissions: unknown[];
				pendingDialogs: unknown[];
				agentActive: boolean;
				unseenCompletion: boolean;
				streaming: { subagentRuns: Run[] } | null;
		  },
	extensionRuns: [] as Run[],
}));

vi.mock("../../i18n", () => ({
	useT: () => (key: string, params?: Record<string, unknown>) =>
		params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("../../stores/transcript", () => ({
	useTranscriptStore: (selector: (s: unknown) => unknown) =>
		selector({ bySession: state.entry ? { s1: state.entry } : {} }),
}));
vi.mock("../../stores/extension-widgets", () => ({
	useExtensionSubagentRunsStore: (selector: (s: unknown) => unknown) =>
		selector({ bySession: state.extensionRuns.length ? { s1: state.extensionRuns } : {} }),
}));

import { SessionRow } from "./SessionRow";

const session = {
	sessionId: "s1",
	cwd: "/proj/demo",
	active: true,
	messageCount: 0,
	createdAt: 1,
	name: "继续",
};
const markup = () =>
	renderToStaticMarkup(<SessionRow session={session as never} active={false} onSelect={() => {}} />);

function entry(overrides: Partial<NonNullable<typeof state.entry>> = {}) {
	return {
		pendingPermissions: [],
		pendingDialogs: [],
		agentActive: false,
		unseenCompletion: false,
		streaming: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.stubGlobal("React", React);
	state.entry = entry();
	state.extensionRuns = [];
});

afterEach(() => vi.unstubAllGlobals());

describe("SessionRow 子代理进行中", () => {
	it("空闲且无子代理：无状态点、无数量", () => {
		const html = markup();
		expect(html).not.toContain("sidebar-dot-working");
		expect(html).not.toContain("sidebar.activeSubagents");
	});

	it("主会话空闲但扩展子代理在跑：工作中点 + 只数进行中的", () => {
		state.extensionRuns = [
			{ status: "running" },
			{ status: "queued" },
			{ status: "done" },
			{ status: "error" },
		];
		const html = markup();
		expect(html).toContain("sidebar-dot-working");
		expect(html).toContain("sidebar.activeSubagents:{&quot;n&quot;:2}");
		expect(html).toMatch(/>2<\/span>/);
	});

	it("内置与扩展子代理合计", () => {
		state.entry = entry({
			agentActive: true,
			streaming: { subagentRuns: [{ status: "running" }, { status: "done" }] },
		});
		state.extensionRuns = [{ status: "running" }];
		expect(markup()).toMatch(/>2<\/span>/);
	});

	it("会话未加载进 transcript 时仍按扩展子代理显示工作中", () => {
		state.entry = undefined;
		state.extensionRuns = [{ status: "running" }];
		expect(markup()).toContain("sidebar-dot-working");
	});

	it("待审批优先于子代理工作中，但数量照常显示", () => {
		state.entry = entry({ pendingPermissions: [{}] });
		state.extensionRuns = [{ status: "running" }];
		const html = markup();
		expect(html).toContain("bg-amber-500");
		expect(html).not.toContain("sidebar-dot-working");
		expect(html).toMatch(/>1<\/span>/);
	});
});
