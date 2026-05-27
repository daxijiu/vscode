/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const AcpProtocolVersion = 1;

export const enum AcpMethod {
	Initialize = 'initialize',
	Authenticate = 'authenticate',
	SessionNew = 'session/new',
	SessionPrompt = 'session/prompt',
	SessionCancel = 'session/cancel',
	SessionUpdate = 'session/update',
}

export type AcpJsonRpcId = number | string;
export type AcpJsonValue = null | boolean | number | string | readonly AcpJsonValue[] | { readonly [key: string]: AcpJsonValue | undefined };
export type AcpJsonObject = { readonly [key: string]: AcpJsonValue | undefined };

export interface AcpJsonRpcRequest<TParams extends AcpJsonValue = AcpJsonValue> {
	readonly jsonrpc: '2.0';
	readonly id: AcpJsonRpcId;
	readonly method: string;
	readonly params?: TParams;
}

export interface AcpJsonRpcNotification<TParams extends AcpJsonValue = AcpJsonValue> {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: TParams;
}

export interface AcpJsonRpcResponse<TResult extends AcpJsonValue = AcpJsonValue> {
	readonly jsonrpc: '2.0';
	readonly id: AcpJsonRpcId;
	readonly result?: TResult;
	readonly error?: AcpJsonRpcError;
}

export interface AcpJsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: AcpJsonValue;
}

export const enum AcpJsonRpcErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
	AuthRequired = -32000,
	ResourceNotFound = -32002,
}

export interface AcpImplementation extends AcpJsonObject {
	readonly name: string;
	readonly title?: string;
	readonly version: string;
	readonly _meta?: AcpJsonObject;
}

export interface AcpClientCapabilities extends AcpJsonObject {
}

export interface AcpAgentCapabilities extends AcpJsonObject {
}

export interface AcpAuthMethod extends AcpJsonObject {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AcpInitializeParams extends AcpJsonObject {
	readonly protocolVersion: typeof AcpProtocolVersion;
	readonly clientCapabilities: AcpClientCapabilities;
	readonly clientInfo?: AcpImplementation;
	readonly _meta?: AcpJsonObject;
}

export interface AcpInitializeResult extends AcpJsonObject {
	readonly protocolVersion: number;
	readonly agentCapabilities?: AcpAgentCapabilities;
	readonly authMethods?: readonly AcpAuthMethod[];
	readonly agentInfo?: AcpImplementation;
	readonly _meta?: AcpJsonObject;
}

export interface AcpAuthenticateParams extends AcpJsonObject {
	readonly methodId: string;
}

export interface AcpAuthenticateResult extends AcpJsonObject {
	readonly authenticated?: boolean;
	readonly _meta?: AcpJsonObject;
}

export interface AcpNewSessionParams extends AcpJsonObject {
	readonly cwd: string;
	readonly mcpServers: readonly AcpJsonObject[];
}

export interface AcpNewSessionResult extends AcpJsonObject {
	readonly sessionId: string;
}

export interface AcpTextContentBlock extends AcpJsonObject {
	readonly type: 'text';
	readonly text: string;
}

export type AcpContentBlock = AcpTextContentBlock | AcpJsonObject;

export interface AcpPromptParams extends AcpJsonObject {
	readonly sessionId: string;
	readonly prompt: readonly AcpContentBlock[];
}

export const enum AcpStopReason {
	EndTurn = 'end_turn',
	MaxTokens = 'max_tokens',
	MaxTurnRequests = 'max_turn_requests',
	Refusal = 'refusal',
	Cancelled = 'cancelled',
}

export interface AcpPromptResult extends AcpJsonObject {
	readonly stopReason: AcpStopReason | string;
}

export interface AcpCancelSessionParams extends AcpJsonObject {
	readonly sessionId: string;
}

export interface AcpSessionNotificationParams extends AcpJsonObject {
	readonly sessionId: string;
	readonly update: AcpSessionUpdate;
}

export type AcpSessionUpdate =
	| AcpContentChunkUpdate
	| AcpToolCallUpdate
	| AcpSessionInfoUpdate
	| AcpUsageUpdate
	| AcpJsonObject;

export interface AcpContentChunkUpdate extends AcpJsonObject {
	readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
	readonly content: AcpContentBlock;
}

export interface AcpToolCallUpdate extends AcpJsonObject {
	readonly sessionUpdate: 'tool_call' | 'tool_call_update';
	readonly toolCallId?: string;
	readonly title?: string;
	readonly status?: string;
}

export interface AcpSessionInfoUpdate extends AcpJsonObject {
	readonly sessionUpdate: 'session_info_update';
	readonly title?: string | null;
	readonly updatedAt?: string | null;
}

export interface AcpUsageUpdate extends AcpJsonObject {
	readonly sessionUpdate: 'usage_update';
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly thoughtTokens?: number;
	readonly thought_tokens?: number;
}
