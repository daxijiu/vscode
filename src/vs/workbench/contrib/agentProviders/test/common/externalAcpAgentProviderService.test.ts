/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, createExternalAcpAgentConfig, getExternalAcpAgentRegistryResourceFromGlobalStorageHome, getExternalAcpAgentSnapshotResourceFromGlobalStorageHome, isExternalAcpLoginHelpUrlAllowed, sanitizeExternalAcpAgentId } from '../../../../../platform/agentHost/common/acpAgentConfig.js';
import { normalizeAcpRegistryAgent } from '../../../../../platform/agentHost/common/acpRegistry.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { ExternalAcpAgentRegistryService, ExternalAcpAgentSnapshotService, UnavailableExternalAcpAgentConnectionTestService } from '../../common/externalAcpAgentProviderService.js';

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
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
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
			loginCommand: snapshot.agents[0].loginCommand,
			loginHelpUrl: snapshot.agents[0].loginHelpUrl,
			capabilities: snapshot.agents[0].capabilities,
			leaksRawEnvValue: snapshotText.includes('should-not-persist') || registryText.includes('should-not-persist'),
		}, {
			snapshotAgents: ['cursor'],
			envNames: ['CURSOR_TOKEN', 'HTTPS_PROXY'],
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
			capabilities: [
				ExternalAcpAgentCapability.Text,
				ExternalAcpAgentCapability.Reasoning,
				ExternalAcpAgentCapability.Tools,
				ExternalAcpAgentCapability.Files,
				ExternalAcpAgentCapability.Terminal,
			],
			leaksRawEnvValue: false,
		});
	});

	test('does not persist suspicious login command or help URL secrets', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'cursor',
			displayName: 'Cursor Agent',
			command: 'cursor-agent',
			args: ['acp'],
			loginCommand: 'cursor-agent login --token super-secret-token',
			loginHelpUrl: 'https://cursor.example/login?api_key=super-secret-token',
			enabled: true,
			trusted: true,
		}));

		const snapshot = await snapshotService.writeSnapshot();
		const registryText = JSON.stringify(await readJson(getExternalAcpAgentRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));
		const snapshotText = JSON.stringify(await readJson(getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			registryAgent: await registryService.getAgent('cursor'),
			snapshotAgent: snapshot.agents[0],
			leaksSecret: registryText.includes('super-secret-token') || snapshotText.includes('super-secret-token'),
		}, {
			registryAgent: {
				id: 'cursor',
				displayName: 'Cursor Agent',
				command: 'cursor-agent',
				args: ['acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				enabled: true,
				trusted: true,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
				applyState: 'pendingRestart',
				createdAt: (await registryService.getAgent('cursor'))?.createdAt,
				updatedAt: (await registryService.getAgent('cursor'))?.updatedAt,
			},
			snapshotAgent: {
				id: 'cursor',
				displayName: 'Cursor Agent',
				command: 'cursor-agent',
				args: ['acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
			},
			leaksSecret: false,
		});
	});

	test('login help URL allowlist only accepts http and https URLs without suspicious secrets', () => {
		assert.deepStrictEqual([
			isExternalAcpLoginHelpUrlAllowed('https://cursor.example/login'),
			isExternalAcpLoginHelpUrlAllowed('http://localhost:1234/login'),
			isExternalAcpLoginHelpUrlAllowed('file:///tmp/login.html'),
			isExternalAcpLoginHelpUrlAllowed('vscode://cursor/login'),
			isExternalAcpLoginHelpUrlAllowed('cursor-login://start'),
			isExternalAcpLoginHelpUrlAllowed('not a url'),
			isExternalAcpLoginHelpUrlAllowed('https://cursor.example/login?token=super-secret-token'),
		], [
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	test('caches redacted connection status without changing apply state or launching ACP processes', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'cursor',
			displayName: 'Cursor Agent',
			command: 'definitely-not-launched-for-status-cache',
			enabled: true,
			trusted: true,
		}));

		await registryService.updateConnectionStatus('cursor', {
			kind: 'authRequired',
			source: 'runtimeError',
			updatedAt: 123,
			message: 'Authentication failed token=super-secret-token',
			authMethods: [{ id: 'fake-token-super-secret-token', label: 'Fake token=super-secret-token' }],
		});

		const agent = await registryService.getAgent('cursor');
		const snapshot = await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			applyState: agent?.applyState,
			status: agent?.connectionStatus,
			snapshotStatus: snapshot.agents[0].connectionStatus,
			leaksStatusSecret: JSON.stringify(await readJson(getExternalAcpAgentRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome))).includes('token=super-secret-token'),
		}, {
			applyState: 'pendingRestart',
			status: {
				kind: 'authRequired',
				source: 'runtimeError',
				updatedAt: 123,
				message: 'Authentication failed token=[redacted]',
				authMethods: [{ id: 'fake-token-[redacted]', label: 'Fake token=[redacted]' }],
			},
			snapshotStatus: {
				kind: 'authRequired',
				source: 'runtimeError',
				updatedAt: 123,
				message: 'Authentication failed token=[redacted]',
				authMethods: [{ id: 'fake-token-[redacted]', label: 'Fake token=[redacted]' }],
			},
			leaksStatusSecret: false,
		});
	});

	test('unavailable connection tester updates cached status only when explicitly called', async () => {
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'cursor',
			displayName: 'Cursor Agent',
			command: 'definitely-not-launched-by-render',
			enabled: true,
			trusted: true,
		}));
		const tester = new UnavailableExternalAcpAgentConnectionTestService(registryService);

		assert.strictEqual((await registryService.getAgent('cursor'))?.connectionStatus, undefined);
		const status = await tester.testConnection('cursor');

		assert.deepStrictEqual({
			statusKind: status.kind,
			cachedKind: (await registryService.getAgent('cursor'))?.connectionStatus?.kind,
		}, {
			statusKind: 'testFailed',
			cachedKind: 'testFailed',
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

	test('creates registry drafts disabled and untrusted without snapshot registration', async () => {
		const registryEntry = createRegistryEntry();

		const draft = await registryService.createRegistryDraft(registryEntry);
		const snapshot = await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			draft: {
				id: draft.id,
				enabled: draft.enabled,
				trusted: draft.trusted,
				registryDraft: draft.registryDraft,
				registryId: draft.registryId,
				registryVersion: draft.registryVersion,
			},
			snapshotAgents: snapshot.agents,
		}, {
			draft: {
				id: 'cursor-agent',
				enabled: false,
				trusted: false,
				registryDraft: true,
				registryId: 'cursor-agent',
				registryVersion: '1.2.3',
			},
			snapshotAgents: [],
		});
	});

	test('rejects registry drafts over an existing reviewed manual config without changing snapshot state', async () => {
		const registryEntry = createRegistryEntry();
		await registryService.saveAgent(createExternalAcpAgentConfig({
			id: 'cursor-agent',
			displayName: 'Reviewed Cursor Agent',
			command: 'cursor-reviewed',
			args: ['acp'],
			enabled: true,
			trusted: true,
		}));
		const snapshotBefore = await snapshotService.writeSnapshot();

		await assert.rejects(() => registryService.createRegistryDraft(registryEntry), /already exists as a reviewed manual config/);
		await assert.rejects(() => registryService.saveRegistryDraft(createExternalAcpAgentConfig({
			id: 'cursor-agent',
			displayName: 'Cursor Agent',
			command: 'npx',
			args: ['-y', '@cursor/agent', 'acp'],
			registryDraft: true,
			registryId: 'cursor-agent',
			registryVersion: '1.2.3',
		})), /already exists as a reviewed manual config/);
		await assert.rejects(() => registryService.markRegistryDraftReviewed('cursor-agent'), /not a registry draft/);
		const snapshotAfter = await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			agent: await registryService.getAgent('cursor-agent'),
			snapshotBefore: snapshotBefore.agents,
			snapshotAfter: snapshotAfter.agents,
		}, {
			agent: {
				id: 'cursor-agent',
				displayName: 'Reviewed Cursor Agent',
				command: 'cursor-reviewed',
				args: ['acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				enabled: true,
				trusted: true,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
				applyState: 'pendingRestart',
				createdAt: (await registryService.getAgent('cursor-agent'))?.createdAt,
				updatedAt: (await registryService.getAgent('cursor-agent'))?.updatedAt,
			},
			snapshotBefore: [{
				id: 'cursor-agent',
				displayName: 'Reviewed Cursor Agent',
				command: 'cursor-reviewed',
				args: ['acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
			}],
			snapshotAfter: [{
				id: 'cursor-agent',
				displayName: 'Reviewed Cursor Agent',
				command: 'cursor-reviewed',
				args: ['acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
			}],
		});
	});

	test('rejects enabling or trusting unreviewed registry drafts', async () => {
		const registryEntry = createRegistryEntry();
		await registryService.createRegistryDraft(registryEntry);

		await assert.rejects(() => registryService.setEnabled('cursor-agent', true), /registry draft/);
		await assert.rejects(() => registryService.setTrusted('cursor-agent', true), /registry draft/);

		assert.deepStrictEqual((await registryService.getAgent('cursor-agent'))?.enabled, false);
	});

	test('allows enable after registry draft manual review clears the draft marker', async () => {
		const registryEntry = createRegistryEntry();
		await registryService.createRegistryDraft(registryEntry);

		await registryService.markRegistryDraftReviewed('cursor-agent');
		await registryService.setTrusted('cursor-agent', true);
		await registryService.setEnabled('cursor-agent', true);
		const snapshot = await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			agent: await registryService.getAgent('cursor-agent'),
			snapshotAgents: snapshot.agents.map(agent => agent.id),
		}, {
			agent: {
				id: 'cursor-agent',
				displayName: 'Cursor Agent',
				command: 'npx',
				args: ['-y', '@cursor/agent', 'acp'],
				cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
				vendorLabel: 'uses your Cursor Agent account',
				loginHint: 'Run cursor-agent login outside VS Code.',
				loginCommand: 'cursor-agent login',
				loginHelpUrl: 'https://cursor.example/login',
				enabled: true,
				trusted: true,
				capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
				registryId: 'cursor-agent',
				registryVersion: '1.2.3',
				applyState: 'pendingRestart',
				createdAt: (await registryService.getAgent('cursor-agent'))?.createdAt,
				updatedAt: (await registryService.getAgent('cursor-agent'))?.updatedAt,
			},
			snapshotAgents: ['cursor-agent'],
		});
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

	function createRegistryEntry() {
		return normalizeAcpRegistryAgent({
			id: 'cursor-agent',
			name: 'Cursor Agent',
			version: '1.2.3',
			description: 'Cursor ACP agent.',
			distribution: {
				npx: {
					package: '@cursor/agent',
					args: ['acp'],
				},
			},
			loginHint: 'Run cursor-agent login outside VS Code.',
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
		})!;
	}
});
