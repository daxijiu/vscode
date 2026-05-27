/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ExternalAcpAgentSnapshotAgent } from '../../common/acpAgentConfig.js';
import { AcpConnection } from './acpConnection.js';
import { acpProcessExitedError, acpProcessNotFoundError, acpUnsupportedProtocolVersionError, isAcpError, redactAcpDiagnostic, AcpError, AcpErrorCode } from './acpErrors.js';
import { resolveAcpRuntimeEnvironment } from './acpRuntimeEnvironment.js';
import { AcpInitializeParams, AcpInitializeResult, AcpMethod, AcpProtocolVersion } from './acpProtocol.js';

export interface AcpProcessOptions {
	readonly agent: ExternalAcpAgentSnapshotAgent;
	readonly workspaceCwd?: string;
	readonly hostEnv?: NodeJS.ProcessEnv;
	readonly initializeTimeoutMs?: number;
}

export interface AcpProcessDiagnostic {
	readonly command: string;
	readonly cwd?: string;
	readonly pid?: number;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stderr: string;
	readonly running: boolean;
}

const MaxStderrLength = 8192;
const DefaultInitializeTimeoutMs = 10_000;

export class AcpProcess extends Disposable {
	private readonly connection = this._register(new MutableDisposable<AcpConnection>());
	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private cwd: string | undefined;
	private stderr = '';
	private redactionValues: readonly string[] = [];
	private exitCode: number | null | undefined;
	private signal: string | null | undefined;
	private disposed = false;

	constructor(private readonly options: AcpProcessOptions) {
		super();
	}

	async initialize(): Promise<AcpInitializeResult> {
		this.start();
		const params: AcpInitializeParams = {
			protocolVersion: AcpProtocolVersion,
			clientCapabilities: {},
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
			return result;
		} catch (err) {
			this.dispose();
			throw err;
		}
	}

	kill(): void {
		this.dispose();
	}

	diagnostic(): AcpProcessDiagnostic {
		return {
			command: this.options.agent.command,
			...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
			...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
			exitCode: this.exitCode,
			signal: this.signal,
			stderr: this.stderr,
			running: this.child !== undefined && !this.child.killed && this.exitCode === undefined,
		};
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.connection.clear();
		if (this.child && !this.child.killed) {
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

		let child: cp.ChildProcessWithoutNullStreams;
		try {
			child = cp.spawn(this.options.agent.command, [...this.options.agent.args], {
				cwd: runtimeEnvironment.cwd,
				env: runtimeEnvironment.env,
				shell: false,
				stdio: 'pipe',
			});
		} catch (err) {
			throw this.toSpawnError(err);
		}

		this.child = child;
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => this.appendStderr(String(chunk)));
		child.on('error', err => {
			this.exitCode = null;
			this.signal = null;
			this.connection.value?.closeWithError(this.toSpawnError(err));
		});
		child.on('close', (code, signal) => {
			this.exitCode = code;
			this.signal = signal;
			this.connection.value?.closeWithError(acpProcessExitedError(code, signal));
		});

		const connection = new AcpConnection(child.stdout, child.stdin);
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
