/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpRedactedCommandSummary } from './acpCommandResolver.js';

export const enum AcpDiagnosticEventType {
	Process = 'process',
}

export const enum AcpDiagnosticStatus {
	NotStarted = 'notStarted',
	Running = 'running',
	Exited = 'exited',
}

export interface AcpAllowedDiagnostic {
	readonly eventType: AcpDiagnosticEventType;
	readonly status: AcpDiagnosticStatus;
	readonly durationMs?: number;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly message: string;
	readonly stderrAvailable: boolean;
	readonly stderrBytes: number;
	readonly stderrLineCount: number;
	readonly command: AcpRedactedCommandSummary;
}

const StderrCapturedMessage = 'ACP runtime stderr was captured locally but is not included in diagnostics.';

export function createAcpProcessDiagnostic(options: {
	readonly startTime?: number;
	readonly endTime?: number;
	readonly running: boolean;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stderr: string;
	readonly command: AcpRedactedCommandSummary;
}): AcpAllowedDiagnostic {
	const status = options.running
		? AcpDiagnosticStatus.Running
		: options.exitCode !== undefined || options.signal !== undefined || options.startTime !== undefined
			? AcpDiagnosticStatus.Exited
			: AcpDiagnosticStatus.NotStarted;
	const durationMs = options.startTime !== undefined
		? Math.max(0, (options.endTime ?? Date.now()) - options.startTime)
		: undefined;
	return {
		eventType: AcpDiagnosticEventType.Process,
		status,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		message: StderrCapturedMessage,
		stderrAvailable: options.stderr.length > 0,
		stderrBytes: Buffer.byteLength(options.stderr, 'utf8'),
		stderrLineCount: countLines(options.stderr),
		command: options.command,
	};
}

export function redactAcpDiagnostic(value: string, secretValues: readonly string[] = []): string {
	let redacted = value;
	for (const secret of secretValues) {
		if (secret.length >= 4) {
			redacted = redacted.split(secret).join('[redacted]');
		}
	}
	redacted = redacted.replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)\s*=\s*)[^\s]+/gi, '$1[redacted]');
	redacted = redacted.replace(/(--(?:api-key|apikey|token|secret|password)(?:=|\s+))[^\s]+/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)[_-])[^\s,;]+/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)["']?\s*:\s*["'])[^\s"']+/gi, '$1[redacted]');
	return redacted;
}

function countLines(value: string): number {
	if (!value) {
		return 0;
	}
	return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n').length;
}
