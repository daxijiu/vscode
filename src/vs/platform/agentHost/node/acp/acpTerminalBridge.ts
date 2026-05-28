/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent as isEqualOrParentPath } from '../../../../base/common/extpath.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TerminalClaimKind } from '../../common/state/protocol/state.js';
import { IAgentHostTerminalManager } from '../agentHostTerminalManager.js';
import { AcpJsonRpcError, AcpJsonRpcErrorCode, AcpTerminalCreateParams, AcpTerminalCreateResult, AcpTerminalExitStatus, AcpTerminalIdParams, AcpTerminalOutputResult } from './acpProtocol.js';

const DefaultOutputByteLimit = 1024 * 1024;
const MaxOutputByteLimit = 10 * 1024 * 1024;
const EnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface AcpManagedTerminal {
	readonly terminalId: string;
	readonly resource: string;
	readonly title: string;
	readonly disposables: DisposableStore;
	readonly outputByteLimit: number;
	output: string;
	truncated: boolean;
	exitCode: number | undefined;
}

export class AcpTerminalBridge extends Disposable {

	private readonly terminals = new Map<string, AcpManagedTerminal>();
	private readonly retainedResources = new Set<string>();
	private acpSessionId: string | undefined;

	constructor(
		private readonly terminalManager: IAgentHostTerminalManager,
		private readonly workspaceRoot: URI,
		private readonly sessionUri: URI,
	) {
		super();
	}

	setSessionId(sessionId: string): void {
		this.acpSessionId = sessionId;
	}

	terminalContent(terminalId: string): { readonly resource: string; readonly title: string } | undefined {
		const terminal = this.terminals.get(terminalId);
		if (terminal) {
			return { resource: terminal.resource, title: terminal.title };
		}
		return undefined;
	}

	async create(params: AcpTerminalCreateParams): Promise<AcpTerminalCreateResult> {
		this.validateSession(params?.sessionId);
		const command = normalizeCommand(params?.command);
		const args = normalizeArgs(params?.args);
		const cwd = this.resolveContainedCwd(params?.cwd);
		const env = normalizeEnv(params?.env);
		const outputByteLimit = normalizeOutputByteLimit(params?.outputByteLimit);
		const terminalId = `term_${generateUuid().replace(/-/g, '')}`;
		const resource = URI.from({ scheme: 'agenthost-terminal', authority: 'acp', path: `/${terminalId}` }).toString();
		const title = titleForCommand(command, args);
		const terminal: AcpManagedTerminal = {
			terminalId,
			resource,
			title,
			disposables: new DisposableStore(),
			outputByteLimit,
			output: '',
			truncated: false,
			exitCode: undefined,
		};
		this.terminals.set(terminalId, terminal);
		this.retainedResources.add(resource);
		try {
			await this.terminalManager.createTerminal({
				channel: resource,
				claim: { kind: TerminalClaimKind.Session, session: this.sessionUri.toString() },
				name: title,
				cwd: URI.file(cwd).toString(),
				cols: 80,
				rows: 24,
			}, {
				shell: command,
				args,
				env,
				nonInteractive: true,
				shellIntegration: false,
			});
			const existingOutput = this.terminalManager.getContent(resource);
			if (existingOutput) {
				this.appendOutput(terminal, existingOutput);
			}
			terminal.disposables.add(this.terminalManager.onData(resource, data => this.appendOutput(terminal, data)));
			terminal.disposables.add(this.terminalManager.onExit(resource, exitCode => {
				terminal.exitCode = exitCode;
			}));
			return { terminalId };
		} catch (err) {
			this.terminals.delete(terminalId);
			this.retainedResources.delete(resource);
			terminal.disposables.dispose();
			this.terminalManager.disposeTerminal(resource);
			throw err;
		}
	}

	output(params: AcpTerminalIdParams): AcpTerminalOutputResult {
		const terminal = this.getTerminal(params);
		const exitStatus = this.getExitStatus(terminal);
		return {
			output: terminal.output,
			truncated: terminal.truncated,
			...(exitStatus ? { exitStatus } : {}),
		};
	}

	async waitForExit(params: AcpTerminalIdParams): Promise<AcpTerminalExitStatus> {
		const terminal = this.getTerminal(params);
		const existing = this.getExitStatus(terminal);
		if (existing) {
			return existing;
		}
		return new Promise(resolve => {
			const disposable = this.terminalManager.onExit(terminal.resource, exitCode => {
				disposable.dispose();
				terminal.exitCode = exitCode;
				resolve(toExitStatus(exitCode));
			});
			terminal.disposables.add(disposable);
		});
	}

	kill(params: AcpTerminalIdParams): null {
		const terminal = this.getTerminal(params);
		this.terminalManager.killTerminal(terminal.resource);
		return null;
	}

	release(params: AcpTerminalIdParams): null {
		const terminal = this.getTerminal(params);
		this.terminalManager.killTerminal(terminal.resource);
		terminal.disposables.dispose();
		this.terminals.delete(terminal.terminalId);
		return null;
	}

	toJsonRpcError(err: unknown): AcpJsonRpcError {
		if (err instanceof AcpTerminalBridgeError) {
			return {
				code: err.code,
				message: err.message,
			};
		}
		return {
			code: AcpJsonRpcErrorCode.InternalError,
			message: err instanceof Error && err.message ? err.message : 'ACP terminal bridge request failed.',
		};
	}

	override dispose(): void {
		for (const terminal of this.terminals.values()) {
			terminal.disposables.dispose();
		}
		this.terminals.clear();
		for (const resource of this.retainedResources) {
			this.terminalManager.disposeTerminal(resource);
		}
		this.retainedResources.clear();
		super.dispose();
	}

	private validateSession(sessionId: unknown): void {
		if (typeof sessionId !== 'string' || !sessionId) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal requests require a session id.');
		}
		if (this.acpSessionId !== undefined && sessionId !== this.acpSessionId) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal request session does not match the active session.');
		}
	}

	private resolveContainedCwd(cwd: string | undefined): string {
		if (this.workspaceRoot.scheme !== Schemas.file || this.workspaceRoot.authority) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal bridge is only available for local file workspaces.');
		}
		const resolved = cwd ?? this.workspaceRoot.fsPath;
		if (typeof resolved !== 'string' || !resolved.trim() || !isAbsolute(resolved)) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal cwd must be an absolute local path.');
		}
		if (!isEqualOrParentPath(resolved, this.workspaceRoot.fsPath, isWindows)) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal cwd is outside the active workspace.');
		}
		return resolved;
	}

	private getTerminal(params: AcpTerminalIdParams): AcpManagedTerminal {
		this.validateSession(params?.sessionId);
		const terminalId = typeof params?.terminalId === 'string' ? params.terminalId : undefined;
		if (!terminalId) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP terminal requests require a terminal id.');
		}
		const terminal = this.terminals.get(terminalId);
		if (!terminal) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.ResourceNotFound, 'ACP terminal not found.');
		}
		return terminal;
	}

	private appendOutput(terminal: AcpManagedTerminal, data: string): void {
		if (!data) {
			return;
		}
		const result = trimToByteLimit(terminal.output + data, terminal.outputByteLimit);
		terminal.output = result.output;
		terminal.truncated = terminal.truncated || result.truncated;
	}

	private getExitStatus(terminal: AcpManagedTerminal): AcpTerminalExitStatus | undefined {
		const exitCode = terminal.exitCode ?? this.terminalManager.getExitCode(terminal.resource);
		if (exitCode === undefined) {
			return undefined;
		}
		terminal.exitCode = exitCode;
		return toExitStatus(exitCode);
	}
}

export class AcpTerminalBridgeError extends Error {
	constructor(
		readonly code: AcpJsonRpcErrorCode,
		message: string,
	) {
		super(message);
	}
}

function normalizeCommand(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create requires a command.');
	}
	return value.trim();
}

function normalizeArgs(value: readonly unknown[] | undefined): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create args must be an array of strings.');
	}
	return value.map(arg => {
		if (typeof arg !== 'string') {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create args must be an array of strings.');
		}
		return arg;
	});
}

function normalizeEnv(value: readonly unknown[] | undefined): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!Array.isArray(value)) {
		throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create env must be an array.');
	}
	const env: Record<string, string> = {};
	for (const variable of value) {
		if (!variable || typeof variable !== 'object' || Array.isArray(variable)) {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create env entries must be objects.');
		}
		const name = Object.getOwnPropertyDescriptor(variable, 'name')?.value;
		const envValue = Object.getOwnPropertyDescriptor(variable, 'value')?.value;
		if (typeof name !== 'string' || !EnvNamePattern.test(name) || typeof envValue !== 'string') {
			throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create env entries require string name and value.');
		}
		env[name] = envValue;
	}
	return env;
}

function normalizeOutputByteLimit(value: unknown): number {
	if (value === undefined || value === null) {
		return DefaultOutputByteLimit;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new AcpTerminalBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'terminal/create outputByteLimit must be a non-negative number.');
	}
	return Math.min(Math.floor(value), MaxOutputByteLimit);
}

function trimToByteLimit(output: string, limit: number): { readonly output: string; readonly truncated: boolean } {
	if (limit === 0) {
		return { output: '', truncated: output.length > 0 };
	}
	if (Buffer.byteLength(output, 'utf8') <= limit) {
		return { output, truncated: false };
	}
	let retained = '';
	let retainedBytes = 0;
	for (let index = output.length; index > 0;) {
		let char = output[index - 1];
		let size = 1;
		const low = output.charCodeAt(index - 1);
		if (low >= 0xDC00 && low <= 0xDFFF && index >= 2) {
			const high = output.charCodeAt(index - 2);
			if (high >= 0xD800 && high <= 0xDBFF) {
				char = output.slice(index - 2, index);
				size = 2;
			}
		}
		const byteLength = Buffer.byteLength(char, 'utf8');
		if (retainedBytes + byteLength > limit) {
			break;
		}
		retained = char + retained;
		retainedBytes += byteLength;
		index -= size;
	}
	return { output: retained, truncated: true };
}

function toExitStatus(exitCode: number): AcpTerminalExitStatus {
	return {
		exitCode,
		signal: null,
	};
}

function titleForCommand(command: string, args: readonly string[]): string {
	const label = args.length ? `${command} ${args.join(' ')}` : command;
	return label.length <= 120 ? label : `${label.slice(0, 120)}...`;
}
