import type { ExtensionWidgetView, SubagentRunUi } from "@percho/shared";
import { create } from "zustand";

/**
 * 扩展 setWidget 的 GUI 投影（叶子 store，只依赖 zustand）。
 *
 * 数据源：backend widget 宿主按会话推全量快照（`onExtensionWidgets`），渲染端重载/远端重连时
 * 由 `getPendingInteractions().widgets` 补齐。会话无 widget 时删除键，避免空数组残留。
 */
interface ExtensionWidgetsState {
	bySession: Record<string, ExtensionWidgetView[]>;
	setWidgets: (sessionId: string, widgets: ExtensionWidgetView[]) => void;
	/** 用快照替换 belongs 命中的全部会话（同一运行环境的全量安装） */
	install: (
		belongs: (sessionId: string) => boolean,
		snapshot: Array<{ sessionId: string; widgets: ExtensionWidgetView[] }>,
	) => void;
}

const EMPTY: ExtensionWidgetView[] = [];

export const useExtensionWidgetsStore = create<ExtensionWidgetsState>((set) => ({
	bySession: {},
	setWidgets: (sessionId, widgets) =>
		set((state) => {
			const next = { ...state.bySession };
			if (widgets.length) next[sessionId] = widgets;
			else delete next[sessionId];
			return { bySession: next };
		}),
	install: (belongs, snapshot) =>
		set((state) => {
			const next: Record<string, ExtensionWidgetView[]> = {};
			for (const [id, widgets] of Object.entries(state.bySession)) if (!belongs(id)) next[id] = widgets;
			for (const item of snapshot) if (item.widgets.length) next[item.sessionId] = item.widgets;
			return { bySession: next };
		}),
}));

/**
 * 扩展子代理运行行（percho:subagent-runs 协议）：父会话 → 运行快照。与 widget 同源同生命周期，放同一叶子模块。
 */
interface ExtensionSubagentRunsState {
	bySession: Record<string, SubagentRunUi[]>;
	setRuns: (sessionId: string, runs: SubagentRunUi[]) => void;
	install: (
		belongs: (sessionId: string) => boolean,
		snapshot: Array<{ sessionId: string; runs: SubagentRunUi[] }>,
	) => void;
}

const NO_RUNS: SubagentRunUi[] = [];

export const useExtensionSubagentRunsStore = create<ExtensionSubagentRunsState>((set) => ({
	bySession: {},
	setRuns: (sessionId, runs) =>
		set((state) => {
			const next = { ...state.bySession };
			if (runs.length) next[sessionId] = runs;
			else delete next[sessionId];
			return { bySession: next };
		}),
	install: (belongs, snapshot) =>
		set((state) => {
			const next: Record<string, SubagentRunUi[]> = {};
			for (const [id, runs] of Object.entries(state.bySession)) if (!belongs(id)) next[id] = runs;
			for (const item of snapshot) if (item.runs.length) next[item.sessionId] = item.runs;
			return { bySession: next };
		}),
}));

export function useSessionExtensionRuns(sessionId: string | null): SubagentRunUi[] {
	return useExtensionSubagentRunsStore((s) => (sessionId ? (s.bySession[sessionId] ?? NO_RUNS) : NO_RUNS));
}

/** 某会话指定位置的 widget（无则返回稳定空数组，避免无关重渲染） */
export function useSessionWidgets(sessionId: string | null): ExtensionWidgetView[] {
	return useExtensionWidgetsStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY) : EMPTY));
}
