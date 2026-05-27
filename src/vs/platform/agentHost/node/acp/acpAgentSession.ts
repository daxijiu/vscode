/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AgentSignal, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import { ActionType, SessionAction } from '../../common/state/sessionActions.js';
import { MessageAttachment, ResponsePart, ResponsePartKind, Turn, TurnState, UsageInfo } from '../../common/state/protocol/state.js';
import { AcpErrorCode, isAcpError } from './acpErrors.js';
import { AcpProcess } from './acpProcess.js';
import { AcpMethod, AcpPromptResult, AcpSessionNotificationParams, AcpStopReason } from './acpProtocol.js';
import { mapAcpSessionUpdate } from './acpSessionUpdateMapper.js';

interface AcpInFlightTurn {
	readonly turnId: string;
	readonly prompt: string;
	readonly attachments: readonly MessageAttachment[] | undefined;
	readonly responseParts: ResponsePart[];
	readonly done: Promise<void>;
	readonly finish: () => void;
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	usage: UsageInfo | undefined;
	terminalEmitted: boolean;
}

export class AcpAgentSession extends Disposable {

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _turns: Turn[] = [];
	private _inFlight: AcpInFlightTurn | undefined;
	private _title: string | undefined;
	private _modifiedAt: number;

	constructor(
		readonly acpSessionId: string,
		readonly sessionUri: URI,
		readonly createdAt: number,
		readonly workingDirectory: URI | undefined,
		private readonly _vendorLabel: string,
		private readonly _process: AcpProcess,
	) {
		super();
		this._modifiedAt = createdAt;
		this._register(this._process);
		this._register(this._process.onDidNotification(notification => {
			if (notification.method !== AcpMethod.SessionUpdate) {
				return;
			}
			this._handleSessionUpdate(notification.params as AcpSessionNotificationParams);
		}));
	}

	createMetadata(): IAgentSessionMetadata {
		return {
			session: this.sessionUri,
			startTime: this.createdAt,
			modifiedTime: this._modifiedAt,
			...(this._title ? { summary: this._title } : {}),
			...(this.workingDirectory ? { workingDirectory: this.workingDirectory, project: this._project(this.workingDirectory) } : {}),
		};
	}

	async send(prompt: string, attachments: readonly MessageAttachment[] | undefined, turnId: string): Promise<void> {
		if (this._inFlight) {
			await this.abort();
		}

		const inFlight = this._createInFlightTurn(prompt, attachments, turnId);
		this._inFlight = inFlight;
		this._modifiedAt = Date.now();

		if (attachments?.length) {
			this._error(inFlight, localize('acpAgent.attachmentsUnsupported', "External ACP agents currently support text-only prompts in this milestone."));
			return;
		}

		const promptPromise = this._process.prompt({
			sessionId: this.acpSessionId,
			prompt: [{ type: 'text', text: prompt }],
		}).then(
			result => this._applyPromptResult(inFlight, result),
			err => this._handlePromptError(inFlight, err),
		);

		await Promise.race([promptPromise, inFlight.done]);
	}

	async abort(): Promise<void> {
		const inFlight = this._inFlight;
		if (!inFlight || inFlight.terminalEmitted) {
			return;
		}
		try {
			await this._process.cancel(this.acpSessionId);
		} catch {
			// The user-visible terminal state is cancellation; process exit races are absorbed.
		}
		this._cancel(inFlight);
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
		if (this._inFlight && !this._inFlight.terminalEmitted) {
			this._cancel(this._inFlight);
		}
		super.dispose();
	}

	private _createInFlightTurn(prompt: string, attachments: readonly MessageAttachment[] | undefined, turnId: string): AcpInFlightTurn {
		let finish: () => void = () => { };
		const done = new Promise<void>(resolve => {
			finish = resolve;
		});
		return {
			turnId,
			prompt,
			attachments,
			responseParts: [],
			done,
			finish,
			markdownPartId: undefined,
			reasoningPartId: undefined,
			usage: undefined,
			terminalEmitted: false,
		};
	}

	private _handleSessionUpdate(params: AcpSessionNotificationParams): void {
		const inFlight = this._inFlight;
		if (!inFlight || inFlight.terminalEmitted || params.sessionId !== this.acpSessionId) {
			return;
		}
		const mapped = mapAcpSessionUpdate(params.update);
		switch (mapped.kind) {
			case 'text':
				this._emitMarkdownDelta(inFlight, mapped.text);
				break;
			case 'reasoning':
				this._emitReasoningDelta(inFlight, mapped.text);
				break;
			case 'usage':
				this._emitUsage(inFlight, mapped.usage);
				break;
			case 'metadata':
				if (mapped.title !== undefined) {
					this._title = mapped.title;
					this._emitTitleChanged(mapped.title);
				}
				if (mapped.updatedAt !== undefined && !Number.isNaN(mapped.updatedAt)) {
					this._modifiedAt = mapped.updatedAt;
				}
				break;
			case 'unsupported':
				this._emitSystemNotification(inFlight, mapped.message);
				this._error(inFlight, mapped.message);
				void this._process.cancel(this.acpSessionId).catch(() => { });
				break;
			case 'ignored':
				break;
		}
	}

	private _applyPromptResult(inFlight: AcpInFlightTurn, result: AcpPromptResult): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		switch (result.stopReason) {
			case AcpStopReason.EndTurn:
			case AcpStopReason.MaxTokens:
			case AcpStopReason.MaxTurnRequests:
				this._complete(inFlight);
				break;
			case AcpStopReason.Cancelled:
				this._cancel(inFlight);
				break;
			case AcpStopReason.Refusal:
				this._error(inFlight, localize('acpAgent.refusal', "The ACP agent refused to continue this turn."));
				break;
			default:
				this._error(inFlight, localize('acpAgent.unknownStopReason', "The ACP agent stopped with unsupported reason '{0}'.", result.stopReason));
				break;
		}
	}

	private _handlePromptError(inFlight: AcpInFlightTurn, err: unknown): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		this._error(inFlight, toAcpUserMessage(err, this._vendorLabel));
	}

	private _project(workingDirectory: URI): IAgentSessionProjectInfo {
		return {
			uri: workingDirectory,
			displayName: basename(workingDirectory) || workingDirectory.fsPath || workingDirectory.path,
		};
	}

	private _emitMarkdownDelta(inFlight: AcpInFlightTurn, content: string): void {
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
			this._emitAction({
				type: ActionType.SessionResponsePart,
				turnId: inFlight.turnId,
				part: { ...part },
			});
		}
		const part = inFlight.responseParts.find(part => part.kind === ResponsePartKind.Markdown && part.id === partId);
		if (part?.kind === ResponsePartKind.Markdown) {
			part.content += content;
		}
		this._emitAction({
			type: ActionType.SessionDelta,
			turnId: inFlight.turnId,
			partId,
			content,
		});
	}

	private _emitReasoningDelta(inFlight: AcpInFlightTurn, content: string): void {
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
			this._emitAction({
				type: ActionType.SessionResponsePart,
				turnId: inFlight.turnId,
				part: { ...part },
			});
		}
		const part = inFlight.responseParts.find(part => part.kind === ResponsePartKind.Reasoning && part.id === partId);
		if (part?.kind === ResponsePartKind.Reasoning) {
			part.content += content;
		}
		this._emitAction({
			type: ActionType.SessionReasoning,
			turnId: inFlight.turnId,
			partId,
			content,
		});
	}

	private _emitSystemNotification(inFlight: AcpInFlightTurn, content: string): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const part = {
			kind: ResponsePartKind.SystemNotification,
			content,
		} satisfies ResponsePart;
		inFlight.responseParts.push(part);
		this._emitAction({
			type: ActionType.SessionResponsePart,
			turnId: inFlight.turnId,
			part,
		});
	}

	private _emitUsage(inFlight: AcpInFlightTurn, usage: UsageInfo): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		inFlight.usage = usage;
		this._emitAction({
			type: ActionType.SessionUsage,
			turnId: inFlight.turnId,
			usage,
		});
	}

	private _emitTitleChanged(title: string): void {
		this._emitAction({
			type: ActionType.SessionTitleChanged,
			title,
		});
	}

	private _complete(inFlight: AcpInFlightTurn): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		this._pushTurn(inFlight, TurnState.Complete);
		this._emitAction({
			type: ActionType.SessionTurnComplete,
			turnId: inFlight.turnId,
		});
		this._finish(inFlight);
	}

	private _cancel(inFlight: AcpInFlightTurn): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		this._pushTurn(inFlight, TurnState.Cancelled);
		this._emitAction({
			type: ActionType.SessionTurnCancelled,
			turnId: inFlight.turnId,
		});
		this._finish(inFlight);
	}

	private _error(inFlight: AcpInFlightTurn, message: string): void {
		if (this._isTerminal(inFlight)) {
			return;
		}
		const error = {
			errorType: 'acpAgent',
			message,
		};
		this._pushTurn(inFlight, TurnState.Error, error);
		this._emitAction({
			type: ActionType.SessionError,
			turnId: inFlight.turnId,
			error,
		});
		this._finish(inFlight);
	}

	private _pushTurn(inFlight: AcpInFlightTurn, state: TurnState, error?: { readonly errorType: string; readonly message: string }): void {
		inFlight.terminalEmitted = true;
		this._turns.push({
			id: inFlight.turnId,
			userMessage: {
				text: inFlight.prompt,
				...(inFlight.attachments ? { attachments: [...inFlight.attachments] } : {}),
			},
			responseParts: [...inFlight.responseParts],
			usage: inFlight.usage,
			state,
			...(error ? { error } : {}),
		});
		this._modifiedAt = Date.now();
	}

	private _finish(inFlight: AcpInFlightTurn): void {
		if (this._inFlight === inFlight) {
			this._inFlight = undefined;
		}
		inFlight.finish();
	}

	private _isTerminal(inFlight: AcpInFlightTurn): boolean {
		return inFlight.terminalEmitted || this._inFlight !== inFlight;
	}

	private _emitAction(action: SessionAction): void {
		this._onDidSessionProgress.fire({
			kind: 'action',
			session: this.sessionUri,
			action,
		});
	}
}

export function toAcpUserMessage(err: unknown, vendorLabel: string): string {
	if (isAcpError(err) && err.acpCode === AcpErrorCode.AuthRequired) {
		return localize('acpAgent.authRequired', "Please sign in with {0} in its CLI/app, then retry.", vendorLabel);
	}
	if (err instanceof Error && err.message) {
		return err.message;
	}
	return localize('acpAgent.unknownError', "The ACP agent failed.");
}
