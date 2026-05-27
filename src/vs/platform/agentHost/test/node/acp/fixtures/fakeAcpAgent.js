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
let pendingPermissionRequestId = undefined;
let cancelled = false;

if ((mode.startsWith('dispose-marker') || mode === 'models-list-fail-second-initialize') && markerPath) {
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
			if (pendingPermissionRequestId === undefined) {
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
		return;
	}

	if (request.method === undefined && request.id === pendingPermissionRequestId) {
		const outcome = request.result?.outcome?.outcome;
		const selected = request.result?.outcome?.optionId;
		const id = pendingPromptId;
		pendingPermissionRequestId = undefined;
		pendingPromptId = undefined;
		if (id !== undefined) {
			if (outcome === 'cancelled') {
				writeResponse(id, { stopReason: 'cancelled' });
			} else {
				writeSessionUpdate(activeSessionId, {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: `permission:${selected || outcome || 'unknown'}` },
				});
				writeResponse(id, { stopReason: 'end_turn' });
			}
		}
		return;
	}

	if (request.method === 'initialize') {
		switch (mode) {
			case 'success':
			case 'text-stream':
			case 'reasoning-stream':
			case 'auth-methods':
			case 'authenticate-success':
			case 'authenticate-fail':
			case 'authenticate-timeout':
			case 'auth-on-session-new':
			case 'auth-on-session-new-with-methods':
			case 'prompt-error':
			case 'cancel-race':
			case 'late-update-after-complete':
			case 'tool-call-unexpected':
			case 'tool-call-lifecycle':
			case 'tool-call-malicious-metadata':
			case 'tool-call-failed':
			case 'permission-request-denied':
			case 'permission-pending-cancel':
			case 'capabilities-echo':
			case 'models-list':
			case 'config-modes':
			case 'meta-capability-boundary':
			case 'unsupported-set-model':
			case 'restore-capability-only':
			case 'dispose-marker':
			case 'dispose-marker-fail-second-session-new':
				writeInitialize(request.id, 1, request.params?.clientCapabilities);
				break;
			case 'models-list-fail-second-initialize':
				if (startedProcessCount() > 1) {
					writeError(request.id, -32603, 'Initialize failed on replacement');
				} else {
					writeInitialize(request.id, 1, request.params?.clientCapabilities);
				}
				break;
			case 'dispose-marker-fail-second-initialize':
				if (startedProcessCount() > 1) {
					writeError(request.id, -32603, 'Initialize failed on replacement');
				} else {
					writeInitialize(request.id, 1, request.params?.clientCapabilities);
				}
				break;
			case 'unsupported-version':
				writeInitialize(request.id, 2, request.params?.clientCapabilities);
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
				writeInitialize(request.id, 1, request.params?.clientCapabilities);
				break;
			case 'exit-after-request':
				process.exit(4);
				break;
			default:
				writeError(request.id, -32602, 'Unknown fake mode');
		}
		return;
	}

	if (request.method === 'authenticate') {
		switch (mode) {
			case 'authenticate-success':
				writeResponse(request.id, { authenticated: true });
				break;
			case 'authenticate-fail':
				writeError(request.id, -32000, 'Authentication failed token=abc123', {
					authMethods: [{ id: 'fake-token-abc123', label: 'Fake Login token=abc123' }],
				});
				break;
			case 'authenticate-timeout':
				break;
			default:
				writeError(request.id, -32601, 'Unsupported authenticate');
				break;
		}
		return;
	}

	if (request.method === 'session/new') {
		if (mode === 'auth-on-session-new' || mode === 'auth-on-session-new-with-methods' || (mode === 'dispose-marker-fail-second-session-new' && startedProcessCount() > 1)) {
			writeError(request.id, -32000, 'Authentication required', {
				authMethods: [{ id: 'fake-token-abc123', label: 'Fake Login token=abc123' }],
			});
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

	if (request.method === 'session/list' || request.method === 'session/load' || request.method === 'session/restore' || request.method === 'session/set_model' || request.method === 'session/setModel') {
		if (markerPath) {
			fs.appendFileSync(markerPath, `method ${request.method}\n`);
		}
		writeError(request.id, -32601, `Unsupported ${request.method}`);
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
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
		case 'tool-call-lifecycle':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call',
				toolCallId: 'tool-1',
				title: 'Read file',
				kind: 'read',
				status: 'pending',
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'tool-1',
				title: 'Read file',
				kind: 'read',
				status: 'in_progress',
				content: [{ type: 'text', text: 'secret-file-content' }],
				locations: [{ path: '/secret/file.txt' }],
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'tool-1',
				title: 'Read file',
				kind: 'read',
				status: 'completed',
				content: [{ type: 'text', text: 'terminal output token=abc123' }],
			});
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
		case 'tool-call-failed':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call',
				toolCallId: 'tool-fail',
				title: 'Run terminal',
				kind: 'terminal',
				status: 'pending',
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'tool-fail',
				title: 'Run terminal',
				kind: 'terminal',
				status: 'failed',
				rawOutput: { text: 'terminal secret output' },
			});
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
		case 'tool-call-malicious-metadata':
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-token-sk-abc123',
				title: 'Read .env SECRET_FILE_CONTENT',
				kind: 'terminal output token=ghp_secret',
				status: 'pending',
			});
			writeSessionUpdate(sessionId, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-token-sk-abc123',
				title: 'Read .env SECRET_FILE_CONTENT',
				kind: 'terminal output token=ghp_secret',
				status: 'completed',
				content: [{ type: 'text', text: 'terminal output token=abc123' }],
			});
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
		case 'permission-request-denied':
		case 'permission-pending-cancel':
			pendingPromptId = request.id;
			pendingPermissionRequestId = `permission-${request.id}`;
			writePermissionRequest(pendingPermissionRequestId, sessionId);
			break;
		default:
			writeResponse(request.id, { stopReason: 'end_turn' });
			break;
	}
}

function writeInitialize(id, protocolVersion, receivedClientCapabilities) {
	writeResponse(id, {
		protocolVersion,
		agentCapabilities: capabilitiesForMode(),
		authMethods: authMethodsForMode(),
		agentInfo: {
			name: 'fake-acp-agent',
			title: 'Fake ACP Agent',
			version: '1.0.0',
			...(mode === 'capabilities-echo' ? { _meta: { receivedClientCapabilities } } : {}),
			...(mode === 'meta-capability-boundary' ? {
				_meta: {
					models: [{ id: 'agent-info-meta-model', name: 'Agent Info Meta Model' }],
					sessionConfigSchema: {
						type: 'object',
						properties: {
							agentInfoMetaProperty: { type: 'string', title: 'Agent Info Meta Property' },
						},
					},
				},
			} : {}),
		},
		...(mode === 'meta-capability-boundary' ? {
			_meta: {
				models: [{ id: 'top-level-meta-model', name: 'Top Level Meta Model' }],
				sessionConfigSchema: {
					type: 'object',
					properties: {
						topLevelMetaProperty: { type: 'string', title: 'Top Level Meta Property' },
					},
				},
				capabilities: {
					models: [{ id: 'nested-capability-model', name: 'Nested Capability Model' }],
					sessionConfigSchema: {
						type: 'object',
						properties: {
							nestedCapabilityProperty: { type: 'string', title: 'Nested Capability Property' },
						},
					},
				},
			},
		} : {}),
	});
}

function capabilitiesForMode() {
	switch (mode) {
		case 'models-list':
		case 'models-list-fail-second-initialize':
			return {
				models: [
					{
						id: 'fake-model',
						name: 'Fake Model',
						maxContextWindow: 123456,
						supportsVision: true,
						apiKey: 'sk-secret-token',
						configSchema: {
							type: 'object',
							properties: {
								effort: {
									type: 'string',
									title: 'Effort',
									enum: ['low', 'high'],
									default: 'low',
								},
								apiKey: {
									type: 'string',
									title: 'API Key',
									default: 'sk-model-secret',
								},
							},
						},
					},
					{
						id: 'token=abc123',
						name: 'Leaky Model',
					},
				],
			};
		case 'config-modes':
			return {
				modes: [
					{ id: 'interactive', label: 'Interactive' },
					{ id: 'plan', label: 'Plan', description: 'Plan first' },
				],
				sessionConfigSchema: {
					type: 'object',
					properties: {
						temperature: {
							type: 'number',
							title: 'Temperature',
							default: 0.4,
						},
						profile: {
							type: 'string',
							title: 'Profile',
							enumDynamic: true,
						},
						password: {
							type: 'string',
							title: 'Password',
							default: 'super-secret',
						},
						note: {
							type: 'string',
							title: 'Note',
							default: 'token=abc123',
						},
					},
					required: ['temperature', 'password'],
				},
				sessionConfigCompletions: {
					profile: [
						{ value: 'fast', label: 'Fast' },
						{ value: 'accurate', label: 'Accurate' },
						{ value: 'token=abc123', label: 'Leaky' },
					],
					token: [
						{ value: 'secret', label: 'Secret' },
					],
					credentials: [
						{ value: 'safe', label: 'Safe' },
					],
					unknownProperty: [
						{ value: 'orphan', label: 'Orphan' },
					],
				},
			};
		case 'unsupported-set-model':
			return {
				models: [
					{ id: 'fake-model', name: 'Fake Model' },
				],
			};
		case 'restore-capability-only':
			return {
				sessionRestore: {
					list: true,
					load: true,
					restore: true,
				},
				methods: ['session/list', 'session/load'],
			};
		default:
			return {};
	}
}

function writeResponse(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message, data) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })}\n`);
}

function writeSessionUpdate(sessionId, update) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })}\n`);
}

function writePermissionRequest(id, sessionId) {
	process.stdout.write(`${JSON.stringify({
		jsonrpc: '2.0',
		id,
		method: 'session/request_permission',
		params: {
			sessionId,
			toolCall: {
				sessionUpdate: 'tool_call',
				toolCallId: 'permission-tool',
				title: 'Write file',
				kind: 'write',
				status: 'pending',
				content: [{ type: 'text', text: 'do not leak this file content' }],
			},
			options: [
				{ optionId: 'allow-once', name: 'Allow Once', kind: 'allow_once' },
				{ optionId: 'reject-once', name: 'Reject Once', kind: 'reject_once' },
			],
		},
	})}\n`);
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

function authMethodsForMode() {
	switch (mode) {
		case 'authenticate-success':
		case 'authenticate-fail':
		case 'authenticate-timeout':
			return [
				{ id: 'fake-login', name: 'Fake Login', description: 'Uses vendor-owned fake login', safeForTestConnection: true },
			];
		case 'auth-methods':
		case 'auth-on-session-new-with-methods':
			return [
				{ id: 'fake-login', name: 'Fake Login', description: 'Uses vendor-owned fake login' },
			];
		default:
			return [];
	}
}
