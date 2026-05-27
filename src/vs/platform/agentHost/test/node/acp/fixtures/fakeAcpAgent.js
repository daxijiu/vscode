/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';

const mode = process.argv[2] || 'success';
const markerPath = process.argv[3];
let buffer = '';
let activeSessionId = 'fake-session-1';
let pendingPromptId = undefined;
let cancelled = false;

if (mode.startsWith('dispose-marker') && markerPath) {
	fs.appendFileSync(markerPath, `start ${process.pid}\n`);
}

if (mode === 'exit-immediate') {
	process.exit(3);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	buffer += chunk;
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
		buffer = buffer.slice(newlineIndex + 1);
		if (line.trim()) {
			handleLine(line);
		}
	}
});

function handleLine(line) {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}

	if (request.method === 'session/cancel') {
		cancelled = true;
		if (pendingPromptId !== undefined) {
			const id = pendingPromptId;
			pendingPromptId = undefined;
			writeResponse(id, { stopReason: 'cancelled' });
			setTimeout(() => writeSessionUpdate(activeSessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'late after cancel' },
			}), 5);
		}
		return;
	}

	if (request.method === 'initialize') {
		switch (mode) {
			case 'success':
			case 'text-stream':
			case 'reasoning-stream':
			case 'auth-on-session-new':
			case 'prompt-error':
			case 'cancel-race':
			case 'late-update-after-complete':
			case 'tool-call-unexpected':
			case 'dispose-marker':
			case 'dispose-marker-fail-second-session-new':
				writeInitialize(request.id, 1);
				break;
			case 'dispose-marker-fail-second-initialize':
				if (startedProcessCount() > 1) {
					writeError(request.id, -32603, 'Initialize failed on replacement');
				} else {
					writeInitialize(request.id, 1);
				}
				break;
			case 'unsupported-version':
				writeInitialize(request.id, 2);
				break;
			case 'malformed-json':
				process.stdout.write('{"jsonrpc":"2.0","id":');
				process.stdout.write('\n');
				break;
			case 'timeout':
				break;
			case 'auth-required':
				writeError(request.id, -32000, 'Authentication required: secret token abc123');
				break;
			case 'stderr-secret':
				process.stderr.write(`token=${process.env.ACP_FAKE_SECRET}\n`);
				writeInitialize(request.id, 1);
				break;
			case 'exit-after-request':
				process.exit(4);
				break;
			default:
				writeError(request.id, -32602, 'Unknown fake mode');
		}
		return;
	}

	if (request.method === 'session/new') {
		if (mode === 'auth-on-session-new' || (mode === 'dispose-marker-fail-second-session-new' && startedProcessCount() > 1)) {
			writeError(request.id, -32000, 'Authentication required');
			return;
		}
		activeSessionId = `fake-session-${request.id}`;
		writeResponse(request.id, { sessionId: activeSessionId });
		return;
	}

	if (request.method === 'session/prompt') {
		handlePrompt(request);
		return;
	}

	writeResponse(request.id, {});
}

function handlePrompt(request) {
	const sessionId = request.params?.sessionId || activeSessionId;
	switch (mode) {
		case 'text-stream':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Hello ' },
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'ACP' },
			});
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
		case 'reasoning-stream':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_thought_chunk',
				content: { type: 'text', text: 'Thinking' },
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Done' },
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'usage_update',
				inputTokens: 2,
				outputTokens: 3,
			});
			writeResponse(request.id, { stopReason: 'max_tokens' });
			break;
		case 'prompt-error':
			writeError(request.id, -32603, 'Prompt failed');
			break;
		case 'cancel-race':
			pendingPromptId = request.id;
			setTimeout(() => {
				if (cancelled) {
					return;
				}
				writeSessionUpdate(sessionId, {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'too late' },
				});
				writeResponse(request.id, { stopReason: 'end_turn' });
			}, 100);
			break;
		case 'late-update-after-complete':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Finished' },
			});
			writeResponse(request.id, { stopReason: 'end_turn' });
			setTimeout(() => writeSessionUpdate(sessionId, {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: ' late' },
			}), 5);
			break;
		case 'tool-call-unexpected':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call',
				toolCallId: 'tool-1',
				title: 'Read file',
				kind: 'read',
				status: 'pending',
			});
			break;
		default:
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
	}
}

function writeInitialize(id, protocolVersion) {
	writeResponse(id, {
		protocolVersion,
		agentCapabilities: {},
		authMethods: [],
		agentInfo: {
			name: 'fake-acp-agent',
			title: 'Fake ACP Agent',
			version: '1.0.0',
		},
	});
}

function writeResponse(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function writeSessionUpdate(sessionId, update) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })}\n`);
}

function startedProcessCount() {
	if (!markerPath) {
		return 0;
	}
	try {
		return fs.readFileSync(markerPath, 'utf8')
			.split(/\r?\n/)
			.filter(line => line.startsWith('start '))
			.length;
	} catch {
		return 0;
	}
}
