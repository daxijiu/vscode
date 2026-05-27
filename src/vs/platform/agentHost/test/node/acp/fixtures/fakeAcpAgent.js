/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const mode = process.argv[2] || 'success';
let buffer = '';

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

	if (request.method !== 'initialize') {
		writeResponse(request.id, {});
		return;
	}

	switch (mode) {
		case 'success':
			writeInitialize(request.id, 1);
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
