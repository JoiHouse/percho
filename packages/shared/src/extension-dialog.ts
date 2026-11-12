/**
 * 扩展对话框 / 通知 / 草稿预填跨进程契约（issue #45）。
 *
 * 链路：扩展 ctx.ui.* → backend ExtensionDialogHost（本会话队列 + timeout/signal 裁决）
 * → IPC 事件 → renderer 停靠槽（InteractionDock）→ respond IPC → host resolve。
 * 语义基准 = pi 官方 RPC 模式降级表（spec extension-dialogs D3/D9）。
 */

/** 对话框四件套（第三方扩展；内置权限扩展 confirm 走 PermissionGate 直通道，不经此契约） */
export type ExtensionDialogKind = "select" | "input" | "editor" | "confirm";

/** main → renderer：待应答对话框（卡片渲染数据源；内容为插件提供的非受信文本，renderer 纯文本渲染） */
export interface ExtensionDialogRequest {
	revision?: number;
	/** 不可复用的请求身份（包括服务重启及会话重开） */
	id: string;
	sessionId: string;
	/** Source directory, including dialogs raised before session registration completes. */
	cwd?: string;
	kind: ExtensionDialogKind;
	/** 插件原文，宿主不改写 */
	title: string;
	/** confirm 正文 */
	message?: string;
	/** select 选项 */
	options?: string[];
	/** input 占位 */
	placeholder?: string;
	/** editor 预填 */
	prefill?: string;
	/** opts.timeout 透传；倒计时由 backend 裁决（D4），renderer 只显示剩余秒 */
	timeoutMs?: number;
	/** Date.now()；renderer 倒计时显示基准 */
	requestedAt: number;
}

/** renderer → main 的应答载荷（kind 由 host 按请求自身判定，无判别字段） */
export type ExtensionDialogRespond = { value: string } | { confirmed: boolean } | { cancelled: true };

/** main → renderer：对话框已结算（应答/超时/中止/会话关闭都会广播，renderer 撤卡） */
export interface ExtensionDialogResolved {
	revision?: number;
	sessionId: string;
	requestId: string;
	/** answered=用户现场作答（含主动取消）；其余为系统裁决 */
	reason: "answered" | "timeout" | "aborted" | "sessionClosed";
}

/** main → renderer：扩展 notify → 全局 Toast（GUI-only，LAN 不覆盖） */
export interface ExtensionNotifyEvent {
	sessionId: string;
	/** 来源扩展名（stack 启发式归因，可能为空串——uiContext 是会话级共享单例，见 ui-context.ts） */
	extensionPath: string;
	message: string;
	level: "info" | "warning" | "error";
}

/** main → renderer：setEditorText/pasteToEditor → Composer 草稿预填 */
export interface ExtensionEditorTextEvent {
	sessionId: string;
	text: string;
	/** 一次性来源提示（首次键入清除）；空串 = 无来源不提示 */
	source?: string;
}

/** 扩展 widget 位置（SDK WidgetPlacement 同值） */
export type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

/** 单个扩展 widget 的 GUI 投影：backend 渲染为纯文本行（ANSI 已剥离），renderer 等宽纯文本展示 */
export interface ExtensionWidgetView {
	key: string;
	placement: ExtensionWidgetPlacement;
	lines: string[];
	/** 来源扩展名（stack 启发式归因，可能为空串） */
	source: string;
}

/** main → renderer：某会话 widget 全量快照（整体替换；空数组 = 该会话无 widget） */
export interface ExtensionWidgetsEvent {
	sessionId: string;
	widgets: ExtensionWidgetView[];
}

/**
 * 扩展子代理运行登记协议（Percho 私有）：扩展经 `pi.events.emit(PERCHO_SUBAGENT_RUNS_CHANNEL, msg)`
 * 广播自己创建的子会话，Percho 在父会话输入区上方展示运行行，并把活会话登记为可实时检视的子代理。
 * 宿主进程设置环境变量 `PERCHO_SUBAGENT_RUNS_ENV=1` 声明支持（扩展据此决定是否落盘子会话）。
 */
export const PERCHO_SUBAGENT_RUNS_CHANNEL = "percho:subagent-runs";
export const PERCHO_SUBAGENT_RUNS_ENV = "PERCHO_SUBAGENT_RUNS";
export const PERCHO_SUBAGENT_RUNS_VERSION = 1;

/** main → renderer：某父会话的扩展子代理运行全量快照（空数组 = 无） */
export interface ExtensionSubagentRunsEvent {
	sessionId: string;
	runs: import("./transcript/types").SubagentRunUi[];
}
