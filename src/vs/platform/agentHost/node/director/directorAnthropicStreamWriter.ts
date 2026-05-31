/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { once } from 'events';
import { DirectorCreateMessageResponse, DirectorNormalizedResponseBlock, DirectorProviderStreamEvent, DirectorTokenUsage } from '../../common/directorProviderRuntime.js';
import { createAnthropicMessageId, toAnthropicStopReason, toAnthropicUsage } from './directorAnthropicEndpointProtocol.js';

export interface AnthropicStreamEntry {
	readonly ac: AbortController;
	readonly res: http.ServerResponse;
	clientGone: boolean;
}

export function beginAnthropicSse(res: http.ServerResponse): void {
	if (!res.headersSent) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
	}
	res.flushHeaders();
	setNoDelay(res);
}

export async function writeSyntheticAnthropicStream(res: http.ServerResponse, entry: AnthropicStreamEntry, response: DirectorCreateMessageResponse, sdkModelId: string): Promise<boolean> {
	beginAnthropicSse(res);
	const state = new AnthropicStreamState(sdkModelId);
	if (!await writeAnthropicFrame(res, entry, 'message_start', state.messageStart())) {
		return false;
	}
	for (const block of response.content) {
		if (!await state.writeBlock(res, entry, block)) {
			return false;
		}
	}
	return writeAnthropicStreamComplete(res, entry, state, response.stopReason, response.usage);
}

export async function writeAnthropicProviderStreamEvent(res: http.ServerResponse, entry: AnthropicStreamEntry, state: AnthropicStreamState, event: DirectorProviderStreamEvent): Promise<boolean> {
	switch (event.type) {
		case 'text':
			return state.writeText(res, entry, event.text);
		case 'thinking':
			return state.writeThinking(res, entry, event.thinking);
		case 'tool_use_start':
			return state.writeToolStart(res, entry, event.index ?? 0, event.id, event.name);
		case 'tool_input_delta':
			return state.writeToolDelta(res, entry, event.index ?? 0, event.json);
		case 'tool_call_delta':
			return state.writeToolCallDelta(res, entry, event);
		case 'message_complete':
			return writeAnthropicStreamComplete(res, entry, state, event.stopReason, event.usage);
	}
}

export async function writeAnthropicStreamComplete(res: http.ServerResponse, entry: AnthropicStreamEntry, state: AnthropicStreamState, stopReason: string, usage?: DirectorTokenUsage): Promise<boolean> {
	if (!await state.closeOpenBlocks(res, entry)) {
		return false;
	}
	if (!await writeAnthropicFrame(res, entry, 'message_delta', {
		type: 'message_delta',
		delta: {
			stop_reason: toAnthropicStopReason(stopReason),
			stop_sequence: null,
		},
		usage: toAnthropicUsage(usage),
	})) {
		return false;
	}
	if (!await writeAnthropicFrame(res, entry, 'message_stop', { type: 'message_stop' })) {
		return false;
	}
	if (!res.writableEnded) {
		res.end();
	}
	return true;
}

export class AnthropicStreamState {
	private _nextIndex = 0;
	private _textIndex: number | undefined;
	private _thinkingIndex: number | undefined;
	private readonly _toolIndices = new Map<number, number>();
	private readonly _openBlocks = new Set<number>();
	private _completed = false;

	constructor(private readonly _model: string) { }

	messageStart(): Record<string, unknown> {
		return {
			type: 'message_start',
			message: {
				id: createAnthropicMessageId(),
				type: 'message',
				role: 'assistant',
				model: this._model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		};
	}

	async writeProviderEvent(res: http.ServerResponse, entry: AnthropicStreamEntry, event: DirectorProviderStreamEvent): Promise<boolean> {
		return writeAnthropicProviderStreamEvent(res, entry, this, event);
	}

	async writeComplete(res: http.ServerResponse, entry: AnthropicStreamEntry, stopReason: string, usage?: DirectorTokenUsage): Promise<boolean> {
		return writeAnthropicStreamComplete(res, entry, this, stopReason, usage);
	}

	async writeBlock(res: http.ServerResponse, entry: AnthropicStreamEntry, block: DirectorNormalizedResponseBlock): Promise<boolean> {
		switch (block.type) {
			case 'text':
				return this.writeText(res, entry, block.text);
			case 'thinking':
				return this.writeThinking(res, entry, block.thinking);
			case 'tool_use': {
				const providerIndex = this._toolIndices.size;
				if (!await this.writeToolStart(res, entry, providerIndex, block.toolCall.id, block.toolCall.name)) {
					return false;
				}
				return this.writeToolDelta(res, entry, providerIndex, block.toolCall.input);
			}
		}
	}

	async writeText(res: http.ServerResponse, entry: AnthropicStreamEntry, text: string): Promise<boolean> {
		if (!text) {
			return true;
		}
		const index = await this._ensureTextBlock(res, entry);
		return writeAnthropicFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index,
			delta: { type: 'text_delta', text },
		});
	}

	async writeThinking(res: http.ServerResponse, entry: AnthropicStreamEntry, thinking: string): Promise<boolean> {
		if (!thinking) {
			return true;
		}
		const index = await this._ensureThinkingBlock(res, entry);
		return writeAnthropicFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index,
			delta: { type: 'thinking_delta', thinking },
		});
	}

	async writeToolStart(res: http.ServerResponse, entry: AnthropicStreamEntry, providerIndex: number, id: string, name: string): Promise<boolean> {
		if (this._toolIndices.has(providerIndex)) {
			return true;
		}
		const index = this._nextIndex++;
		this._toolIndices.set(providerIndex, index);
		this._openBlocks.add(index);
		return writeAnthropicFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: {
				type: 'tool_use',
				id,
				name,
				input: {},
			},
		});
	}

	async writeToolDelta(res: http.ServerResponse, entry: AnthropicStreamEntry, providerIndex: number, json: string): Promise<boolean> {
		if (!this._toolIndices.has(providerIndex)) {
			if (!await this.writeToolStart(res, entry, providerIndex, `toolu_${providerIndex}`, 'tool')) {
				return false;
			}
		}
		return writeAnthropicFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index: this._toolIndices.get(providerIndex),
			delta: { type: 'input_json_delta', partial_json: json },
		});
	}

	async writeToolCallDelta(res: http.ServerResponse, entry: AnthropicStreamEntry, event: Extract<DirectorProviderStreamEvent, { readonly type: 'tool_call_delta' }>): Promise<boolean> {
		const providerIndex = event.index;
		if (!this._toolIndices.has(providerIndex) && (event.id || event.name)) {
			if (!await this.writeToolStart(res, entry, providerIndex, event.id ?? `toolu_${providerIndex}`, event.name ?? 'tool')) {
				return false;
			}
		}
		if (event.arguments) {
			return this.writeToolDelta(res, entry, providerIndex, event.arguments);
		}
		return true;
	}

	async closeOpenBlocks(res: http.ServerResponse, entry: AnthropicStreamEntry): Promise<boolean> {
		if (this._completed) {
			return true;
		}
		this._completed = true;
		for (const index of [...this._openBlocks].sort((a, b) => a - b)) {
			if (!await writeAnthropicFrame(res, entry, 'content_block_stop', { type: 'content_block_stop', index })) {
				return false;
			}
		}
		this._openBlocks.clear();
		return true;
	}

	private async _ensureTextBlock(res: http.ServerResponse, entry: AnthropicStreamEntry): Promise<number> {
		if (this._textIndex !== undefined) {
			return this._textIndex;
		}
		const index = this._nextIndex++;
		this._textIndex = index;
		this._openBlocks.add(index);
		await writeAnthropicFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: { type: 'text', text: '' },
		});
		return index;
	}

	private async _ensureThinkingBlock(res: http.ServerResponse, entry: AnthropicStreamEntry): Promise<number> {
		if (this._thinkingIndex !== undefined) {
			return this._thinkingIndex;
		}
		const index = this._nextIndex++;
		this._thinkingIndex = index;
		this._openBlocks.add(index);
		await writeAnthropicFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: { type: 'thinking', thinking: '', signature: '' },
		});
		return index;
	}
}

export async function writeAnthropicFrame(res: http.ServerResponse, entry: AnthropicStreamEntry, event: string, data: unknown): Promise<boolean> {
	if (entry.ac.signal.aborted || res.writableEnded) {
		return false;
	}
	const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	if (!ok) {
		try {
			await once(res, 'drain', { signal: entry.ac.signal });
		} catch {
			return false;
		}
	}
	return true;
}

function setNoDelay(res: http.ServerResponse): void {
	const socket = res.socket;
	if (socket && typeof socket.setNoDelay === 'function') {
		try {
			socket.setNoDelay(true);
		} catch { /* ignore */ }
	}
}
