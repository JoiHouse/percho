import type { SubagentRunUi } from "@percho/shared";
import { PERCHO_SUBAGENT_RUNS_CHANNEL } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import {
	EXTERNAL_RUNS_LIMIT,
	ExternalSubagentRuns,
	makeExternalSubagentBridgeExtension,
	parseExternalMessage,
} from "../src/session/external-subagents";

function fakeSession(id: string) {
	const listeners = new Set<(event: unknown) => void>();
	return {
		sessionId: id,
		sessionFile: `/agent/sessions-subagents/p/${id}.jsonl`,
		subscribe: vi.fn((listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		sessionManager: { getBranch: () => [{ id: "e1" }] },
		abort: vi.fn(async () => {}),
		emit: (event: unknown) => {
			for (const listener of listeners) listener(event);
		},
		listenerCount: () => listeners.size,
	};
}

function setup(alive = true) {
	const registered = new Map<string, unknown>();
	const published: Array<{ sessionId: string; runs: SubagentRunUi[] }> = [];
	const events: Array<[string, unknown]> = [];
	const deps = {
		isParentAlive: vi.fn(() => alive),
		registerRun: vi.fn((id: string, handle: unknown) => registered.set(id, handle)),
		unregisterRun: vi.fn((id: string) => registered.delete(id)),
		onEvent: vi.fn((id: string, event: unknown) => events.push([id, event])),
		publish: vi.fn((sessionId: string, runs: SubagentRunUi[]) => published.push({ sessionId, runs })),
	};
	const runs = new ExternalSubagentRuns(deps as never);
	return { runs, deps, registered, published, events };
}

const run = (extra: Record<string, unknown> = {}) => ({
	v: 1,
	type: "run",
	parentSessionId: "parent",
	runId: "r1",
	agent: "executor 1",
	status: "running",
	...extra,
});

describe("parseExternalMessage", () => {
	it("拒绝版本不符、缺字段、未知状态", () => {
		expect(parseExternalMessage(null)).toBeUndefined();
		expect(parseExternalMessage({ ...run(), v: 2 })).toBeUndefined();
		expect(parseExternalMessage({ ...run(), runId: "" })).toBeUndefined();
		expect(parseExternalMessage({ ...run(), status: "weird" })).toBeUndefined();
		expect(parseExternalMessage({ ...run(), type: "other" })).toBeUndefined();
	});

	it("非法 session 对象被丢弃，其余字段保留", () => {
		const msg = parseExternalMessage(run({ session: { sessionId: "x" }, tokens: 12.7, task: "  " }));
		expect(msg).toMatchObject({ type: "run", agent: "executor 1", tokens: 12 });
		expect(msg && "session" in msg ? msg.session : "none").toBeUndefined();
		expect(msg && "task" in msg ? msg.task : "none").toBeUndefined();
	});
});

describe("ExternalSubagentRuns", () => {
	it("活会话登记为可检视子代理，事件转发，结束后注销但保留行和会话文件", () => {
		const { runs, registered, published, events } = setup();
		const session = fakeSession("child-1");
		runs.handle(run({ session, task: "Task-1", model: "p/m", tokens: 10 }));
		expect(registered.has("child-1")).toBe(true);
		expect(published.at(-1)).toEqual({
			sessionId: "parent",
			runs: [
				{
					key: "ext:r1",
					agent: "executor 1",
					status: "running",
					task: "Task-1",
					model: "p/m",
					tokens: 10,
					sessionFile: "/agent/sessions-subagents/p/child-1.jsonl",
				},
			],
		});
		session.emit({ type: "message_end" });
		expect(events).toEqual([["child-1", { type: "message_end" }]]);

		runs.handle(run({ status: "done", tokens: 99 }));
		expect(registered.has("child-1")).toBe(false);
		expect(session.listenerCount()).toBe(0);
		expect(published.at(-1)?.runs[0]).toMatchObject({ status: "done", exitCode: 0, tokens: 99 });
		expect(published.at(-1)?.runs[0]?.sessionFile).toBe("/agent/sessions-subagents/p/child-1.jsonl");
	});

	it("登记句柄的 abort 优先用扩展提供的 abort，dispose 不销毁扩展会话", async () => {
		const { runs, registered } = setup();
		const session = fakeSession("child-2");
		const abort = vi.fn();
		runs.handle(run({ session, abort }));
		const handle = registered.get("child-2") as { abort: () => Promise<void>; dispose: () => void };
		await handle.abort();
		expect(abort).toHaveBeenCalledOnce();
		expect(session.abort).not.toHaveBeenCalled();
		handle.dispose();
		expect(session.listenerCount()).toBe(1);
	});

	it("queued 无会话时只显示行；会话随后出现再登记", () => {
		const { runs, registered, published } = setup();
		runs.handle(run({ status: "queued" }));
		expect(published.at(-1)?.runs[0]).toMatchObject({ status: "queued" });
		expect(registered.size).toBe(0);
		runs.handle(run({ status: "running", session: fakeSession("late") }));
		expect(registered.has("late")).toBe(true);
	});

	it("failed 映射为 error，remove 删除行并注销", () => {
		const { runs, registered, published } = setup();
		runs.handle(run({ session: fakeSession("c") }));
		runs.handle(run({ status: "failed", error: "boom" }));
		expect(published.at(-1)?.runs[0]).toMatchObject({ status: "error", exitCode: 1 });
		runs.handle(run({ runId: "r2", session: fakeSession("d") }));
		runs.handle({ v: 1, type: "remove", parentSessionId: "parent", runId: "r2" });
		expect(registered.has("d")).toBe(false);
		expect(published.at(-1)?.runs.map((r) => r.key)).toEqual(["ext:r1"]);
	});

	it("父会话不在时忽略消息", () => {
		const { runs, registered, published } = setup(false);
		runs.handle(run({ session: fakeSession("x") }));
		expect(registered.size).toBe(0);
		expect(published).toHaveLength(0);
	});

	it("登记失败不影响行展示", () => {
		const { runs, deps, published } = setup();
		deps.registerRun.mockImplementation(() => {
			throw new Error("deleting");
		});
		runs.handle(run({ session: fakeSession("x") }));
		expect(published.at(-1)?.runs).toHaveLength(1);
	});

	it("disposeParent 注销全部并推空快照；超限淘汰最早结束的行", () => {
		const { runs, registered, published } = setup();
		for (let i = 0; i < EXTERNAL_RUNS_LIMIT; i++) runs.handle(run({ runId: `done-${i}`, status: "done" }));
		runs.handle(run({ runId: "live", session: fakeSession("live") }));
		const keys = published.at(-1)?.runs.map((r) => r.key) ?? [];
		expect(keys).toHaveLength(EXTERNAL_RUNS_LIMIT);
		expect(keys).not.toContain("ext:done-0");
		expect(keys).toContain("ext:live");
		runs.disposeParent("parent");
		expect(registered.size).toBe(0);
		expect(published.at(-1)).toEqual({ sessionId: "parent", runs: [] });
		expect(runs.parentIds()).toEqual([]);
	});
});

describe("makeExternalSubagentBridgeExtension", () => {
	it("只收听协议频道，处理异常不外抛", () => {
		const handlers = new Map<string, (data: unknown) => void>();
		const pi = {
			events: { on: (channel: string, handler: (data: unknown) => void) => handlers.set(channel, handler) },
		};
		const onMessage = vi.fn(() => {
			throw new Error("host failed");
		});
		makeExternalSubagentBridgeExtension(onMessage).factory(pi as never);
		expect([...handlers.keys()]).toEqual([PERCHO_SUBAGENT_RUNS_CHANNEL]);
		expect(() => handlers.get(PERCHO_SUBAGENT_RUNS_CHANNEL)?.({ v: 1 })).not.toThrow();
		expect(onMessage).toHaveBeenCalledWith({ v: 1 });
	});
});
