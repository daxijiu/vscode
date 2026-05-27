/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ExternalAcpAgentConnectionStatus, ExternalAcpAgentConnectionStatusKind, toExternalAcpAgentSnapshot, validateExternalAcpAgentConfig } from '../../../../platform/agentHost/common/acpAgentConfig.js';
/* eslint-disable local/code-layering, local/code-import-patterns -- Desktop-only explicit connection tests reuse the AgentHost ACP runtime instead of duplicating process/protocol logic. */
import { AcpErrorCode, isAcpError } from '../../../../platform/agentHost/node/acp/acpErrors.js';
import { AcpProcess } from '../../../../platform/agentHost/node/acp/acpProcess.js';
import { AcpAuthMethod } from '../../../../platform/agentHost/node/acp/acpProtocol.js';
import { toRedactedAcpAuthMethods } from '../../../../platform/agentHost/node/acp/acpAgentSession.js';
/* eslint-enable local/code-layering, local/code-import-patterns */
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExternalAcpAgentConnectionTestService, IExternalAcpAgentRegistryService } from '../common/externalAcpAgentProviderService.js';

const TestInitializeTimeoutMs = 10_000;
const TestAuthenticateTimeoutMs = 1_000;

export class ExternalAcpAgentConnectionTestService extends Disposable implements IExternalAcpAgentConnectionTestService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExternalAcpAgentRegistryService private readonly registryService: IExternalAcpAgentRegistryService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async testConnection(id: string): Promise<ExternalAcpAgentConnectionStatus> {
		const agent = await this.registryService.getAgent(id);
		if (!agent) {
			return this.writeStatus(id, 'testFailed', localize('externalAcpAgents.test.missingAgent', "External ACP agent config was not found."));
		}
		const validation = validateExternalAcpAgentConfig(agent);
		if (!validation.valid) {
			return this.writeStatus(id, 'testFailed', validation.message ?? localize('externalAcpAgents.test.invalidConfig', "External ACP agent config is invalid."));
		}
		if (!agent.enabled || !agent.trusted) {
			return this.writeStatus(agent.id, 'testFailed', localize('externalAcpAgents.test.notEnabledTrusted', "Enable and trust this external ACP agent before testing the connection."));
		}

		const snapshotAgent = toExternalAcpAgentSnapshot([agent]).agents[0];
		if (!snapshotAgent) {
			return this.writeStatus(agent.id, 'testFailed', localize('externalAcpAgents.test.notInSnapshot', "This external ACP agent is not eligible for the AgentHost snapshot."));
		}

		const acpProcess = new AcpProcess({
			agent: snapshotAgent,
			workspaceCwd: this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
			hostEnv: process.env,
			initializeTimeoutMs: TestInitializeTimeoutMs,
			authenticateTimeoutMs: TestAuthenticateTimeoutMs,
		});
		try {
			const initializeResult = await acpProcess.initialize();
			const authMethods = toRedactedAcpAuthMethods(initializeResult.authMethods);
			const methodId = initializeResult.authMethods?.find(isSafeAutomaticAuthMethod)?.id;
			if (methodId) {
				const authenticateResult = await acpProcess.authenticate(methodId);
				if (authenticateResult.authenticated === false) {
					return this.writeStatus(agent.id, 'authRequired', localize('externalAcpAgents.test.authRequiredAfterAuthenticate', "The vendor ACP runtime still requires sign-in. Use the vendor-owned login flow, then retry."), authMethods);
				}
			}
			if (authMethods.length && !methodId) {
				return this.writeStatus(agent.id, 'authRequired', this.authHelpMessage(agent.loginCommand, agent.loginHelpUrl), authMethods);
			}
			return this.writeStatus(agent.id, 'testSucceeded', localize('externalAcpAgents.test.succeeded', "Connection test succeeded without sending a prompt."), authMethods);
		} catch (err) {
			return this.writeStatus(agent.id, this.statusKindForError(err), this.messageForError(err), toRedactedAcpAuthMethods(acpProcess.getAuthMethods()));
		} finally {
			acpProcess.dispose();
		}
	}

	async clearConnectionStatus(id: string): Promise<void> {
		await this.registryService.clearConnectionStatus(id);
	}

	private async writeStatus(id: string, kind: ExternalAcpAgentConnectionStatusKind, message: string, authMethods: NonNullable<ExternalAcpAgentConnectionStatus['authMethods']> = []): Promise<ExternalAcpAgentConnectionStatus> {
		const status: ExternalAcpAgentConnectionStatus = {
			kind,
			source: 'testConnection',
			updatedAt: Date.now(),
			message,
			...(authMethods.length ? { authMethods } : {}),
		};
		await this.registryService.updateConnectionStatus(id, status);
		return status;
	}

	private authHelpMessage(loginCommand: string | undefined, loginHelpUrl: string | undefined): string {
		if (loginCommand && loginHelpUrl) {
			return localize('externalAcpAgents.test.authMethodNeedsUserActionWithCommandAndHelp', "The vendor ACP runtime advertised a login method that may open an external flow. Use the configured login command or login help, then retry.");
		}
		if (loginCommand) {
			return localize('externalAcpAgents.test.authMethodNeedsUserActionWithCommand', "The vendor ACP runtime advertised a login method that may open an external flow. Run the configured login command outside VS Code, then retry.");
		}
		if (loginHelpUrl) {
			return localize('externalAcpAgents.test.authMethodNeedsUserActionWithHelp', "The vendor ACP runtime advertised a login method that may open an external flow. Open the configured login help, then retry.");
		}
		return localize('externalAcpAgents.test.authMethodNeedsUserAction', "The vendor ACP runtime advertised a login method that may open an external flow. Complete the vendor-owned login flow, then retry.");
	}

	private statusKindForError(err: unknown): ExternalAcpAgentConnectionStatusKind {
		if (!isAcpError(err)) {
			return 'testFailed';
		}
		switch (err.acpCode) {
			case AcpErrorCode.AuthRequired:
				return 'authRequired';
			case AcpErrorCode.ProcessNotFound:
				return 'processNotFound';
			case AcpErrorCode.MissingRuntimeEnv:
				return 'missingRuntimeEnv';
			case AcpErrorCode.Timeout:
				return 'timeout';
			default:
				return 'testFailed';
		}
	}

	private messageForError(err: unknown): string {
		if (isAcpError(err)) {
			switch (err.acpCode) {
				case AcpErrorCode.AuthRequired:
					return localize('externalAcpAgents.test.authRequired', "The vendor ACP runtime requires sign-in. Use the vendor-owned login flow, then retry.");
				case AcpErrorCode.ProcessNotFound:
					return localize('externalAcpAgents.test.processNotFound', "The configured ACP runtime command was not found.");
				case AcpErrorCode.MissingRuntimeEnv:
					return localize('externalAcpAgents.test.missingRuntimeEnv', "The configured ACP runtime environment is missing a required value.");
				case AcpErrorCode.Timeout:
					return localize('externalAcpAgents.test.timeout', "The ACP connection test timed out and the runtime was disposed.");
				default:
					return err.message;
			}
		}
		if (err instanceof Error && err.message) {
			return err.message;
		}
		return localize('externalAcpAgents.test.failed', "The ACP connection test failed.");
	}
}

registerSingleton(IExternalAcpAgentConnectionTestService, ExternalAcpAgentConnectionTestService, InstantiationType.Delayed);

function isSafeAutomaticAuthMethod(method: AcpAuthMethod): boolean {
	return typeof method.id === 'string'
		&& method.id.length > 0
		&& (readBooleanFlag(method, 'safeForTestConnection')
			|| readBooleanFlag(method, 'vscodeSafeForTestConnection')
			|| readBooleanFlag(readObject(method._meta), 'safeForTestConnection')
			|| readBooleanFlag(readObject(readObject(method._meta)?.vscode), 'safeForTestConnection'));
}

function readBooleanFlag(value: unknown, property: string): boolean {
	return readObject(value)?.[property] === true;
}

function readObject(value: unknown): { readonly [key: string]: unknown } | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : undefined;
}
