import type { SubagentRunUi } from "@percho/shared";
import { memo, useState } from "react";
import { useT } from "../../i18n";
import { withSessionSlide } from "../../lib/session-page-slide";
import { useSessionExtensionRuns } from "../../stores/extension-widgets";
import { useSessionsStore } from "../../stores/sessions";
import { ChevronDownIcon } from "../icons";

const STATUS_KEYS = {
	running: "message.subagent.running",
	queued: "message.subagent.queued",
	done: "message.subagent.done",
	error: "message.subagent.failed",
	aborted: "message.subagent.aborted",
} as const;

/**
 * 扩展子代理运行面板（percho:subagent-runs 协议）：输入区上方列出扩展登记的子会话，
 * 状态点沿用内置子代理卡样式；有会话文件即可点击进入只读检视页（运行中为实时视图）。
 */
export const ExtensionSubagentRunsPanel = memo(function ExtensionSubagentRunsPanel({
	sessionId,
}: {
	sessionId: string | null;
}) {
	const t = useT();
	const runs = useSessionExtensionRuns(sessionId);
	const [collapsed, setCollapsed] = useState(false);
	if (!runs.length) return null;
	const active = runs.filter((run) => run.status === "running" || run.status === "queued").length;
	const label = collapsed ? t("message.extensionRuns.expand") : t("message.extensionRuns.collapse");
	return (
		<div className="shrink-0 px-6 pb-2">
			<section className="relative mx-auto max-w-[760px] rounded-lg border border-border bg-surface shadow-soft">
				<button
					type="button"
					onClick={() => setCollapsed((value) => !value)}
					aria-expanded={!collapsed}
					aria-label={label}
					title={label}
					className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-ui-11 text-ink-dim transition-colors hover:bg-hover motion-reduce:transition-none"
				>
					<span>{t("message.extensionRuns.title")}</span>
					<span className="text-ink-faint">
						{t("message.extensionRuns.count", { active, total: runs.length })}
					</span>
					<ChevronDownIcon
						size={12}
						className={`ml-auto shrink-0 transition-transform duration-150 motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`}
					/>
				</button>
				{!collapsed && (
					<div className="max-h-56 overflow-auto px-1 pb-1.5">
						{runs.map((run) => (
							<RunRow key={run.key} run={run} />
						))}
					</div>
				)}
			</section>
		</div>
	);
});

function RunRow({ run }: { run: SubagentRunUi }) {
	const t = useT();
	const openSubagentSession = useSessionsStore((s) => s.openSubagentSession);
	const clickable = run.sessionFile != null;
	const statusLabel = t(STATUS_KEYS[run.status]);
	const meta = [run.model, run.tokens ? `${formatTokens(run.tokens)} tok` : undefined]
		.filter(Boolean)
		.join(" · ");
	return (
		<button
			type="button"
			disabled={!clickable}
			onClick={() => {
				if (!run.sessionFile) return;
				void withSessionSlide("push", () => openSubagentSession(run.sessionFile as string));
			}}
			className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors motion-reduce:transition-none ${
				clickable ? "cursor-pointer hover:bg-hover" : "cursor-default"
			}`}
		>
			<span className="subagent-slot shrink-0">
				<span
					className="subagent-cap"
					data-state={run.status}
					role="img"
					aria-label={statusLabel}
					title={`${run.agent} · ${statusLabel}`}
				>
					<span className="subagent-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
				</span>
			</span>
			<span className="shrink-0 text-ui-12 font-semibold text-ink">{run.agent}</span>
			{run.task && <span className="min-w-0 truncate text-ui-12 text-ink-dim">{run.task}</span>}
			{meta && <span className="ml-auto shrink-0 font-mono text-ui-11 text-ink-faint">{meta}</span>}
		</button>
	);
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}
