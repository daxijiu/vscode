/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { IDirectorProviderBackendHub, isResolvedBackend } from '../../common/directorProviderBackend.js';
import { IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { DirectorNormalizedToolCall, DirectorNormalizedToolDefinition } from '../../common/directorProviderAdapters.js';
import { normalizeDirectorClientToolDefinitions, validateDirectorToolCallInput } from '../../common/directorToolPolicy.js';
import { AgentSignal, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { MessageAttachment, ModelSelection, ToolCallPendingConfirmationState, ToolDefinition } from '../../common/state/protocol/state.js';
import { ResponsePart, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallResult, ToolCallState, ToolCallStatus, ToolResultContentType, Turn, TurnState, UsageInfo } from '../../common/state/sessionState.js';
import { DirectorAgentEngineAdapter, DirectorAgentToolExecution, stringifyDirectorToolResult } from './directorAgentEngineAdapter.js';

interface IDirectorInFlightTurn {
	readonly turnId: string;
	readonly prompt: string;
	readonly attachments: readonly MessageAttachment[] | undefined;
	readonly responseParts: ResponsePart[];
	readonly abortController: AbortController;
	usage: UsageInfo | undefined;
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	cancelled: boolean;
	terminalEmitted: boolean;
	clientToolsSnapshot: IDirectorClientToolsSnapshot;
}

export type DirectorSessionMode = 'interactive' | 'plan';

interface IDirectorClientToolsSnapshot {
	readonly clientId: string | undefined;
	readonly tools: readonly ToolDefinition[];
	readonly toolNames: ReadonlySet<string>;
}

const CLIENT_TOOL_RESULT_TIMEOUT = 5 * 60 * 1000;

export class DirectorAgentSession extends Disposable {

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _turns: Turn[] = [];
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean>();
	private readonly _pendingToolResults = new PendingRequestRegistry<ToolCallResult>();
	private _inFlight: IDirectorInFlightTurn | undefined;
	private _clientTools: readonly ToolDefinition[] = [];
	private _toolClientId: string | undefined;
	private _modifiedAt: number;

	constructor(
		readonly sessionId: string,
		readonly sessionUri: URI,
		readonly createdAt: number,
		readonly workingDirectory: URI | undefined,
		private _model: ModelSelection | undefined,
		private readonly _readMode: (session: URI) => DirectorSessionMode | undefined,
		@IDirectorProviderBackendHub private readonly _backendHub: IDirectorProviderBackendHub,
		@IDirectorRuntimeCredentialService private readonly _credentialService: IDirectorRuntimeCredentialService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._modifiedAt = createdAt;
	}

	get model(): ModelSelection | undefined {
		return this._model;
	}

	createMetadata(): IAgentSessionMetadata {
		return {
			session: this.sessionUri,
			startTime: this.createdAt,
			modifiedTime: this._modifiedAt,
			...(this.workingDirectory ? { workingDirectory: this.workingDirectory, project: this._project(this.workingDirectory) } : {}),
			...(this._model ? { model: this._model } : {}),
		};
	}

	async send(prompt: string, attachments: readonly MessageAttachment[] | undefined, turnId: string): Promise<void> {
		if (this._inFlight) {
			this.abort();
		}

		const inFlight: IDirectorInFlightTurn = {
			turnId,
			prompt,
			attachments,
			responseParts: [],
			abortController: new AbortController(),
			usage: undefined,
			markdownPartId: undefined,
			reasoningPartId: undefined,
			cancelled: false,
			terminalEmitted: false,
			clientToolsSnapshot: this._captureClientToolsSnapshot(),
		};
		this._inFlight = inFlight;
		this._modifiedAt = Date.now();

		try {
			if (this._readMode(this.sessionUri) === 'plan') {
				this._emitSystemNotification(inFlight, localize('directorAgent.planMode.system', "Director Plan Mode is not implemented in the AgentHost harness yet."));
				this._emitMarkdown(inFlight, localize('directorAgent.planMode.unsupported', "Director Plan Mode is recognized, but this Phase 4 AgentHost harness still gates it off. Switch the session mode back to Interactive to run provider-backed turns."));
				this._complete(inFlight);
				return;
			}

			const resolution = await this._backendHub.resolveBackend(this._model ? { modelId: this._model.id } : undefined);
			if (!isResolvedBackend(resolution)) {
				this._error(inFlight, resolution.message);
				return;
			}

			const adapter = new DirectorAgentEngineAdapter(this._credentialService);
			for await (const event of adapter.runTurn({
				backend: resolution.backend,
				prompt,
				attachments,
				turns: this._turns,
				cwd: this.workingDirectory?.fsPath,
				abortSignal: inFlight.abortController.signal,
				tools: this._normalizedClientTools(inFlight.clientToolsSnapshot),
				executeToolCall: toolCall => this._executeToolCall(inFlight, toolCall),
			})) {
				if (this._isTerminal(inFlight)) {
					return;
				}
				switch (event.type) {
					case 'system':
						this._emitSystemNotification(inFlight, event.message);
						break;
					case 'text':
						this._emitMarkdown(inFlight, event.text);
						break;
					case 'textDelta':
						this._emitMarkdownDelta(inFlight, event.text);
						break;
					case 'thinking':
						this._emitReasoning(inFlight, event.thinking);
						break;
					case 'thinkingDelta':
						this._emitReasoningDelta(inFlight, event.thinking);
						break;
					case 'usage':
						this._emitUsage(inFlight, event.usage);
						break;
					case 'result':
						this._complete(inFlight);
						break;
				}
			}
		} catch (err) {
			if (this._isTerminal(inFlight)) {
				return;
			}
			if (isCancellationError(err) || inFlight.abortController.signal.aborted) {
				this._cancel(inFlight);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this._logService.warn('[Director] AgentEngine turn failed', err);
			this._error(inFlight, message);
		}
	}

	abort(): void {
		const inFlight = this._inFlight;
		if (!inFlight || inFlight.terminalEmitted) {
			return;
		}
		inFlight.cancelled = true;
		inFlight.abortController.abort();
		this._pendingPermissions.denyAll(false);
		this._pendingToolResults.rejectAll(new CancellationError());
		this._cancel(inFlight);
	}

	changeModel(model: ModelSelection): void {
		this._model = model;
		this._modifiedAt = Date.now();
	}

	getTurns(): readonly Turn[] {
		return this._turns.map(turn => ({
			...turn,
			userMessage: {
				...turn.userMessage,
				...(turn.userMessage.attachments ? { attachments: [...turn.userMessage.attachments] } : {}),
			},
			responseParts: [...turn.responseParts],
		}));
	}

	override dispose(): void {
		this.abort();
		super.dispose();
	}

	setClientTools(clientId: string | undefined, tools: readonly ToolDefinition[]): void {
		this._toolClientId = clientId || undefined;
		this._clientTools = [...tools];
	}

	respondToPermissionRequest(requestId: string, approved: boolean): boolean {
		return this._pendingPermissions.respond(requestId, approved);
	}

	completeClientToolCall(toolCallId: string, result: ToolCallResult): boolean {
		this._updateToolPartCompleted(toolCallId, result);
		return this._pendingToolResults.respond(toolCallId, result);
	}

	failClientTools(clientId: string, message: string): void {
		const inFlight = this._inFlight;
		if (!inFlight || inFlight.clientToolsSnapshot.clientId !== clientId) {
			return;
		}
		for (const part of inFlight.responseParts) {
			if (part.kind !== ResponsePartKind.ToolCall || part.toolCall.toolClientId !== clientId) {
				continue;
			}
			if (part.toolCall.status !== ToolCallStatus.Streaming && part.toolCall.status !== ToolCallStatus.Running && part.toolCall.status !== ToolCallStatus.PendingConfirmation) {
				continue;
			}
			const result = failedToolResult(message);
			this._emitToolCallComplete(inFlight, {
				id: part.toolCall.toolCallId,
				name: part.toolCall.toolName,
				input: toolCallInput(part.toolCall),
			}, result);
			this._pendingPermissions.respond(part.toolCall.toolCallId, true);
			this._pendingToolResults.respond(part.toolCall.toolCallId, result);
		}
	}

	private _project(workingDirectory: URI): IAgentSessionProjectInfo {
		return {
			uri: workingDirectory,
			displayName: basename(workingDirectory) || workingDirectory.fsPath || workingDirectory.path,
		};
	}

	private _emitMarkdown(inFlight: IDirectorInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const part = {
			kind: ResponsePartKind.Markdown,
			id: generateUuid(),
			content,
		} satisfies ResponsePart;
		inFlight.responseParts.push(part);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionResponsePart,
				turnId: inFlight.turnId,
				part,
			},
		});
	}

	private _emitMarkdownDelta(inFlight: IDirectorInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight) || !content) {
			return;
		}
		const partId = inFlight.markdownPartId ?? generateUuid();
		if (!inFlight.markdownPartId) {
			inFlight.markdownPartId = partId;
			const part = {
				kind: ResponsePartKind.Markdown,
				id: partId,
				content: '',
			} satisfies ResponsePart;
			inFlight.responseParts.push(part);
			this._onDidSessionProgress.fire({
				kind: 'action',
				session: this.sessionUri,
				action: {
					type: ActionType.SessionResponsePart,
					turnId: inFlight.turnId,
					part: { ...part },
				},
			});
		}
		this._appendMarkdownPart(inFlight, partId, content);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionDelta,
				turnId: inFlight.turnId,
				partId,
				content,
			},
		});
	}

	private _emitReasoning(inFlight: IDirectorInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const part = {
			kind: ResponsePartKind.Reasoning,
			id: generateUuid(),
			content,
		} satisfies ResponsePart;
		inFlight.responseParts.push(part);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionResponsePart,
				turnId: inFlight.turnId,
				part,
			},
		});
	}

	private _emitReasoningDelta(inFlight: IDirectorInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight) || !content) {
			return;
		}
		const partId = inFlight.reasoningPartId ?? generateUuid();
		if (!inFlight.reasoningPartId) {
			inFlight.reasoningPartId = partId;
			const part = {
				kind: ResponsePartKind.Reasoning,
				id: partId,
				content: '',
			} satisfies ResponsePart;
			inFlight.responseParts.push(part);
			this._onDidSessionProgress.fire({
				kind: 'action',
				session: this.sessionUri,
				action: {
					type: ActionType.SessionResponsePart,
					turnId: inFlight.turnId,
					part: { ...part },
				},
			});
		}
		this._appendReasoningPart(inFlight, partId, content);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionReasoning,
				turnId: inFlight.turnId,
				partId,
				content,
			},
		});
	}

	private _emitSystemNotification(inFlight: IDirectorInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const part = {
			kind: ResponsePartKind.SystemNotification,
			content,
		} satisfies ResponsePart;
		inFlight.responseParts.push(part);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionResponsePart,
				turnId: inFlight.turnId,
				part,
			},
		});
	}

	private _emitUsage(inFlight: IDirectorInFlightTurn, usage: UsageInfo): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		inFlight.usage = usage;
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionUsage,
				turnId: inFlight.turnId,
				usage,
			},
		});
	}

	private _complete(inFlight: IDirectorInFlightTurn): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		inFlight.terminalEmitted = true;
		this._turns.push({
			id: inFlight.turnId,
			userMessage: {
				text: inFlight.prompt,
				...(inFlight.attachments ? { attachments: [...inFlight.attachments] } : {}),
			},
			responseParts: [...inFlight.responseParts],
			usage: inFlight.usage,
			state: TurnState.Complete,
		});
		this._modifiedAt = Date.now();
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionTurnComplete,
				turnId: inFlight.turnId,
			},
		});
		if (this._inFlight === inFlight) {
			this._inFlight = undefined;
		}
	}

	private _error(inFlight: IDirectorInFlightTurn, message: string): void {
		if (inFlight.terminalEmitted) {
			return;
		}
		inFlight.terminalEmitted = true;
		this._turns.push({
			id: inFlight.turnId,
			userMessage: {
				text: inFlight.prompt,
				...(inFlight.attachments ? { attachments: [...inFlight.attachments] } : {}),
			},
			responseParts: [...inFlight.responseParts],
			usage: inFlight.usage,
			state: TurnState.Error,
		});
		this._modifiedAt = Date.now();
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionError,
				turnId: inFlight.turnId,
				error: {
					errorType: 'directorAgentEngine',
					message,
				},
			},
		});
		if (this._inFlight === inFlight) {
			this._inFlight = undefined;
		}
	}

	private _cancel(inFlight: IDirectorInFlightTurn): void {
		if (inFlight.terminalEmitted) {
			return;
		}
		inFlight.terminalEmitted = true;
		this._turns.push({
			id: inFlight.turnId,
			userMessage: {
				text: inFlight.prompt,
				...(inFlight.attachments ? { attachments: [...inFlight.attachments] } : {}),
			},
			responseParts: [...inFlight.responseParts],
			usage: inFlight.usage,
			state: TurnState.Cancelled,
		});
		this._modifiedAt = Date.now();
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionTurnCancelled,
				turnId: inFlight.turnId,
			},
		});
		if (this._inFlight === inFlight) {
			this._inFlight = undefined;
		}
	}

	private _isTerminal(inFlight: IDirectorInFlightTurn): boolean {
		return inFlight.terminalEmitted || this._inFlight !== inFlight;
	}

	private _captureClientToolsSnapshot(): IDirectorClientToolsSnapshot {
		const tools = [...normalizeDirectorClientToolDefinitions(this._clientTools)];
		return {
			clientId: this._toolClientId,
			tools,
			toolNames: new Set(tools.map(tool => tool.name)),
		};
	}

	private _normalizedClientTools(snapshot: IDirectorClientToolsSnapshot): readonly DirectorNormalizedToolDefinition[] {
		if (!snapshot.clientId) {
			return [];
		}
		return snapshot.tools.map(tool => ({
			name: tool.name,
			...(tool.title !== undefined ? { title: tool.title } : {}),
			...(tool.description !== undefined ? { description: tool.description } : {}),
			...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
		}));
	}

	private async _executeToolCall(inFlight: IDirectorInFlightTurn, toolCall: DirectorNormalizedToolCall): Promise<DirectorAgentToolExecution> {
		if (this._isTerminal(inFlight)) {
			throw new CancellationError();
		}
		const tool = inFlight.clientToolsSnapshot.tools.find(candidate => candidate.name === toolCall.name);
		if (!tool || !inFlight.clientToolsSnapshot.clientId || !inFlight.clientToolsSnapshot.toolNames.has(toolCall.name)) {
			const result = failedToolResult(`Director tool '${toolCall.name}' is not available in the active AgentHost client.`);
			this._emitToolCallStart(inFlight, toolCall, tool, undefined);
			this._emitToolCallReady(inFlight, toolCall, result.pastTenseMessage.toString(), ToolCallConfirmationReason.NotNeeded, undefined);
			this._emitToolCallComplete(inFlight, toolCall, result);
			return stringifyDirectorToolResult(result);
		}

		const validationError = validateDirectorToolCallInput(toolCall.name, toolCall.input);
		if (validationError) {
			const result = failedToolResult(validationError);
			this._emitToolCallStart(inFlight, toolCall, tool, inFlight.clientToolsSnapshot.clientId);
			this._emitToolCallReady(inFlight, toolCall, result.pastTenseMessage.toString(), ToolCallConfirmationReason.NotNeeded, inFlight.clientToolsSnapshot.clientId);
			this._emitToolCallComplete(inFlight, toolCall, result);
			return stringifyDirectorToolResult(result);
		}

		this._emitToolCallStart(inFlight, toolCall, tool, inFlight.clientToolsSnapshot.clientId);
		const resultPromise = this._pendingToolResults.register(toolCall.id);
		const approved = await this._pendingPermissions.registerAndFire(toolCall.id, () => {
			const state: ToolCallPendingConfirmationState = {
				status: ToolCallStatus.PendingConfirmation,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				displayName: tool.title ?? tool.name,
				toolClientId: inFlight.clientToolsSnapshot.clientId,
				invocationMessage: localize('directorAgent.tool.invocation', "Run {0}", tool.title ?? tool.name),
				toolInput: toolCall.input,
				confirmationTitle: localize('directorAgent.tool.confirmationTitle', "Run Tool"),
				editable: false,
			};
			this._onDidSessionProgress.fire({
				kind: 'pending_confirmation',
				session: this.sessionUri,
				state,
				permissionKind: 'custom-tool',
				permissionPath: toolCall.name,
			});
		});

		if (!approved) {
			const result = failedToolResult(`Director tool '${toolCall.name}' was denied by the user.`);
			this._pendingToolResults.respond(toolCall.id, result);
			this._updateToolPartCancelled(toolCall.id, result.error?.message ?? 'Denied by user');
			return stringifyDirectorToolResult(result);
		}

		const timeout = setTimeout(() => {
			const result = failedToolResult(`Director tool '${toolCall.name}' did not return a result before the timeout.`);
			this._emitToolCallComplete(inFlight, toolCall, result);
			this._pendingToolResults.respond(toolCall.id, result);
		}, CLIENT_TOOL_RESULT_TIMEOUT);
		try {
			const result = await resultPromise;
			clearTimeout(timeout);
			this._updateToolPartCompleted(toolCall.id, result);
			return stringifyDirectorToolResult(result);
		} catch (err) {
			clearTimeout(timeout);
			if (isCancellationError(err)) {
				throw err;
			}
			const result = failedToolResult(err instanceof Error ? err.message : String(err));
			this._updateToolPartCompleted(toolCall.id, result);
			return stringifyDirectorToolResult(result);
		}
	}

	private _emitToolCallStart(inFlight: IDirectorInFlightTurn, toolCall: DirectorNormalizedToolCall, tool: ToolDefinition | undefined, toolClientId: string | undefined): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const displayName = tool?.title ?? toolCall.name;
		const part = {
			kind: ResponsePartKind.ToolCall,
			toolCall: {
				status: ToolCallStatus.Streaming,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				displayName,
				...(toolClientId !== undefined ? { toolClientId } : {}),
				partialInput: toolCall.input,
				invocationMessage: localize('directorAgent.tool.preparing', "Preparing {0}", displayName),
			},
		} satisfies ResponsePart;
		inFlight.responseParts.push(part);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionToolCallStart,
				turnId: inFlight.turnId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				displayName,
				...(toolClientId !== undefined ? { toolClientId } : {}),
			},
		});
		if (toolCall.input) {
			this._onDidSessionProgress.fire({
				kind: 'action',
				session: this.sessionUri,
				action: {
					type: ActionType.SessionToolCallDelta,
					turnId: inFlight.turnId,
					toolCallId: toolCall.id,
					content: toolCall.input,
				},
			});
		}
	}

	private _emitToolCallReady(inFlight: IDirectorInFlightTurn, toolCall: DirectorNormalizedToolCall, invocationMessage: string, confirmed: ToolCallConfirmationReason, toolClientId: string | undefined): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionToolCallReady,
				turnId: inFlight.turnId,
				toolCallId: toolCall.id,
				invocationMessage,
				toolInput: toolCall.input,
				confirmed,
				...(toolClientId !== undefined ? { _meta: { toolClientId } } : {}),
			},
		});
	}

	private _emitToolCallComplete(inFlight: IDirectorInFlightTurn, toolCall: DirectorNormalizedToolCall, result: ToolCallResult): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		this._updateToolPartCompleted(toolCall.id, result);
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action: {
				type: ActionType.SessionToolCallComplete,
				turnId: inFlight.turnId,
				toolCallId: toolCall.id,
				result,
			},
		});
	}

	private _appendMarkdownPart(inFlight: IDirectorInFlightTurn, partId: string, content: string): void {
		const part = inFlight.responseParts.find(part => part.kind === ResponsePartKind.Markdown && part.id === partId);
		if (part?.kind === ResponsePartKind.Markdown) {
			part.content += content;
		}
	}

	private _appendReasoningPart(inFlight: IDirectorInFlightTurn, partId: string, content: string): void {
		const part = inFlight.responseParts.find(part => part.kind === ResponsePartKind.Reasoning && part.id === partId);
		if (part?.kind === ResponsePartKind.Reasoning) {
			part.content += content;
		}
	}

	private _updateToolPartCompleted(toolCallId: string, result: ToolCallResult): void {
		const inFlight = this._inFlight;
		const part = inFlight?.responseParts.find(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId);
		if (part?.kind !== ResponsePartKind.ToolCall) {
			return;
		}
		part.toolCall = {
			...part.toolCall,
			status: ToolCallStatus.Completed,
			invocationMessage: toolCallInvocationMessage(part.toolCall, localize('directorAgent.tool.completed', "Completed {0}", part.toolCall.displayName)),
			toolInput: toolCallInput(part.toolCall) || undefined,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: result.success,
			pastTenseMessage: result.pastTenseMessage,
			...(result.content !== undefined ? { content: result.content } : {}),
			...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
			...(result.error !== undefined ? { error: result.error } : {}),
		};
	}

	private _updateToolPartCancelled(toolCallId: string, reasonMessage: string): void {
		const inFlight = this._inFlight;
		const part = inFlight?.responseParts.find(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId);
		if (part?.kind !== ResponsePartKind.ToolCall) {
			return;
		}
		part.toolCall = {
			...part.toolCall,
			status: ToolCallStatus.Cancelled,
			invocationMessage: toolCallInvocationMessage(part.toolCall, localize('directorAgent.tool.cancelled', "Cancelled {0}", part.toolCall.displayName)),
			toolInput: toolCallInput(part.toolCall) || undefined,
			reason: ToolCallCancellationReason.Denied,
			reasonMessage,
		};
	}
}

function failedToolResult(message: string): ToolCallResult {
	return {
		success: false,
		pastTenseMessage: message,
		content: [{ type: ToolResultContentType.Text, text: message }],
		error: { message },
	};
}

function toolCallInput(toolCall: ToolCallState): string {
	if (toolCall.status === ToolCallStatus.Streaming) {
		return toolCall.partialInput ?? '';
	}
	return toolCall.toolInput ?? '';
}

function toolCallInvocationMessage(toolCall: ToolCallState, fallback: string) {
	return toolCall.invocationMessage || fallback;
}
