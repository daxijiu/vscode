/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../log/common/log.js';
import { createExternalAcpAgentConfig, ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotVersion, getExternalAcpAgentSnapshotResourceFromGlobalStorageHome, toExternalAcpAgentSnapshot } from '../../../common/acpAgentConfig.js';
import { AcpAgentSnapshotLoader } from '../../../node/acp/acpAgentSnapshotLoader.js';

suite('AcpAgentSnapshotLoader', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let resource: URI;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		resource = getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(URI.file('/profile/globalStorage'));
	});

	test('loads only enabled, trusted, valid manual snapshot agents', async () => {
		const snapshot = toExternalAcpAgentSnapshot([
			createExternalAcpAgentConfig({ id: 'cursor', displayName: 'Cursor Agent', command: 'cursor-agent', args: ['acp'], trusted: true, enabled: true, vendorLabel: 'Cursor' }),
			createExternalAcpAgentConfig({ id: 'disabled', displayName: 'Disabled', command: 'disabled', trusted: true, enabled: false }),
			createExternalAcpAgentConfig({ id: 'untrusted', displayName: 'Untrusted', command: 'untrusted', trusted: false, enabled: true }),
			createExternalAcpAgentConfig({ id: 'invalid', displayName: 'Invalid', command: '', trusted: true, enabled: true }),
		], 123);
		await writeJson(resource, snapshot);

		assert.deepStrictEqual(await new AcpAgentSnapshotLoader(fileService, new NullLogService()).load(resource), [{
			id: 'cursor',
			displayName: 'Cursor Agent',
			command: 'cursor-agent',
			args: ['acp'],
			cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
			vendorLabel: 'Cursor',
			capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
		}]);
	});

	test('bad snapshot inputs return empty agents', async () => {
		const loader = new AcpAgentSnapshotLoader(fileService, new NullLogService());

		assert.deepStrictEqual(await loader.load(resource), []);
		await writeJson(resource, { version: ExternalAcpAgentSnapshotVersion + 1, agents: [] });
		assert.deepStrictEqual(await loader.load(resource), []);
		await fileService.writeFile(resource, VSBuffer.fromString('not json'));
		assert.deepStrictEqual(await loader.load(resource), []);
	});

	test('skips malformed and invalid agent entries inside an otherwise valid snapshot', async () => {
		await writeJson(resource, {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt: 123,
			agents: [
				{ id: 'good', displayName: 'Good', command: 'good', args: [], cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace, capabilities: [ExternalAcpAgentCapability.Text] },
				null,
				'not an agent',
				{ id: 'bad', displayName: 'Bad', command: '', args: [], cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace, capabilities: [ExternalAcpAgentCapability.Text] },
			],
		});

		assert.deepStrictEqual(
			(await new AcpAgentSnapshotLoader(fileService, new NullLogService()).load(resource)).map(agent => agent.id),
			['good'],
		);
	});

	async function writeJson(target: URI, value: unknown): Promise<void> {
		await fileService.createFolder(dirname(target));
		await fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(value)));
	}
});
