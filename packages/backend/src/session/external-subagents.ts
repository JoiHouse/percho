import type { AgentSessionEvent, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	PERCHO_SUBAGENT_RUNS_CHANNEL,
	PERCHO_SUBAGENT_RUNS_VERSION,
	type SubagentRunStatus,
	type SubagentRunUi,
	subagentUiStatus,
} from "@percho/shared";
import type { SubagentRunHandle } from "../tools/subagent/runner";
import type { RunningSessionSource } from "./read-only-view";

/**
 * 扩展子代理运行登记（Percho 私有协议 v1，频道见 PERCHO_SUBAGENT_RUNS_CHANNEL）。
 *
 * 扩展广播的消息（全部字段为扩展提供的非受信数据，逐项校验）：
 * - `{ v: 1, type: "run", parentSessionId, runId, agent, status, task?, model?, thinkingLevel?,
 *     tokens?, error?, index?, session?, abort? }`：upsert 一条运行；`session` 为该子会话的活
 *     AgentSession（同进程对象），首次出现且运行未结束时登记为可实时检视的子代理；
 * - `{ v: 1, type: "remove", parentSessionId, runId }`：移除一条运行。
 *
 * 子会话生命周期归扩展所有：Percho 只订阅事件、借用读取面和 abort，从不 dispose 它。
 */

const TERMINAL: ReadonlySet<SubagentRunStatus> = new Set(["done", "failed", "aborted"]);
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed", "aborted"]);
/** 每个父会话最多保留的运行行（超出时淘汰最早结束的） */
export const EXTERNAL_RUNS_LIMIT = 40;

export interface LiveSessionLike {
	sessionId: string;
	sessionFile?: string;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	sessionManager: { getBranch(): unknown };
	abort?(): Promise<void>;
}

export interface ExternalRunMessage {
	type: "run";
	parentSessionId: string;
	runId: string;
	agent: string;
	status: SubagentRunStatus;
	task?: string;
	model?: string;
	thinkingLevel?: string;
	tokens?: number;
	error?: string;
	index?: number;
	session?: LiveSessionLike;
	abort?: () => unknown;
}

export interface ExternalRemoveMessage {
	type: "remove";
	parentSessionId: string;
	runId: string;
}

export type ExternalMessage = ExternalRunMessage | ExternalRemoveMessage;

interface RunState {
	runId: string;
	order: number;
	data: Omit<ExternalRunMessage, "type" | "parentSessionId" | "session" | "abort">;
	sessionFile?: string;
	abort?: () => unknown;
	/** 已登记到 runningSubagents 的子会话 ID（未登记/已注销为 undefined） */
	registeredId?: string;
	unsubscribe?: () => void;
}

export interface ExternalSubagentDeps {
	/** 父会话仍由本后端持有（可写会话） */
	isParentAlive: (parentSessionId: string) => boolean;
	registerRun: (sessionId: string, handle: SubagentRunHandle) => void;
	unregisterRun: (sessionId: string) => void;
	onEvent: (sessionId: string, event: AgentSessionEvent, abort: () => Promise<void>) => void;
	publish: (parentSessionId: string, runs: SubagentRunUi[]) => void;
	onError?: (message: string, error?: unknown) => void;
}

const text = (value: unknown, max = 2000): string | undefined =>
	typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

function isLiveSession(value: unknown): value is LiveSessionLike {
	const session = value as Partial<LiveSessionLike> | null | undefined;
	return (
		!!session &&
		typeof session.sessionId === "string" &&
		session.sessionId.length > 0 &&
		typeof session.subscribe === "function" &&
		typeof session.sessionManager?.getBranch === "function"
	);
}

/** 校验并规范化扩展消息；不合法返回 undefined */
export function parseExternalMessage(raw: unknown): ExternalMessage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const msg = raw as Record<string, unknown>;
	if (msg.v !== PERCHO_SUBAGENT_RUNS_VERSION) return undefined;
	const parentSessionId = text(msg.parentSessionId, 200);
	const runId = text(msg.runId, 200);
	if (!parentSessionId || !runId) return undefined;
	if (msg.type === "remove") return { type: "remove", parentSessionId, runId };
	if (msg.type !== "run") return undefined;
	const agent = text(msg.agent, 120);
	if (!agent || typeof msg.status !== "string" || !STATUSES.has(msg.status)) return undefined;
	return {
		type: "run",
		parentSessionId,
		runId,
		agent,
		status: msg.status as SubagentRunStatus,
		task: text(msg.task),
		model: text(msg.model, 200),
		thinkingLevel: text(msg.thinkingLevel, 40),
		tokens: count(msg.tokens),
		error: text(msg.error),
		index: count(msg.index),
		session: isLiveSession(msg.session) ? msg.session : undefined,
		abort: typeof msg.abort === "function" ? (msg.abort as () => unknown) : undefined,
	};
}

export class ExternalSubagentRuns {
	private readonly parents = new Map<string, Map<string, RunState>>();
	private order = 0;

	constructor(private readonly deps: ExternalSubagentDeps) {}

	handle(raw: unknown): void {
		const msg = parseExternalMessage(raw);
		if (!msg) return;
		if (!this.deps.isParentAlive(msg.parentSessionId)) return;
		if (msg.type === "remove") {
			const runs = this.parents.get(msg.parentSessionId);
			const state = runs?.get(msg.runId);
			if (!runs || !state) return;
			this.detach(state);
			runs.delete(msg.runId);
			this.publish(msg.parentSessionId);
			return;
		}
		let runs = this.parents.get(msg.parentSessionId);
		if (!runs) {
			runs = new Map();
			this.parents.set(msg.parentSessionId, runs);
		}
		let state = runs.get(msg.runId);
		if (!state) {
			state = {
				runId: msg.runId,
				order: ++this.order,
				data: { runId: msg.runId, agent: msg.agent, status: msg.status },
			};
			runs.set(msg.runId, state);
		}
		const { type: _type, parentSessionId: _parent, session, abort, ...data } = msg;
		state.data = { ...state.data, ...stripUndefined(data) };
		if (abort) state.abort = abort;
		if (session) {
			state.sessionFile = typeof session.sessionFile === "string" ? session.sessionFile : state.sessionFile;
			if (!TERMINAL.has(msg.status) && state.registeredId === undefined) this.attach(state, session);
		}
		if (TERMINAL.has(msg.status)) this.detach(state);
		this.trim(runs);
		this.publish(msg.parentSessionId);
	}

	snapshot(parentSessionId: string): SubagentRunUi[] {
		const runs = this.parents.get(parentSessionId);
		if (!runs) return [];
		return [...runs.values()].sort((a, b) => a.order - b.order).map((state) => this.view(state));
	}

	parentIds(): string[] {
		return [...this.parents.keys()];
	}

	/** 父会话关闭：注销全部登记，清空并推空快照 */
	disposeParent(parentSessionId: string): void {
		const runs = this.parents.get(parentSessionId);
		if (!runs) return;
		for (const state of runs.values()) this.detach(state);
		this.parents.delete(parentSessionId);
		this.deps.publish(parentSessionId, []);
	}

	dispose(): void {
		for (const runs of this.parents.values()) for (const state of runs.values()) this.detach(state);
		this.parents.clear();
	}

	private attach(state: RunState, session: LiveSessionLike): void {
		const abort = async () => {
			try {
				if (state.abort) await state.abort();
				else await session.abort?.();
			} catch (error) {
				this.deps.onError?.("external subagent abort failed", error);
			}
		};
		const handle: SubagentRunHandle = {
			getSource: () => session as unknown as RunningSessionSource,
			abort,
			// 生命周期归扩展：Percho 只解除登记，不销毁对方会话
			dispose: () => {},
			getBranch: () => session.sessionManager.getBranch() as ReturnType<SubagentRunHandle["getBranch"]>,
		};
		try {
			this.deps.registerRun(session.sessionId, handle);
		} catch (error) {
			this.deps.onError?.("external subagent register failed", error);
			return;
		}
		state.registeredId = session.sessionId;
		try {
			state.unsubscribe = session.subscribe((event) => this.deps.onEvent(session.sessionId, event, abort));
		} catch (error) {
			this.deps.onError?.("external subagent subscribe failed", error);
		}
	}

	private detach(state: RunState): void {
		try {
			state.unsubscribe?.();
		} catch (error) {
			this.deps.onError?.("external subagent unsubscribe failed", error);
		}
		state.unsubscribe = undefined;
		if (state.registeredId !== undefined) {
			const id = state.registeredId;
			state.registeredId = undefined;
			try {
				this.deps.unregisterRun(id);
			} catch (error) {
				this.deps.onError?.("external subagent unregister failed", error);
			}
		}
	}

	private trim(runs: Map<string, RunState>): void {
		if (runs.size <= EXTERNAL_RUNS_LIMIT) return;
		const finished = [...runs.values()]
			.filter((state) => TERMINAL.has(state.data.status))
			.sort((a, b) => a.order - b.order);
		for (const state of finished) {
			if (runs.size <= EXTERNAL_RUNS_LIMIT) break;
			this.detach(state);
			runs.delete(state.runId);
		}
	}

	private publish(parentSessionId: string): void {
		this.deps.publish(parentSessionId, this.snapshot(parentSessionId));
	}

	private view(state: RunState): SubagentRunUi {
		const { data } = state;
		return {
			key: `ext:${state.runId}`,
			agent: data.agent,
			status: subagentUiStatus(data.status),
			...(data.task ? { task: data.task } : {}),
			...(data.model ? { model: data.model } : {}),
			...(data.thinkingLevel ? { thinkingLevel: data.thinkingLevel } : {}),
			...(data.tokens !== undefined ? { tokens: data.tokens } : {}),
			...(data.index !== undefined ? { index: data.index } : {}),
			...(data.status === "failed" ? { exitCode: 1 } : data.status === "done" ? { exitCode: 0 } : {}),
			...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
		};
	}
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 主会话内置扩展：把本会话事件总线上的协议消息交给后端 */
export function makeExternalSubagentBridgeExtension(onMessage: (raw: unknown) => void): InlineExtension {
	return {
		name: "percho-subagent-runs",
		factory: (pi) => {
			pi.events.on(PERCHO_SUBAGENT_RUNS_CHANNEL, (data) => {
				try {
					onMessage(data);
				} catch {
					// 宿主处理异常不能反噬扩展的广播调用
				}
			});
		},
	};
}
