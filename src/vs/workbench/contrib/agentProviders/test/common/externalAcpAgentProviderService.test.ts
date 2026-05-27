/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, createExternalAcpAgentConfig, getExternalAcpAgentRegistryResourceFromGlobalStorageHome, getExternalAcpAgentSnapshotResourceFromGlobalStorageHome, sanitizeExternalAcpAgentId } from '../../../../../platform/agentHost/common/acpAgentConfig.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { ExternalAcpAgentRegistryService, ExternalAcpAgentSnapshotService } from '../../common/externalAcpAgentProviderService.js';

suite('externalAcpAgentProviderService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: IFileService;
	let userDataProfileService: IUserDataProfileService;
	let userDataProfilesService: IUserDataProfilesService;
	let registryService: ExternalAcpAgentRegistryService;
	let snapshotService: ExternalAcpAgentSnapshotService;

	setup(() => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const currentProfile = toUserDataProfile('acp-test', 'ACP Test', URI.file('/acp-test/User'), URI.file('/acp-test/cache'));
		const defaultProfile = toUserDataProfile('default', 'Default', URI.file('/acp-test/DefaultUser'), URI.file('/acp-test/cache-default'));
		userDataProfileService = {
			_serviceBrand: undefined,
			currentProfile,
			onDidChangeCurrentProfile: Event.None,
			updateCurrentProfile: async () => { },
		};
		userDataProfilesService = {
			_serviceBrand: undefined,
			profilesHome: URI.file('/acp-test/profiles'),
			defaultProfile,
			onDidChangeProfiles: Event.None,
			profiles: [defaultProfile, currentProfile],
			onDidResetWorkspaces: Event.None,
			createNamedProfile: async () => currentProfile,
			createTransientProfile: async () => currentProfile,
			createProfile: async () => currentProfile,
			updateProfile: async profile => profile,
			removeProfile: async () => { },
			setProfileForWorkspace: async () => { },
			resetWorkspaces: async () => { },
			cleanUp: async () => { },
			cleanUpTransientProfiles: async () => { },
		};

		registryService = disposables.add(new ExternalAcpAgentRegistryService(fileService, userDataProfileService, logService));
		snapshotService = disposables.add(new ExternalAcpAgentSnapshotService(registryService, fileService, userDataProfileService, userDataProfilesService, logService));
	});

	test('normalizes provider ids for AgentHost-safe ACP agent config', async () => {
		const saved = await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'Cursor Agent!!',
			displayName: 'Cursor Agent',
			command: 'cursor-agent',
			args: ['acp'],
		}));

		assert.deepStrictEqual({
			id: saved.id,
			sanitized: sanitizeExternalAcpAgentId('Cursor Agent!!'),
			agents: (await registryService.listAgents()).map(agent => agent.id),
		}, {
			id: 'cursor-agent',
			sanitized: 'cursor-agent',
			agents: ['cursor-agent'],
		});
	});

	test('writes secret-free snapshot and omits disabled or untrusted ACP agents', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'cursor',
			displayName: 'Cursor Agent',
			command: 'cursor-agent',
			args: ['acp', '--flag'],
			vendorLabel: 'uses your Cursor subscription',
			loginHint: 'Run cursor-agent login in your terminal.',
			enabled: true,
			trusted: true,
			capabilities: [
				ExternalAcpAgentCapability.Text,
				ExternalAcpAgentCapability.Reasoning,
				ExternalAcpAgentCapability.Tools,
				ExternalAcpAgentCapability.Files,
				ExternalAcpAgentCapability.Terminal,
			],
			envVariableNames: ['CURSOR_TOKEN=should-not-persist', 'HTTPS_PROXY'],
			secretRefs: ['secret://cursor/auth'],
		}));
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'disabled',
			displayName: 'Disabled Agent',
			command: 'disabled-agent',
			enabled: false,
			trusted: true,
		}));
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'untrusted',
			displayName: 'Untrusted Agent',
			command: 'untrusted-agent',
			enabled: true,
			trusted: false,
		}));

		const snapshot = await snapshotService.writeSnapshot();
		const registryText = JSON.stringify(await readJson(getExternalAcpAgentRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));
		const snapshotText = JSON.stringify(await readJson(getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			snapshotAgents: snapshot.agents.map(agent => agent.id),
			envNames: snapshot.agents[0].envVariableNames,
			capabilities: snapshot.agents[0].capabilities,
			leaksRawEnvValue: snapshotText.includes('should-not-persist') || registryText.includes('should-not-persist'),
		}, {
			snapshotAgents: ['cursor'],
			envNames: ['CURSOR_TOKEN', 'HTTPS_PROXY'],
			capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
			leaksRawEnvValue: false,
		});
	});

	test('updates enable and trust state without launching ACP processes', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'codebuddy',
			displayName: 'CodeBuddy Code',
			command: 'codebuddy',
			args: ['--acp'],
			enabled: false,
			trusted: false,
		}));

		await registryService.setEnabled('codebuddy', true);
		await registryService.setTrusted('codebuddy', true);

		assert.deepStrictEqual((await registryService.listAgents()).map(agent => ({
			id: agent.id,
			enabled: agent.enabled,
			trusted: agent.trusted,
			applyState: agent.applyState,
		})), [{
			id: 'codebuddy',
			enabled: true,
			trusted: true,
			applyState: 'pendingRestart',
		}]);
	});

	test('writes a default-profile ACP snapshot mirror for AgentHost consumption', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'claude-acp',
			displayName: 'Claude ACP',
			command: 'claude',
			args: ['acp'],
			cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
			enabled: true,
			trusted: true,
		}));

		await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			currentExists: await fileService.exists(getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)),
			defaultExists: await fileService.exists(getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(userDataProfilesService.defaultProfile.globalStorageHome)),
		}, {
			currentExists: true,
			defaultExists: true,
		});
	});

	async function readJson(resource: URI): Promise<object> {
		return JSON.parse((await fileService.readFile(resource)).value.toString()) as object;
	}
});
