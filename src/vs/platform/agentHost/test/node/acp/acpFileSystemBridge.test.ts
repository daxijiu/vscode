/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AcpFileSystemBridge } from '../../../node/acp/acpFileSystemBridge.js';

suite('AcpFileSystemBridge', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let tempDir: string;
	let root: URI;
	let store: DisposableStore;
	let fileService: FileService;

	setup(async () => {
		tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-fs-'));
		root = URI.file(tempDir);
		store = disposables.add(new DisposableStore());
		const logService = new NullLogService();
		fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(logService))));
	});

	teardown(async () => {
		store.dispose();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test('reads text files with ACP line and limit slicing', async () => {
		const target = URI.file(join(tempDir, 'sample.txt'));
		await fileService.writeFile(target, VSBuffer.fromString('one\ntwo\nthree\nfour\n'));
		const bridge = new AcpFileSystemBridge(fileService, { workspaceRoot: root });

		assert.deepStrictEqual(await bridge.readTextFile({
			sessionId: 'session',
			path: target.fsPath,
			line: 2,
			limit: 2,
		}), {
			content: 'two\nthree\n',
		});
	});

	test('writes text files inside the workspace', async () => {
		const target = URI.file(join(tempDir, 'nested', 'created.txt'));
		const bridge = new AcpFileSystemBridge(fileService, { workspaceRoot: root });

		assert.strictEqual(await bridge.writeTextFile({
			sessionId: 'session',
			path: target.fsPath,
			content: 'created by acp\n',
		}), null);

		assert.strictEqual((await fileService.readFile(target)).value.toString(), 'created by acp\n');
	});

	test('rejects paths outside the active workspace', async () => {
		const outside = URI.file(join(os.tmpdir(), `vscode-acp-outside-${Date.now()}.txt`));
		const bridge = new AcpFileSystemBridge(fileService, { workspaceRoot: root });

		await assert.rejects(() => bridge.readTextFile({
			sessionId: 'session',
			path: outside.fsPath,
		}), /outside the active workspace/);
	});
});
