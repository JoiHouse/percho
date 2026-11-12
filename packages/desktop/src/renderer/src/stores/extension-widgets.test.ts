import { beforeEach, describe, expect, it } from "vitest";
import { useExtensionWidgetsStore } from "./extension-widgets";

const view = (key: string, lines: string[]) => ({
	key,
	placement: "aboveEditor" as const,
	lines,
	source: "ext",
});

describe("extension widgets store", () => {
	beforeEach(() => useExtensionWidgetsStore.setState({ bySession: {} }));

	it("setWidgets 整体替换，空数组删除会话键", () => {
		const store = useExtensionWidgetsStore.getState();
		store.setWidgets("s1", [view("a", ["1"])]);
		store.setWidgets("s1", [view("b", ["2"])]);
		expect(useExtensionWidgetsStore.getState().bySession.s1?.map((w) => w.key)).toEqual(["b"]);
		store.setWidgets("s1", []);
		expect("s1" in useExtensionWidgetsStore.getState().bySession).toBe(false);
	});

	it("install 只替换所属环境的会话，保留其他环境", () => {
		const store = useExtensionWidgetsStore.getState();
		store.setWidgets("local-1", [view("a", ["x"])]);
		store.setWidgets("remote-1", [view("r", ["y"])]);
		store.install(
			(id) => id.startsWith("local-"),
			[
				{ sessionId: "local-2", widgets: [view("c", ["z"])] },
				{ sessionId: "local-3", widgets: [] },
			],
		);
		expect(Object.keys(useExtensionWidgetsStore.getState().bySession).sort()).toEqual([
			"local-2",
			"remote-1",
		]);
	});
});
