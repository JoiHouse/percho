import type { ExtensionWidgetPlacement, ExtensionWidgetView } from "@percho/shared";
import { memo, useState } from "react";
import { useT } from "../../i18n";
import { useSessionWidgets } from "../../stores/extension-widgets";
import { ChevronDownIcon } from "../icons";

/**
 * 扩展 setWidget 的 GUI 展示：输入框上方/下方的等宽纯文本面板（与 Composer 同宽）。
 * 内容为扩展提供的非受信文本，纯文本渲染；每个 widget 可单独折叠（折叠态只在本组件内存）。
 */
export const ExtensionWidgetPanel = memo(function ExtensionWidgetPanel({
	sessionId,
	placement,
}: {
	sessionId: string | null;
	placement: ExtensionWidgetPlacement;
}) {
	const all = useSessionWidgets(sessionId);
	const widgets = all.filter((widget) => widget.placement === placement);
	if (!widgets.length) return null;
	return (
		<div className={placement === "aboveEditor" ? "shrink-0 px-6 pb-2" : "shrink-0 px-6 pb-3"}>
			<div className="relative mx-auto flex max-w-[760px] flex-col gap-1.5">
				{widgets.map((widget) => (
					<WidgetBlock key={widget.key} widget={widget} />
				))}
			</div>
		</div>
	);
});

function WidgetBlock({ widget }: { widget: ExtensionWidgetView }) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(false);
	const title = widget.source || widget.key;
	const label = collapsed ? t("message.extensionWidget.expand") : t("message.extensionWidget.collapse");
	return (
		<section
			className="rounded-lg border border-border bg-surface shadow-soft"
			data-extension-widget={widget.key}
		>
			<button
				type="button"
				onClick={() => setCollapsed((value) => !value)}
				aria-expanded={!collapsed}
				aria-label={label}
				title={label}
				className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-ui-11 text-ink-dim transition-colors hover:bg-hover motion-reduce:transition-none"
			>
				<span className="truncate font-mono">{title}</span>
				{collapsed && <span className="truncate text-ink-faint">{widget.lines[0]}</span>}
				<ChevronDownIcon
					size={12}
					className={`ml-auto shrink-0 transition-transform duration-150 motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`}
				/>
			</button>
			{!collapsed && (
				<pre className="max-h-64 overflow-auto px-2.5 pb-2 font-mono text-ui-11 leading-relaxed whitespace-pre text-ink select-text">
					{widget.lines.join("\n")}
				</pre>
			)}
		</section>
	);
}
