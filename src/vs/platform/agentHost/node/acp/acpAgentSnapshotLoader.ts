/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExternalAcpAgentSnapshotAgent, ExternalAcpAgentSnapshotVersion, normalizeCapabilities, sanitizeEnvVariableNames, sanitizeExternalAcpAgentId, validateExternalAcpAgentConfig, ExternalAcpAgentCwdPolicy } from '../../common/acpAgentConfig.js';
import { IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import { URI } from '../../../../base/common/uri.js';

export class AcpAgentSnapshotLoader {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	async load(snapshotResource: URI): Promise<readonly ExternalAcpAgentSnapshotAgent[]> {
		try {
			if (!await this.fileService.exists(snapshotResource)) {
				this.logService.info(`[ACP AgentHost] No external ACP agent snapshot found at ${snapshotResource.fsPath}`);
				return [];
			}
			const raw = JSON.parse((await this.fileService.readFile(snapshotResource)).value.toString()) as unknown;
			if (!isSnapshot(raw)) {
				this.logService.warn(`[ACP AgentHost] Ignoring invalid external ACP agent snapshot at ${snapshotResource.fsPath}`);
				return [];
			}
			const agents: ExternalAcpAgentSnapshotAgent[] = [];
			for (const candidate of raw.agents) {
				if (!isSnapshotAgentCandidate(candidate)) {
					this.logService.warn('[ACP AgentHost] Skipping malformed external ACP agent snapshot entry');
					continue;
				}
				try {
					const normalized = normalizeSnapshotAgent(candidate);
					const validation = validateExternalAcpAgentConfig({
						...normalized,
						enabled: true,
						trusted: true,
						createdAt: 0,
						updatedAt: 0,
					});
					if (!validation.valid) {
						this.logService.warn(`[ACP AgentHost] Skipping invalid external ACP agent '${normalized.id}': ${validation.message ?? 'invalid configuration'}`);
						continue;
					}
					agents.push(normalized);
				} catch (err) {
					this.logService.warn('[ACP AgentHost] Skipping malformed external ACP agent snapshot entry', err);
				}
			}
			return agents;
		} catch (err) {
			this.logService.warn(`[ACP AgentHost] Failed to read external ACP agent snapshot at ${snapshotResource.fsPath}`, err);
			return [];
		}
	}
}

interface ExternalAcpAgentSnapshotInput {
	readonly version: unknown;
	readonly agents: readonly unknown[];
}

function isSnapshot(value: unknown): value is ExternalAcpAgentSnapshotInput {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const snapshot = value as Partial<ExternalAcpAgentSnapshotInput>;
	return snapshot.version === ExternalAcpAgentSnapshotVersion && Array.isArray(snapshot.agents);
}

function isSnapshotAgentCandidate(value: unknown): value is Partial<ExternalAcpAgentSnapshotAgent> {
	return !!value && typeof value === 'object';
}

function normalizeSnapshotAgent(agent: Partial<ExternalAcpAgentSnapshotAgent>): ExternalAcpAgentSnapshotAgent {
	const cwdPolicy = normalizeCwdPolicy(agent.cwdPolicy);
	return {
		id: sanitizeExternalAcpAgentId(readString(agent.id)),
		displayName: readString(agent.displayName),
		command: readString(agent.command),
		args: Array.isArray(agent.args) ? agent.args.map(readString).filter(value => value.length > 0) : [],
		cwdPolicy,
		...(cwdPolicy === ExternalAcpAgentCwdPolicy.Fixed && readString(agent.cwd).length > 0 ? { cwd: readString(agent.cwd) } : {}),
		...(readString(agent.vendorLabel).length > 0 ? { vendorLabel: readString(agent.vendorLabel) } : {}),
		...(readString(agent.loginHint).length > 0 ? { loginHint: readString(agent.loginHint) } : {}),
		...(readString(agent.loginCommand).length > 0 ? { loginCommand: readString(agent.loginCommand) } : {}),
		...(readString(agent.loginHelpUrl).length > 0 ? { loginHelpUrl: readString(agent.loginHelpUrl) } : {}),
		...(agent.connectionStatus !== undefined ? { connectionStatus: agent.connectionStatus } : {}),
		capabilities: normalizeCapabilities(Array.isArray(agent.capabilities) ? agent.capabilities : []),
		...(Array.isArray(agent.envVariableNames) ? { envVariableNames: sanitizeEnvVariableNames(agent.envVariableNames.map(readString)) } : {}),
		...(Array.isArray(agent.secretRefs) ? { secretRefs: agent.secretRefs.map(readString).filter(value => value.length > 0) } : {}),
	};
}

function normalizeCwdPolicy(policy: ExternalAcpAgentCwdPolicy | undefined): ExternalAcpAgentCwdPolicy {
	switch (policy) {
		case ExternalAcpAgentCwdPolicy.None:
		case ExternalAcpAgentCwdPolicy.Fixed:
		case ExternalAcpAgentCwdPolicy.Workspace:
			return policy;
		default:
			return ExternalAcpAgentCwdPolicy.Workspace;
	}
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}
