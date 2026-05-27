/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createExternalAcpAgentConfig, ExternalAcpAgentCwdPolicy, ExternalAcpAgentsExecutionEnabledSetting } from '../../../../../platform/agentHost/common/acpAgentConfig.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { toWorkspaceFolder, Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ExternalAcpAgentRegistryService } from '../../common/externalAcpAgentProviderService.js';
import { ExternalAcpAgentConnectionTestService } from '../../electron-browser/externalAcpAgentConnectionTestService.js';

suite('ExternalAcpAgentConnectionTestService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: IFileService;
	let userDataProfileService: IUserDataProfileService;
	let registryService: ExternalAcpAgentRegistryService;
	let testService: ExternalAcpAgentConnectionTestService;
	let configurationService: TestConfigurationService;
	let contextService: TestContextService;

	setup(() => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const currentProfile = toUserDataProfile('acp-test', 'ACP Test', URI.file('/acp-test/User'), URI.file('/acp-test/cache'));
		userDataProfileService = {
			_serviceBrand: undefined,
			currentProfile,
			onDidChangeCurrentProfile: Event.None,
			updateCurrentProfile: async () => { },
		};
		registryService = disposables.add(new ExternalAcpAgentRegistryService(fileService, userDataProfileService, logService));
		configurationService = new TestConfigurationService();
		contextService = new TestContextService();
		testService = disposables.add(new ExternalAcpAgentConnectionTestService(registryService, contextService, configurationService));
	});

	test('execution policy disables explicit test connection without spawning', async () => {
		await registryService.saveAgent(createAgent('disabled-policy', process.execPath, true, true));
		await configurationService.setUserConfiguration(ExternalAcpAgentsExecutionEnabledSetting, false);

		const status = await testService.testConnection('disabled-policy');

		assert.deepStrictEqual({
			status: status.kind,
			cached: (await registryService.getAgent('disabled-policy'))?.connectionStatus?.kind,
		}, {
			status: 'disabled',
			cached: 'disabled',
		});
	});

	test('does not launch disabled or untrusted agents during explicit test', async () => {
		await registryService.saveAgent(createAgent('disabled', 'definitely-not-a-real-acp-command-for-vscode-tests', false, true));

		const status = await testService.testConnection('disabled');

		assert.deepStrictEqual({
			status: status.kind,
			cached: (await registryService.getAgent('disabled'))?.connectionStatus?.kind,
		}, {
			status: 'testFailed',
			cached: 'testFailed',
		});
	});

	test('explicit Test Connection initializes and authenticates when authMethods are explicitly safe', async () => {
		await registryService.saveAgent(createAgent('authenticate-success', process.execPath, true, true));

		const status = await testService.testConnection('authenticate-success');

		assert.deepStrictEqual({
			status: status.kind,
			authMethods: status.authMethods,
			cached: (await registryService.getAgent('authenticate-success'))?.connectionStatus?.kind,
		}, {
			status: 'testSucceeded',
			authMethods: [{ id: 'fake-login', label: 'Fake Login' }],
			cached: 'testSucceeded',
		});
	});

	test('explicit Test Connection does not authenticate unsafe advertised authMethods', async () => {
		await registryService.saveAgent(createAgent('auth-methods', process.execPath, true, true));

		const status = await testService.testConnection('auth-methods');

		assert.deepStrictEqual({
			status: status.kind,
			authMethods: status.authMethods,
			cached: (await registryService.getAgent('auth-methods'))?.connectionStatus?.kind,
		}, {
			status: 'authRequired',
			authMethods: [{ id: 'fake-login', label: 'Fake Login' }],
			cached: 'authRequired',
		});
	});

	test('explicit Test Connection caches auth-required failures with redacted method labels', async () => {
		await registryService.saveAgent(createAgent('authenticate-fail', process.execPath, true, true));

		const status = await testService.testConnection('authenticate-fail');

		assert.deepStrictEqual({
			status: status.kind,
			authMethods: status.authMethods,
			leaksToken: JSON.stringify(status).includes('abc123'),
		}, {
			status: 'authRequired',
			authMethods: [{ id: 'fake-login', label: 'Fake Login' }],
			leaksToken: false,
		});
	});

	test('explicit Test Connection caches authenticate timeout and disposes runtime', async () => {
		await registryService.saveAgent(createAgent('authenticate-timeout', process.execPath, true, true));

		const status = await testService.testConnection('authenticate-timeout');

		assert.strictEqual(status.kind, 'timeout');
	});

	test('explicit Test Connection rejects remote workspace cwd before spawning', async () => {
		contextService.setWorkspace(new Workspace('remote', [toWorkspaceFolder(URI.parse('vscode-remote://ssh-remote+host/workspace'))], false, null, () => true));
		await registryService.saveAgent(createAgent('remote-workspace', 'definitely-not-a-real-acp-command-for-vscode-tests', true, true, ExternalAcpAgentCwdPolicy.Workspace));

		const status = await testService.testConnection('remote-workspace');

		assert.deepStrictEqual({
			status: status.kind,
			message: status.message,
			cached: (await registryService.getAgent('remote-workspace'))?.connectionStatus?.kind,
		}, {
			status: 'disabled',
			message: 'External ACP agents currently support only local file workspaces. Remote, WSL, container, and virtual workspaces are deferred for a later ACP release.',
			cached: 'disabled',
		});
	});

	test('explicit Test Connection uses local workspace cwd resolver for workspace policy', async () => {
		contextService.setWorkspace(new Workspace('local', [toWorkspaceFolder(URI.file(process.cwd()))], false, null, () => true));
		await registryService.saveAgent(createAgent('authenticate-success', process.execPath, true, true, ExternalAcpAgentCwdPolicy.Workspace));

		const status = await testService.testConnection('authenticate-success');

		assert.strictEqual(status.kind, 'testSucceeded');
	});

	function createAgent(mode: string, command: string, enabled: boolean, trusted: boolean, cwdPolicy = ExternalAcpAgentCwdPolicy.None) {
		return createExternalAcpAgentConfig({
			id: mode,
			displayName: `Fake ${mode}`,
			command,
			args: command === process.execPath ? [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, mode] : [],
			cwdPolicy,
			enabled,
			trusted,
		});
	}
});
