/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AcpJsonRpcError, AcpJsonRpcErrorCode, AcpJsonValue } from './acpProtocol.js';

export const enum AcpErrorCode {
	AuthRequired = 'authRequired',
	ProcessNotFound = 'processNotFound',
	MissingRuntimeEnv = 'missingRuntimeEnv',
	UnsupportedProtocolVersion = 'unsupportedProtocolVersion',
	MalformedJson = 'malformedJson',
	Timeout = 'timeout',
	ProcessExited = 'processExited',
}

export interface AcpErrorData {
	readonly [key: string]: AcpJsonValue | undefined;
}

export class AcpError extends Error {
	override readonly name = 'AcpError';

	constructor(
		readonly acpCode: AcpErrorCode,
		message: string,
		readonly data?: AcpErrorData,
	) {
		super(message);
	}
}

export function isAcpError(err: unknown): err is AcpError {
	return err instanceof AcpError;
}

export function acpAuthRequiredError(): AcpError {
	return new AcpError(AcpErrorCode.AuthRequired, 'ACP agent requires authentication.');
}

export function acpProcessNotFoundError(command: string): AcpError {
	return new AcpError(AcpErrorCode.ProcessNotFound, 'ACP runtime command was not found.', { command: redactedCommand(command) });
}

export function acpMissingRuntimeEnvError(name: string, kind: 'env' | 'secretRef'): AcpError {
	return new AcpError(AcpErrorCode.MissingRuntimeEnv, 'ACP runtime environment is missing a required value.', { name, kind });
}

export function acpUnsupportedRuntimeSecretError(name: string): AcpError {
	return new AcpError(AcpErrorCode.MissingRuntimeEnv, 'ACP runtime secret references are not supported in this phase.', { name, kind: 'secretRef' });
}

export function acpUnsupportedProtocolVersionError(actual: number): AcpError {
	return new AcpError(AcpErrorCode.UnsupportedProtocolVersion, 'ACP agent returned an unsupported protocol version.', { actual });
}

export function acpMalformedJsonError(): AcpError {
	return new AcpError(AcpErrorCode.MalformedJson, 'ACP runtime emitted malformed JSON.');
}

export function acpTimeoutError(method: string): AcpError {
	return new AcpError(AcpErrorCode.Timeout, 'ACP request timed out.', { method });
}

export function acpProcessExitedError(exitCode?: number | null, signal?: string | null): AcpError {
	return new AcpError(AcpErrorCode.ProcessExited, 'ACP runtime process exited.', {
		...(typeof exitCode === 'number' ? { exitCode } : {}),
		...(signal ? { signal } : {}),
	});
}

export function acpErrorFromJsonRpcError(error: AcpJsonRpcError): AcpError {
	if (error.code === AcpJsonRpcErrorCode.AuthRequired) {
		return acpAuthRequiredError();
	}
	if (error.code === AcpJsonRpcErrorCode.ParseError) {
		return acpMalformedJsonError();
	}
	return new AcpError(AcpErrorCode.ProcessExited, 'ACP request failed.', { jsonRpcCode: error.code });
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
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)["']?\s*:\s*["'])[^\s"']+/gi, '$1[redacted]');
	return redacted;
}

function redactedCommand(command: string): string {
	return command.replace(/[^\w.-]+/g, '?');
}
