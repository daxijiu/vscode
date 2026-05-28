/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ExternalAcpAgentSnapshotAgent } from '../../common/acpAgentConfig.js';
import { AcpNegotiatedCapabilities, EmptyAcpNegotiatedCapabilities, normalizeAcpCapabilities } from './acpCapabilities.js';
import { buildAcpClientCapabilities, AcpClientCapabilityPolicy } from './acpClientCapabilities.js';
import { resolveAcpCommand, AcpRedactedCommandSummary, summarizeUnresolvedAcpCommand } from './acpCommandResolver.js';
import { AcpConnection } from './acpConnection.js';
import { AcpAllowedDiagnostic, createAcpProcessDiagnostic, redactAcpDiagnostic } from './acpDiagnostics.js';
import { acpProcessExitedError, acpProcessNotFoundError, acpUnsupportedProtocolVersionError, isAcpError, AcpError, AcpErrorCode } from './acpErrors.js';
import { AcpFileSystemBridge } from './acpFileSystemBridge.js';
import { AcpPermissionBridge } from './acpPermissionBridge.js';
import { resolveAcpRuntimeEnvironment } from './acpRuntimeEnvironment.js';
import { AcpAuthenticateParams, AcpAuthenticateResult, AcpAuthMethod, AcpCancelSessionParams, AcpInitializeParams, AcpInitializeResult, AcpJsonRpcErrorCode, AcpJsonRpcNotification, AcpMethod, AcpNewSessionParams, AcpNewSessionResult, AcpPromptParams, AcpPromptResult, AcpProtocolVersion, AcpReadTextFileParams, AcpRequestPermissionParams, AcpTerminalCreateParams, AcpTerminalIdParams, AcpWriteTextFileParams } from './acpProtocol.js';
import { AcpTerminalBridge } from './acpTerminalBridge.js';

export interface AcpProcessOptions {
	readonly agent: ExternalAcpAgentSnapshotAgent;
	readonly workspaceCwd?: string;
	readonly hostEnv?: NodeJS.ProcessEnv;
	readonly initializeTimeoutMs?: number;
	readonly authenticateTimeoutMs?: number;
	readonly sessionRequestTimeoutMs?: number;
	readonly promptTimeoutMs?: number;
	readonly capabilityPolicy?: AcpClientCapabilityPolicy;
	readonly permissionBridge?: AcpPermissionBridge;
	readonly fileSystemBridge?: AcpFileSystemBridge;
	readonly terminalBridge?: AcpTerminalBridge;
}

const MaxStderrLength = 8192;
const DefaultInitializeTimeoutMs = 10_000;
const DefaultAuthenticateTimeoutMs = 10_000;
const DefaultSessionRequestTimeoutMs = 10_000;
const DefaultPromptTimeoutMs = 30 * 60 * 1000;

export class AcpProcess extends Disposable {
	private readonly connection = this._register(new MutableDisposable<AcpConnection>());
	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private cwd: string | undefined;
	private stderr = '';
	private redactionValues: readonly string[] = [];
	private authMethods: readonly AcpAuthMethod[] = [];
	private capabilities: AcpNegotiatedCapabilities = EmptyAcpNegotiatedCapabilities;
	private readonly permissionBridge: AcpPermissionBridge;
	private commandSummary: AcpRedactedCommandSummary;
	private startedAt: number | undefined;
	private endedAt: number | undefined;
	private exitCode: number | null | undefined;
	private signal: string | null | undefined;
	private disposed = false;

	constructor(private readonly options: AcpProcessOptions) {
		super();
		this.permissionBridge = this._register(options.permissionBridge ?? new AcpPermissionBridge());
		if (options.terminalBridge) {
			this._register(options.terminalBridge);
		}
		this.commandSummary = summarizeUnresolvedAcpCommand(options.agent.command, options.agent.args.length);
	}

	async initialize(): Promise<AcpInitializeResult> {
		this.start();
		const params: AcpInitializeParams = {
			protocolVersion: AcpProtocolVersion,
			clientCapabilities: buildAcpClientCapabilities(this.options.agent, this.options.capabilityPolicy),
			clientInfo: {
				name: 'vscode-agenthost',
				title: 'VS Code AgentHost',
				version: '1.0.0',
			},
		};
		try {
			const result = await this.connection.value!.request<AcpInitializeParams, AcpInitializeResult>(
				AcpMethod.Initialize,
				params,
				this.options.initializeTimeoutMs ?? DefaultInitializeTimeoutMs,
			);
			if (result.protocolVersion !== AcpProtocolVersion) {
				throw acpUnsupportedProtocolVersionError(result.protocolVersion);
			}
			this.authMethods = result.authMethods ?? [];
			this.capabilities = normalizeAcpCapabilities(result);
			return result;
		} catch (err) {
			this.dispose();
			throw err;
		}
	}

	getAuthMethods(): readonly AcpAuthMethod[] {
		return this.authMethods;
	}

	getCapabilities(): AcpNegotiatedCapabilities {
		return this.capabilities;
	}

	async authenticate(methodId: string): Promise<AcpAuthenticateResult> {
		this.start();
		const params: AcpAuthenticateParams = { methodId };
		return this.connection.value!.request<AcpAuthenticateParams, AcpAuthenticateResult>(
			AcpMethod.Authenticate,
			params,
			this.options.authenticateTimeoutMs ?? DefaultAuthenticateTimeoutMs,
		);
	}

	get onDidNotification(): Event<AcpJsonRpcNotification> {
		this.start();
		return this.connection.value!.onDidNotification;
	}

	get onDidRequestPermission(): Event<AcpRequestPermissionParams> {
		return this.permissionBridge.onDidRequestPermission;
	}

	async newSession(cwd: string): Promise<AcpNewSessionResult> {
		this.start();
		const params: AcpNewSessionParams = {
			cwd,
			mcpServers: [],
		};
		return this.connection.value!.request<AcpNewSessionParams, AcpNewSessionResult>(
			AcpMethod.SessionNew,
			params,
			this.options.sessionRequestTimeoutMs ?? DefaultSessionRequestTimeoutMs,
		);
	}

	async prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
		this.start();
		return this.connection.value!.request<AcpPromptParams, AcpPromptResult>(
			AcpMethod.SessionPrompt,
			params,
			this.options.promptTimeoutMs ?? DefaultPromptTimeoutMs,
		);
	}

	async cancel(sessionId: string): Promise<void> {
		this.start();
		this.permissionBridge.cancelPending(sessionId);
		const params: AcpCancelSessionParams = { sessionId };
		await this.connection.value!.notify(AcpMethod.SessionCancel, params);
	}

	respondToPermissionRequest(requestId: string, approved: boolean, selectedOptionId?: string): boolean {
		return this.permissionBridge.respond(requestId, approved, selectedOptionId);
	}

	kill(): void {
		this.dispose();
	}

	diagnostic(): AcpAllowedDiagnostic {
		return createAcpProcessDiagnostic({
			startTime: this.startedAt,
			endTime: this.endedAt,
			running: this.child !== undefined && !this.child.killed && this.exitCode === undefined,
			exitCode: this.exitCode,
			signal: this.signal,
			stderr: this.stderr,
			command: this.commandSummary,
		});
	}

	sessionCwd(): string {
		return this.cwd ?? '';
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.permissionBridge.cancelPending();
		this.connection.clear();
		if (this.child && !this.child.killed) {
			this.endedAt = Date.now();
			try {
				this.child.kill();
			} catch {
				// ignore
			}
		}
		super.dispose();
	}

	private start(): void {
		if (this.child) {
			return;
		}
		const runtimeEnvironment = resolveAcpRuntimeEnvironment(this.options.agent, {
			workspaceCwd: this.options.workspaceCwd,
			hostEnv: this.options.hostEnv,
		});
		this.cwd = runtimeEnvironment.cwd;
		this.redactionValues = runtimeEnvironment.redactionValues;

		const resolvedCommand = resolveAcpCommand(this.options.agent.command, this.options.agent.args, {
			cwd: runtimeEnvironment.cwd,
			env: runtimeEnvironment.env,
		});
		this.commandSummary = resolvedCommand.summary;
		let child: cp.ChildProcessWithoutNullStreams;
		try {
			child = cp.spawn(resolvedCommand.command, [...resolvedCommand.args], {
				cwd: runtimeEnvironment.cwd,
				env: runtimeEnvironment.env,
				shell: false,
				stdio: 'pipe',
				windowsVerbatimArguments: resolvedCommand.windowsVerbatimArguments,
			});
		} catch (err) {
			throw this.toSpawnError(err);
		}

		this.child = child;
		this.startedAt = Date.now();
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => this.appendStderr(String(chunk)));
		child.on('error', err => {
			this.exitCode = null;
			this.signal = null;
			this.endedAt = Date.now();
			this.connection.value?.closeWithError(this.toSpawnError(err));
		});
		child.on('close', (code, signal) => {
			this.exitCode = code;
			this.signal = signal;
			this.endedAt = Date.now();
			this.connection.value?.closeWithError(acpProcessExitedError(code, signal));
		});

		const connection = new AcpConnection(child.stdout, child.stdin, async request => {
			if (request.method === AcpMethod.SessionRequestPermission) {
				return { result: await this.permissionBridge.requestPermission(request.params as AcpRequestPermissionParams) };
			}
			if (request.method === AcpMethod.FsReadTextFile) {
				if (!this.options.fileSystemBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: await this.options.fileSystemBridge.readTextFile(request.params as AcpReadTextFileParams) };
				} catch (err) {
					return { error: this.options.fileSystemBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.FsWriteTextFile) {
				if (!this.options.fileSystemBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: await this.options.fileSystemBridge.writeTextFile(request.params as AcpWriteTextFileParams) };
				} catch (err) {
					return { error: this.options.fileSystemBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.TerminalCreate) {
				if (!this.options.terminalBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: await this.options.terminalBridge.create(request.params as AcpTerminalCreateParams) };
				} catch (err) {
					return { error: this.options.terminalBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.TerminalOutput) {
				if (!this.options.terminalBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: this.options.terminalBridge.output(request.params as AcpTerminalIdParams) };
				} catch (err) {
					return { error: this.options.terminalBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.TerminalWaitForExit) {
				if (!this.options.terminalBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: await this.options.terminalBridge.waitForExit(request.params as AcpTerminalIdParams) };
				} catch (err) {
					return { error: this.options.terminalBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.TerminalKill) {
				if (!this.options.terminalBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: this.options.terminalBridge.kill(request.params as AcpTerminalIdParams) };
				} catch (err) {
					return { error: this.options.terminalBridge.toJsonRpcError(err) };
				}
			}
			if (request.method === AcpMethod.TerminalRelease) {
				if (!this.options.terminalBridge) {
					return this.unsupportedRequest(request.method);
				}
				try {
					return { result: this.options.terminalBridge.release(request.params as AcpTerminalIdParams) };
				} catch (err) {
					return { error: this.options.terminalBridge.toJsonRpcError(err) };
				}
			}
			return this.unsupportedRequest(request.method);
		});
		this.connection.value = connection;
		this._register(connection.onDidClose(err => {
			if (err.acpCode === AcpErrorCode.MalformedJson) {
				this.dispose();
			}
		}));
	}

	private appendStderr(chunk: string): void {
		this.stderr += redactAcpDiagnostic(chunk, this.redactionValues);
		if (this.stderr.length > MaxStderrLength) {
			this.stderr = this.stderr.slice(this.stderr.length - MaxStderrLength);
		}
	}

	private unsupportedRequest(method: string): { readonly error: { readonly code: AcpJsonRpcErrorCode.MethodNotFound; readonly message: string } } {
		return {
			error: {
				code: AcpJsonRpcErrorCode.MethodNotFound,
				message: `Unsupported ACP request: ${method}`,
			},
		};
	}

	private toSpawnError(err: unknown): AcpError {
		if (isAcpError(err)) {
			return err;
		}
		if (isNodeError(err) && err.code === 'ENOENT') {
			return acpProcessNotFoundError(this.options.agent.command);
		}
		return acpProcessExitedError();
	}
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && 'code' in err;
}
