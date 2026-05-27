/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PassThrough } from 'stream';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AcpConnection } from '../../../node/acp/acpConnection.js';
import { AcpError, AcpErrorCode } from '../../../node/acp/acpErrors.js';
import { AcpInitializeParams, AcpInitializeResult, AcpMethod, AcpProtocolVersion } from '../../../node/acp/acpProtocol.js';

suite('acpConnection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks JSON-RPC request ids and resolves initialize result', async () => {
		const { connection, input, output } = createConnection();
		disposables.add(connection);

		const request = connection.request<AcpInitializeParams, AcpInitializeResult>(AcpMethod.Initialize, initializeParams(), 1_000);
		const outbound = JSON.parse(await readLine(output)) as { readonly id: number; readonly method: string };
		input.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: outbound.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: {},
				authMethods: [],
			},
		})}\n`);

		assert.deepStrictEqual({
			method: outbound.method,
			result: await request,
		}, {
			method: 'initialize',
			result: {
				protocolVersion: 1,
				agentCapabilities: {},
				authMethods: [],
			},
		});
	});

	test('rejects pending requests when runtime emits malformed JSON', async () => {
		const { connection, input } = createConnection();
		disposables.add(connection);

		const request = connection.request<AcpInitializeParams, AcpInitializeResult>(AcpMethod.Initialize, initializeParams(), 1_000);
		input.write('{"jsonrpc":"2.0","id":\n');

		await assertAcpRejects(request, AcpErrorCode.MalformedJson);
	});

	test('accepts JSON-RPC notifications without closing pending requests', async () => {
		const { connection, input, output } = createConnection();
		disposables.add(connection);

		const notifications: string[] = [];
		disposables.add(connection.onDidNotification(notification => notifications.push(notification.method)));

		const request = connection.request<AcpInitializeParams, AcpInitializeResult>(AcpMethod.Initialize, initializeParams(), 1_000);
		const outbound = JSON.parse(await readLine(output)) as { readonly id: number };
		input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } })}\n`);
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: outbound.id, result: { protocolVersion: 1 } })}\n`);

		assert.deepStrictEqual({
			notifications,
			result: await request,
		}, {
			notifications: ['session/update'],
			result: { protocolVersion: 1 },
		});
	});

	test('rejects inbound JSON-RPC requests without resolving pending responses', async () => {
		const { connection, input, output } = createConnection();
		disposables.add(connection);

		const request = connection.request<AcpInitializeParams, AcpInitializeResult>(AcpMethod.Initialize, initializeParams(), 1_000);
		const outbound = JSON.parse(await readLine(output)) as { readonly id: number };
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: outbound.id, method: 'server/request', params: {} })}\n`);
		const unsupportedResponse = JSON.parse(await readLine(output));
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: outbound.id, result: { protocolVersion: 1 } })}\n`);

		assert.deepStrictEqual({
			unsupportedResponse,
			result: await request,
		}, {
			unsupportedResponse: {
				jsonrpc: '2.0',
				id: outbound.id,
				error: {
					code: -32601,
					message: 'Unsupported ACP request: server/request',
				},
			},
			result: { protocolVersion: 1 },
		});
	});

	test('rejects request timeout without closing later requests', async () => {
		const { connection } = createConnection();
		disposables.add(connection);

		await assertAcpRejects(connection.request(AcpMethod.Initialize, initializeParams(), 5), AcpErrorCode.Timeout);
	});

	test('dispose rejects pending requests', async () => {
		const { connection } = createConnection();
		disposables.add(connection);

		const request = connection.request(AcpMethod.Initialize, initializeParams(), 1_000);
		connection.dispose();

		await assertAcpRejects(request, AcpErrorCode.ProcessExited);
	});

	function createConnection(): { readonly connection: AcpConnection; readonly input: PassThrough; readonly output: PassThrough } {
		const input = new PassThrough();
		const output = new PassThrough();
		return {
			connection: new AcpConnection(input, output),
			input,
			output,
		};
	}
});

function initializeParams(): AcpInitializeParams {
	return {
		protocolVersion: AcpProtocolVersion,
		clientCapabilities: {},
		clientInfo: {
			name: 'vscode-agenthost-test',
			version: '1.0.0',
		},
	};
}

function readLine(stream: PassThrough): Promise<string> {
	return new Promise(resolve => {
		let buffer = '';
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex < 0) {
				return;
			}
			stream.off('data', onData);
			resolve(buffer.slice(0, newlineIndex));
		};
		stream.on('data', onData);
	});
}

async function assertAcpRejects(promise: Promise<unknown>, code: AcpErrorCode): Promise<void> {
	await assert.rejects(promise, (err: unknown) => err instanceof AcpError && err.acpCode === code);
}
