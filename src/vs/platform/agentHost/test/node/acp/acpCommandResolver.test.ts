/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AcpError, AcpErrorCode } from '../../../node/acp/acpErrors.js';
import { resolveAcpCommand } from '../../../node/acp/acpCommandResolver.js';

suite('acpCommandResolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves Windows PATH and PATHEXT commands', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-command-'));
		try {
			const commandPath = join(tempDir, 'fake-agent.CMD');
			await fs.writeFile(commandPath, '@echo off\r\n');

			const resolved = resolveAcpCommand('fake-agent', ['acp'], {
				env: { PATH: tempDir, PATHEXT: '.CMD;.EXE' },
				platform: 'win32',
			});

			assert.deepStrictEqual({
				command: resolved.command.toLowerCase(),
				argsPrefix: resolved.args.slice(0, 3),
				summary: resolved.summary,
			}, {
				command: 'cmd.exe',
				argsPrefix: ['/d', '/s', '/c'],
				summary: {
					executable: 'fake-agent.cmd',
					argCount: 1,
					resolvedBy: 'cmd-shim',
					shim: 'cmd.exe',
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('uses explicit cmd.exe shim for cmd and bat files with spaces in paths', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode acp command '));
		try {
			const commandPath = join(tempDir, 'fake agent.bat');
			await fs.writeFile(commandPath, '@echo off\r\n');

			const resolved = resolveAcpCommand(commandPath, ['--profile', 'safe profile'], {
				env: { PATH: '', PATHEXT: '.BAT;.CMD' },
				platform: 'win32',
			});

			assert.deepStrictEqual({
				command: resolved.command.toLowerCase(),
				argsPrefix: resolved.args.slice(0, 3),
				commandLineHasQuotedSpacePath: resolved.args[3].includes(`"${commandPath}"`),
				commandLineHasQuotedSpaceArg: resolved.args[3].includes('"safe profile"'),
				summary: resolved.summary,
			}, {
				command: 'cmd.exe',
				argsPrefix: ['/d', '/s', '/c'],
				commandLineHasQuotedSpacePath: true,
				commandLineHasQuotedSpaceArg: true,
				summary: {
					executable: 'fake agent.bat',
					argCount: 2,
					resolvedBy: 'cmd-shim',
					shim: 'cmd.exe',
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('rejects cmd and bat files when command or args contain cmd metacharacters', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-command-'));
		try {
			const commandPath = join(tempDir, 'fake-agent.cmd');
			const unsafeCommandPath = join(tempDir, 'bad&agent.cmd');
			await fs.writeFile(commandPath, '@echo off\r\n');
			await fs.writeFile(unsafeCommandPath, '@echo off\r\n');

			for (const unsafeArg of ['quoted"value', 'a&b', 'a|b', 'a<b', 'a>b', 'token=%SECRET%', 'bang!value', 'line\nbreak']) {
				assert.throws(() => resolveAcpCommand(commandPath, [unsafeArg], {
					env: { PATH: '', PATHEXT: '.CMD' },
					platform: 'win32',
				}), (err: unknown) => err instanceof AcpError && err.acpCode === AcpErrorCode.UnsupportedCommand);
			}
			assert.throws(() => resolveAcpCommand(unsafeCommandPath, ['safe arg'], {
				env: { PATH: '', PATHEXT: '.CMD' },
				platform: 'win32',
			}), (err: unknown) => err instanceof AcpError
				&& err.acpCode === AcpErrorCode.UnsupportedCommand
				&& err.message.includes('Prefer a .exe command or a wrapper with safe arguments'));
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('spawns exe files directly without a shell shim', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-command-'));
		try {
			const commandPath = join(tempDir, 'fake-agent.exe');
			await fs.writeFile(commandPath, '');

			const resolved = resolveAcpCommand(commandPath, ['acp'], {
				env: { PATH: '' },
				platform: 'win32',
			});

			assert.deepStrictEqual({
				command: resolved.command,
				args: resolved.args,
				summary: resolved.summary,
			}, {
				command: commandPath,
				args: ['acp'],
				summary: {
					executable: 'fake-agent.exe',
					argCount: 1,
					resolvedBy: 'direct',
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('reports missing Windows commands without shell fallback', () => {
		assert.throws(() => resolveAcpCommand('definitely-not-real-acp-command', [], {
			env: { PATH: '', PATHEXT: '.EXE;.CMD' },
			platform: 'win32',
		}), (err: unknown) => err instanceof AcpError && err.acpCode === AcpErrorCode.ProcessNotFound);
	});
});
