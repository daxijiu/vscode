/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/resources.js';
import { ExternalAcpAgentConfig, ExternalAcpAgentConfigVersion, ExternalAcpAgentConnectionStatus, ExternalAcpAgentRegistry, ExternalAcpAgentSnapshot, createExternalAcpAgentConfig, createRegistryDraftExternalAcpAgentConfig, getExternalAcpAgentRegistryResourceFromGlobalStorageHome, getExternalAcpAgentSnapshotResourceFromGlobalStorageHome, normalizeConnectionStatus, normalizeExternalAcpAgentConfig, sanitizeExternalAcpAgentId, toExternalAcpAgentSnapshot, validateExternalAcpAgentConfig } from '../../../../platform/agentHost/common/acpAgentConfig.js';
import { AcpRegistryAgent, toAcpRegistryDraftOptions } from '../../../../platform/agentHost/common/acpRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';

export const IExternalAcpAgentRegistryService = createDecorator<IExternalAcpAgentRegistryService>('externalAcpAgentRegistryService');
export const IExternalAcpAgentSnapshotService = createDecorator<IExternalAcpAgentSnapshotService>('externalAcpAgentSnapshotService');
export const IExternalAcpAgentConnectionTestService = createDecorator<IExternalAcpAgentConnectionTestService>('externalAcpAgentConnectionTestService');
export const ExternalAcpAgentsRegistryBrowseEnabledSetting = 'externalAcpAgents.registryBrowse.enabled';
export const ExternalAcpAgentsManagedInstallEnabledSetting = 'externalAcpAgents.managedInstall.enabled';

export interface IExternalAcpAgentRegistryService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAgents: Event<void>;
	listAgents(): Promise<readonly ExternalAcpAgentConfig[]>;
	getAgent(id: string): Promise<ExternalAcpAgentConfig | undefined>;
	saveAgent(agent: ExternalAcpAgentConfig): Promise<ExternalAcpAgentConfig>;
	createRegistryDraft(agent: AcpRegistryAgent): Promise<ExternalAcpAgentConfig>;
	saveRegistryDraft(agent: ExternalAcpAgentConfig): Promise<ExternalAcpAgentConfig>;
	markRegistryDraftReviewed(id: string): Promise<ExternalAcpAgentConfig>;
	removeAgent(id: string): Promise<void>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	setTrusted(id: string, trusted: boolean): Promise<void>;
	updateConnectionStatus(id: string, status: ExternalAcpAgentConnectionStatus): Promise<void>;
	clearConnectionStatus(id: string): Promise<void>;
	getState(): Promise<ExternalAcpAgentRegistry>;
}

export interface IExternalAcpAgentSnapshotService {
	readonly _serviceBrand: undefined;
	writeSnapshot(): Promise<ExternalAcpAgentSnapshot>;
	getSnapshotResource(): Promise<string>;
}

export interface IExternalAcpAgentConnectionTestService {
	readonly _serviceBrand: undefined;
	testConnection(id: string): Promise<ExternalAcpAgentConnectionStatus>;
	clearConnectionStatus(id: string): Promise<void>;
}

export class ExternalAcpAgentRegistryService extends Disposable implements IExternalAcpAgentRegistryService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeAgentsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeAgents = this.onDidChangeAgentsEmitter.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async listAgents(): Promise<readonly ExternalAcpAgentConfig[]> {
		return (await this.getState()).agents;
	}

	async getAgent(id: string): Promise<ExternalAcpAgentConfig | undefined> {
		const normalizedId = sanitizeExternalAcpAgentId(id);
		return (await this.listAgents()).find(agent => agent.id === normalizedId);
	}

	async saveAgent(agent: ExternalAcpAgentConfig): Promise<ExternalAcpAgentConfig> {
		const state = await this.getState();
		const normalized = normalizeExternalAcpAgentConfig({
			...agent,
			applyState: 'pendingRestart',
			updatedAt: Date.now(),
		});
		const validation = validateExternalAcpAgentConfig(normalized);
		if (!validation.valid) {
			throw new Error(validation.message ?? `External ACP agent '${normalized.id}' is invalid.`);
		}
		const agents = state.agents.filter(candidate => candidate.id !== normalized.id);
		await this.writeState({
			version: ExternalAcpAgentConfigVersion,
			agents: [...agents, normalized].sort(sortAgents),
		});
		return normalized;
	}

	async createRegistryDraft(agent: AcpRegistryAgent): Promise<ExternalAcpAgentConfig> {
		const options = toAcpRegistryDraftOptions(agent);
		if (!options) {
			throw new Error(`ACP registry entry '${agent.id}' cannot create a safe manual draft.`);
		}
		return this.saveRegistryDraft(createRegistryDraftExternalAcpAgentConfig(options));
	}

	async saveRegistryDraft(agent: ExternalAcpAgentConfig): Promise<ExternalAcpAgentConfig> {
		const state = await this.getState();
		const normalized = normalizeExternalAcpAgentConfig({
			...agent,
			enabled: false,
			trusted: false,
			registryDraft: true,
		});
		const existing = state.agents.find(candidate => candidate.id === normalized.id);
		if (existing && !existing.registryDraft) {
			throw new Error(`External ACP agent '${normalized.id}' already exists as a reviewed manual config.`);
		}
		const validation = validateExternalAcpAgentConfig(normalized);
		if (!validation.valid) {
			throw new Error(validation.message ?? `External ACP agent '${normalized.id}' is invalid.`);
		}
		await this.writeState({
			version: ExternalAcpAgentConfigVersion,
			agents: [
				...state.agents.filter(candidate => candidate.id !== normalized.id),
				normalized,
			].sort(sortAgents),
		});
		return normalized;
	}

	async markRegistryDraftReviewed(id: string): Promise<ExternalAcpAgentConfig> {
		const normalizedId = sanitizeExternalAcpAgentId(id);
		const state = await this.getState();
		const agent = state.agents.find(candidate => candidate.id === normalizedId);
		if (!agent) {
			throw new Error(`External ACP agent '${normalizedId}' does not exist.`);
		}
		if (!agent.registryDraft) {
			throw new Error(`External ACP agent '${agent.id}' is not a registry draft.`);
		}
		const saved = await this.saveAgent({
			...agent,
			registryDraft: undefined,
			enabled: false,
			trusted: false,
			updatedAt: Date.now(),
		});
		return saved;
	}

	async removeAgent(id: string): Promise<void> {
		const normalizedId = sanitizeExternalAcpAgentId(id);
		const state = await this.getState();
		await this.writeState({
			version: ExternalAcpAgentConfigVersion,
			agents: state.agents.filter(agent => agent.id !== normalizedId),
		});
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		if (enabled) {
			const agent = await this.getAgent(id);
			if (agent?.registryDraft) {
				throw new Error(`External ACP agent '${agent.id}' is a registry draft. Review the manual config before enabling it.`);
			}
		}
		await this.updateAgent(id, agent => ({ ...agent, enabled, applyState: 'pendingRestart', updatedAt: Date.now() }));
	}

	async setTrusted(id: string, trusted: boolean): Promise<void> {
		if (trusted) {
			const agent = await this.getAgent(id);
			if (agent?.registryDraft) {
				throw new Error(`External ACP agent '${agent.id}' is a registry draft. Review the manual config before trusting it.`);
			}
		}
		await this.updateAgent(id, agent => ({ ...agent, trusted, applyState: 'pendingRestart', updatedAt: Date.now() }));
	}

	async updateConnectionStatus(id: string, status: ExternalAcpAgentConnectionStatus): Promise<void> {
		await this.updateAgentPreservingApplyState(id, agent => ({
			...agent,
			connectionStatus: normalizeConnectionStatus(status),
			updatedAt: Date.now(),
		}));
	}

	async clearConnectionStatus(id: string): Promise<void> {
		await this.updateAgentPreservingApplyState(id, agent => {
			const { connectionStatus, ...rest } = agent;
			return {
				...rest,
				updatedAt: Date.now(),
			};
		});
	}

	async getState(): Promise<ExternalAcpAgentRegistry> {
		const resource = getExternalAcpAgentRegistryResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		try {
			if (!await this.fileService.exists(resource)) {
				return { version: ExternalAcpAgentConfigVersion, agents: [] };
			}
			const value = JSON.parse((await this.fileService.readFile(resource)).value.toString()) as Partial<ExternalAcpAgentRegistry>;
			if (value.version !== ExternalAcpAgentConfigVersion || !Array.isArray(value.agents)) {
				return { version: ExternalAcpAgentConfigVersion, agents: [] };
			}
			return {
				version: ExternalAcpAgentConfigVersion,
				agents: value.agents.map(agent => normalizeExternalAcpAgentConfig(agent)).sort(sortAgents),
			};
		} catch (err) {
			this.logService.warn('[External ACP Agents] Failed to read manual agent registry', err);
			return { version: ExternalAcpAgentConfigVersion, agents: [] };
		}
	}

	private async updateAgent(id: string, update: (agent: ExternalAcpAgentConfig) => ExternalAcpAgentConfig): Promise<void> {
		const normalizedId = sanitizeExternalAcpAgentId(id);
		const state = await this.getState();
		const agent = state.agents.find(candidate => candidate.id === normalizedId);
		if (!agent) {
			throw new Error(`External ACP agent '${normalizedId}' does not exist.`);
		}
		await this.saveAgent(update(agent));
	}

	private async updateAgentPreservingApplyState(id: string, update: (agent: ExternalAcpAgentConfig) => ExternalAcpAgentConfig): Promise<void> {
		const normalizedId = sanitizeExternalAcpAgentId(id);
		const state = await this.getState();
		const agent = state.agents.find(candidate => candidate.id === normalizedId);
		if (!agent) {
			throw new Error(`External ACP agent '${normalizedId}' does not exist.`);
		}
		const updated = normalizeExternalAcpAgentConfig(update(agent));
		const validation = validateExternalAcpAgentConfig(updated);
		if (!validation.valid) {
			throw new Error(validation.message ?? `External ACP agent '${updated.id}' is invalid.`);
		}
		await this.writeState({
			version: ExternalAcpAgentConfigVersion,
			agents: [
				...state.agents.filter(candidate => candidate.id !== normalizedId),
				updated,
			].sort(sortAgents),
		});
	}

	private async writeState(state: ExternalAcpAgentRegistry): Promise<void> {
		const resource = getExternalAcpAgentRegistryResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		await this.fileService.createFolder(dirname(resource));
		await this.fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({
			version: ExternalAcpAgentConfigVersion,
			agents: state.agents.map(agent => normalizeExternalAcpAgentConfig(agent)),
		}, undefined, '\t')));
		this.onDidChangeAgentsEmitter.fire();
	}
}

export class ExternalAcpAgentSnapshotService extends Disposable implements IExternalAcpAgentSnapshotService {
	declare readonly _serviceBrand: undefined;

	private readonly writeSequencer = new Sequencer();

	constructor(
		@IExternalAcpAgentRegistryService private readonly registryService: IExternalAcpAgentRegistryService,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.registryService.onDidChangeAgents(() => { void this.writeSnapshot(); }));
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(() => { void this.writeSnapshot(); }));
	}

	writeSnapshot(): Promise<ExternalAcpAgentSnapshot> {
		return this.writeSequencer.queue(() => this.doWriteSnapshot());
	}

	async getSnapshotResource(): Promise<string> {
		return getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome).fsPath;
	}

	private async doWriteSnapshot(): Promise<ExternalAcpAgentSnapshot> {
		const snapshot = toExternalAcpAgentSnapshot(await this.registryService.listAgents());
		const resources = this.getSnapshotResources();
		try {
			const content = VSBuffer.fromString(JSON.stringify(snapshot, undefined, '\t'));
			for (const resource of resources) {
				await this.fileService.createFolder(dirname(resource));
				await this.fileService.writeFile(resource, content);
			}
		} catch (err) {
			this.logService.error('[External ACP Agents] Failed to write manual agent snapshot', err);
			throw err;
		}
		return snapshot;
	}

	private getSnapshotResources(): readonly ReturnType<typeof getExternalAcpAgentSnapshotResourceFromGlobalStorageHome>[] {
		const current = getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		const defaultProfile = getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(this.userDataProfilesService.defaultProfile.globalStorageHome);
		return current.toString() === defaultProfile.toString() ? [current] : [current, defaultProfile];
	}
}

export class UnavailableExternalAcpAgentConnectionTestService implements IExternalAcpAgentConnectionTestService {
	declare readonly _serviceBrand: undefined;

	constructor(@IExternalAcpAgentRegistryService private readonly registryService: IExternalAcpAgentRegistryService) { }

	async testConnection(id: string): Promise<ExternalAcpAgentConnectionStatus> {
		const status = normalizeConnectionStatus({
			kind: 'testFailed',
			source: 'testConnection',
			updatedAt: Date.now(),
			message: 'ACP connection tests are only available in the desktop workbench.',
		});
		await this.registryService.updateConnectionStatus(id, status);
		return status;
	}

	async clearConnectionStatus(id: string): Promise<void> {
		await this.registryService.clearConnectionStatus(id);
	}
}

export function createManualExternalAcpAgent(options: Parameters<typeof createExternalAcpAgentConfig>[0]): ExternalAcpAgentConfig {
	return createExternalAcpAgentConfig(options);
}

function sortAgents(left: ExternalAcpAgentConfig, right: ExternalAcpAgentConfig): number {
	if (left.enabled !== right.enabled) {
		return left.enabled ? -1 : 1;
	}
	return left.displayName.localeCompare(right.displayName);
}
