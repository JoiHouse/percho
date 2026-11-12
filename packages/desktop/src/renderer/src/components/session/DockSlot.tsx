import { useTranscriptStore } from "../../stores/transcript";
import { Composer } from "../composer/Composer";
import { ApprovalDock } from "./ApprovalDock";
import { ExtensionSubagentRunsPanel } from "./ExtensionSubagentRunsPanel";
import { ExtensionWidgetPanel } from "./ExtensionWidgetPanel";
import { InteractionDock } from "./InteractionDock";

/**
 * 底部交换槽仲裁（D6）：权限审批 > 扩展对话框 > Composer。
 * 三者同位互换——agent 阻塞等答时发消息无意义；两种卡各自内部处理排队与退出动画，
 * 未上场的卡停在 store 队列里，前者应答后自动顶上。
 */
export function DockSlot({ sessionId, hideComposer }: { sessionId: string | null; hideComposer: boolean }) {
	// selector 返回引用/undefined（原始稳定），不订阅整条 transcript 防流式 delta 级联重渲染
	const permission = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingPermissions[0] : undefined,
	);
	const dialog = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingDialogs[0] : undefined,
	);
	if (hideComposer && !permission && !dialog) return null;
	// 扩展 widget（setWidget）跟随输入区：审批/对话框上场时仍保留，便于对照面板作答
	return (
		<>
			<ExtensionSubagentRunsPanel sessionId={sessionId} />
			<ExtensionWidgetPanel sessionId={sessionId} placement="aboveEditor" />
			{permission ? (
				<ApprovalDock sessionId={sessionId} />
			) : dialog ? (
				<InteractionDock sessionId={sessionId} />
			) : (
				// relative z-20：× 删除键 -top-1.5 伸出容器顶 → 落入消息区，须盖过 MessageList 的 z-10
				<div className="approval-composer-enter relative z-20">
					<Composer />
				</div>
			)}
			<ExtensionWidgetPanel sessionId={sessionId} placement="belowEditor" />
		</>
	);
}
