/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../log/common/log.js';
import { IAgent } from '../../../common/agentService.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotVersion, getExternalAcpAgentSnapshotResourceFromGlobalStorageHome } from '../../../common/acpAgentConfig.js';
import { registerAcpAgentsFromSnapshot } from '../../../node/acp/acpAgentProviderRegistration.js';

suite('registerAcpAgentsFromSnapshot', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let resource: URI;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		resource = getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(URI.file('/profile/globalStorage'));
	});

	test('registers snapshot agents without starting their commands and skips duplicate provider ids', async () => {
		await writeJson(resource, {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt: 123,
			agents: [
				createSnapshotAgent({ id: 'Cursor Agent', displayName: 'Cursor Agent', vendorLabel: 'Cursor', command: 'definitely-not-real' }),
				createSnapshotAgent({ id: 'cursor-agent', displayName: 'Cursor Duplicate', vendorLabel: 'Cursor', command: 'also-not-real' }),
				createSnapshotAgent({ id: 'CodeBuddy Code', displayName: 'CodeBuddy Code', vendorLabel: 'CodeBuddy', command: 'not-real-codebuddy' }),
			],
		});
		const service = new CapturingAgentService();

		assert.strictEqual(await registerAcpAgentsFromSnapshot({
			agentService: service,
			snapshotResource: resource,
			fileService,
			logService: new NullLogService(),
			disposables: disposables.add(new DisposableStore()),
		}), 2);

		assert.deepStrictEqual(
			service.providers.map(provider => provider.getDescriptor()),
			[
				{ provider: 'acp-cursor-agent', displayName: 'Cursor Agent', description: 'Uses your Cursor subscription/account.' },
				{ provider: 'acp-codebuddy-code', displayName: 'CodeBuddy Code', description: 'Uses your CodeBuddy subscription/account.' },
			],
		);
	});

	test('provider registration failures are isolated', async () => {
		await writeJson(resource, {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt: 123,
			agents: [
				createSnapshotAgent({ id: 'cursor', displayName: 'Cursor Agent' }),
				createSnapshotAgent({ id: 'codebuddy', displayName: 'CodeBuddy Code' }),
			],
		});
		const service = new CapturingAgentService('acp-cursor');

		assert.strictEqual(await registerAcpAgentsFromSnapshot({
			agentService: service,
			snapshotResource: resource,
			fileService,
			logService: new NullLogService(),
			disposables: disposables.add(new DisposableStore()),
		}), 1);
		assert.deepStrictEqual(service.providers.map(provider => provider.id), ['acp-codebuddy']);
	});

	test('execution disabled gate prevents snapshot registration', async () => {
		await writeJson(resource, {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt: 123,
			agents: [
				createSnapshotAgent({ id: 'cursor', displayName: 'Cursor Agent' }),
			],
		});
		const service = new CapturingAgentService();

		assert.strictEqual(await registerAcpAgentsFromSnapshot({
			agentService: service,
			snapshotResource: resource,
			fileService,
			logService: new NullLogService(),
			disposables: disposables.add(new DisposableStore()),
			executionEnabled: false,
		}), 0);
		assert.deepStrictEqual(service.providers, []);
	});


	test('registers valid snapshot agents when malformed entries are present', async () => {
		await writeJson(resource, {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt: 123,
			agents: [
				null,
				42,
				createSnapshotAgent({ id: 'cursor', displayName: 'Cursor Agent', vendorLabel: 'Cursor' }),
				{ id: 'bad', displayName: 'Bad', command: '', args: [], cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace, capabilities: [ExternalAcpAgentCapability.Text] },
			],
		});
		const service = new CapturingAgentService();

		assert.strictEqual(await registerAcpAgentsFromSnapshot({
			agentService: service,
			snapshotResource: resource,
			fileService,
			logService: new NullLogService(),
			disposables: disposables.add(new DisposableStore()),
		}), 1);
		assert.deepStrictEqual(service.providers.map(provider => provider.id), ['acp-cursor']);
	});

	async function writeJson(target: URI, value: unknown): Promise<void> {
		await fileService.createFolder(dirname(target));
		await fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(value)));
	}
});

class CapturingAgentService {
	readonly providers: IAgent[] = [];

	constructor(private readonly failProviderId?: string) { }

	registerProvider(provider: IAgent): void {
		if (provider.id === this.failProviderId) {
			throw new Error('duplicate');
		}
		this.providers.push(provider);
	}
}

function createSnapshotAgent(overrides: { readonly id: string; readonly displayName: string; readonly vendorLabel?: string; readonly command?: string }) {
	return {
		id: overrides.id,
		displayName: overrides.displayName,
		command: overrides.command ?? 'agent',
		args: ['acp'],
		cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
		...(overrides.vendorLabel ? { vendorLabel: overrides.vendorLabel } : {}),
		capabilities: [ExternalAcpAgentCapability.Text],
	};
}
