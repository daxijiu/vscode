/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentSignal, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { MessageAttachment, ModelSelection } from '../../common/state/protocol/state.js';
import { ResponsePart, ResponsePartKind, Turn, TurnState } from '../../common/state/sessionState.js';

interface IDirectorInFlightTurn {
	readonly turnId: string;
	readonly prompt: string;
	readonly attachments: readonly MessageAttachment[] | undefined;
	readonly responseParts: ResponsePart[];
	cancelled: boolean;
	terminalEmitted: boolean;
}

export class DirectorAgentSession extends Disposable {

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _turns: Turn[] = [];
	private _inFlight: IDirectorInFlightTurn | undefined;
	private _modifiedAt: number;

	constructor(
		readonly sessionId: string,
		readonly sessionUri: URI,
		readonly createdAt: number,
		readonly workingDirectory: URI | undefined,
		private _model: ModelSelection | undefined,
		private readonly _delayBetweenChunks: () => Promise<void> = () => timeout(0),
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
			cancelled: false,
			terminalEmitted: false,
		};
		this._inFlight = inFlight;
		this._modifiedAt = Date.now();

		this._emitMarkdown(inFlight, 'Director echo:');
		await this._delayBetweenChunks();
		if (this._isTerminal(inFlight)) {
			return;
		}

		this._emitMarkdown(inFlight, ` ${prompt}`);
		if (this._isTerminal(inFlight)) {
			return;
		}

		this._complete(inFlight);
	}

	abort(): void {
		const inFlight = this._inFlight;
		if (!inFlight || inFlight.terminalEmitted) {
			return;
		}
		inFlight.cancelled = true;
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
			usage: undefined,
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
			usage: undefined,
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
}
