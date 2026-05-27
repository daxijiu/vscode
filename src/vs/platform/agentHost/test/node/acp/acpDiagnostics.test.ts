/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AcpDiagnosticEventType, AcpDiagnosticStatus, createAcpProcessDiagnostic, redactAcpDiagnostic } from '../../../node/acp/acpDiagnostics.js';

suite('acpDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts stderr secret variants', () => {
		const stderr = [
			'Authorization: Bearer sk-live-secret',
			'token=abc123',
			'api_key=abc123',
			'--api-key abc123',
			'secret_password-value',
			'{"password":"abc123"}',
			'copied-value',
		].join('\n');

		const redacted = redactAcpDiagnostic(stderr, ['copied-value']);

		assert.deepStrictEqual({
			redacted,
			leaks: redacted.includes('sk-live-secret') || redacted.includes('abc123') || redacted.includes('copied-value'),
		}, {
			redacted: [
				'Authorization: Bearer [redacted]',
				'token=[redacted]',
				'api_key=[redacted]',
				'--api-key [redacted]',
				'secret_[redacted]',
				'{"password":"[redacted]"}',
				'[redacted]',
			].join('\n'),
			leaks: false,
		});
	});

	test('process diagnostics keep only the allowlisted schema', () => {
		const diagnostic = createAcpProcessDiagnostic({
			startTime: 100,
			endTime: 175,
			running: false,
			exitCode: 1,
			signal: null,
			stderr: 'terminal output token=abc123 file content',
			command: {
				executable: 'agent.cmd',
				argCount: 2,
				resolvedBy: 'cmd-shim',
				shim: 'cmd.exe',
			},
		});

		assert.deepStrictEqual({
			keys: Object.keys(diagnostic).sort(),
			diagnostic,
			leaks: JSON.stringify(diagnostic).includes('abc123') || JSON.stringify(diagnostic).includes('terminal output'),
		}, {
			keys: ['command', 'durationMs', 'eventType', 'exitCode', 'message', 'signal', 'status', 'stderrAvailable', 'stderrBytes', 'stderrLineCount'],
			diagnostic: {
				eventType: AcpDiagnosticEventType.Process,
				status: AcpDiagnosticStatus.Exited,
				durationMs: 75,
				exitCode: 1,
				signal: null,
				message: 'ACP runtime stderr was captured locally but is not included in diagnostics.',
				stderrAvailable: true,
				stderrBytes: 41,
				stderrLineCount: 1,
				command: {
					executable: 'agent.cmd',
					argCount: 2,
					resolvedBy: 'cmd-shim',
					shim: 'cmd.exe',
				},
			},
			leaks: false,
		});
	});
});
