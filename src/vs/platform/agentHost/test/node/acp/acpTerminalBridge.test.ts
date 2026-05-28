/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalClaim, TerminalInfo, TerminalState } from '../../../common/state/protocol/state.js';
import { CreateTerminalParams } from '../../../common/state/protocol/commands.js';
import { AcpTerminalBridge } from '../../../node/acp/acpTerminalBridge.js';
import { IAgentHostTerminalManager, ICreateAgentHostTerminalOptions, ISendTextOptions } from '../../../node/agentHostTerminalManager.js';

class TestTerminalManager extends Disposable implements IAgentHostTerminalManager {
	declare readonly _serviceBrand: undefined;

	readonly created: { params: CreateTerminalParams; options?: ICreateAgentHostTerminalOptions }[] = [];
	readonly killed: string[] = [];
	readonly disposed: string[] = [];
	private readonly dataEmitters = new Map<string, Emitter<string>>();
	private readonly exitEmitters = new Map<string, Emitter<number>>();
	private readonly contents = new Map<string, string>();
	private readonly exitCodes = new Map<string, number>();

	async createTerminal(params: CreateTerminalParams, options?: ICreateAgentHostTerminalOptions): Promise<void> {
		this.created.push({ params, options });
		this.contents.set(params.channel, '');
		this.dataEmitter(params.channel);
		this.exitEmitter(params.channel);
	}

	writeInput(): void { }
	async sendText(_uri: string, _data: string, _options: ISendTextOptions): Promise<void> { }
	onData(uri: string, cb: (data: string) => void): IDisposable { return this.dataEmitter(uri).event(cb); }
	onExit(uri: string, cb: (exitCode: number) => void): IDisposable { return this.exitEmitter(uri).event(cb); }
	onClaimChanged(): IDisposable { return Disposable.None; }
	onCommandFinished(): IDisposable { return Disposable.None; }
	createAltBufferPromise(_uri: string, _store: DisposableStore): Promise<void> { return new Promise(() => { }); }
	getContent(uri: string): string | undefined { return this.contents.get(uri); }
	getClaim(): TerminalClaim | undefined { return undefined; }
	hasTerminal(uri: string): boolean { return this.contents.has(uri); }
	getExitCode(uri: string): number | undefined { return this.exitCodes.get(uri); }
	supportsCommandDetection(): boolean { return false; }
	killTerminal(uri: string): void { this.killed.push(uri); }
	disposeTerminal(uri: string): void {
		this.disposed.push(uri);
		this.contents.delete(uri);
	}
	getTerminalInfos(): TerminalInfo[] { return []; }
	getTerminalState(): TerminalState | undefined { return undefined; }
	async getDefaultShell(): Promise<string> { return '/bin/bash'; }

	fireData(uri: string, data: string): void {
		this.contents.set(uri, `${this.contents.get(uri) ?? ''}${data}`);
		this.dataEmitter(uri).fire(data);
	}

	fireExit(uri: string, exitCode: number): void {
		this.exitCodes.set(uri, exitCode);
		this.exitEmitter(uri).fire(exitCode);
	}

	private dataEmitter(uri: string): Emitter<string> {
		let emitter = this.dataEmitters.get(uri);
		if (!emitter) {
			emitter = this._register(new Emitter<string>());
			this.dataEmitters.set(uri, emitter);
		}
		return emitter;
	}

	private exitEmitter(uri: string): Emitter<number> {
		let emitter = this.exitEmitters.get(uri);
		if (!emitter) {
			emitter = this._register(new Emitter<number>());
			this.exitEmitters.set(uri, emitter);
		}
		return emitter;
	}
}

suite('AcpTerminalBridge', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let manager: TestTerminalManager;
	let root: URI;
	let store: DisposableStore;
	let bridge: AcpTerminalBridge;

	setup(() => {
		store = disposables.add(new DisposableStore());
		manager = store.add(new TestTerminalManager());
		root = URI.file(join(os.tmpdir(), 'vscode-acp-terminal-root'));
		bridge = store.add(new AcpTerminalBridge(manager, root, URI.parse('ahp-session:/session-1')));
		bridge.setSessionId('session');
	});

	teardown(() => {
		store.dispose();
	});

	test('creates AgentHost terminal with ACP command, args, env, cwd, and retained output', async () => {
		const result = await bridge.create({
			sessionId: 'session',
			command: 'node',
			args: ['-v'],
			env: [{ name: 'NODE_ENV', value: 'test' }],
			cwd: root.fsPath,
			outputByteLimit: 5,
		});

		assert.match(result.terminalId, /^term_/);
		assert.strictEqual(manager.created.length, 1);
		const created = manager.created[0];
		assert.strictEqual(created.params.name, 'node -v');
		assert.strictEqual(created.params.cwd, root.toString());
		assert.strictEqual((created.params.claim as { readonly session: string }).session, 'ahp-session:/session-1');
		assert.strictEqual(created.options?.shell, 'node');
		assert.deepStrictEqual(created.options?.args, ['-v']);
		assert.deepStrictEqual(created.options?.env, { NODE_ENV: 'test' });
		assert.strictEqual(created.options?.shellIntegration, false);
		assert.strictEqual(created.options?.nonInteractive, true);

		manager.fireData(created.params.channel, 'abcdefgh');
		assert.deepStrictEqual(bridge.output({ sessionId: 'session', terminalId: result.terminalId }), {
			output: 'defgh',
			truncated: true,
		});
	});

	test('waits for exit, kills without releasing, then releases logical terminal id', async () => {
		const result = await bridge.create({ sessionId: 'session', command: 'node', cwd: root.fsPath });
		const resource = manager.created[0].params.channel;
		const wait = bridge.waitForExit({ sessionId: 'session', terminalId: result.terminalId });

		assert.strictEqual(bridge.kill({ sessionId: 'session', terminalId: result.terminalId }), null);
		assert.deepStrictEqual(manager.killed, [resource]);
		manager.fireExit(resource, 130);
		assert.deepStrictEqual(await wait, { exitCode: 130, signal: null });
		assert.deepStrictEqual(bridge.output({ sessionId: 'session', terminalId: result.terminalId }), {
			output: '',
			truncated: false,
			exitStatus: { exitCode: 130, signal: null },
		});
		assert.deepStrictEqual(bridge.terminalContent(result.terminalId), {
			resource,
			title: 'node',
		});

		assert.strictEqual(bridge.release({ sessionId: 'session', terminalId: result.terminalId }), null);
		assert.throws(() => bridge.output({ sessionId: 'session', terminalId: result.terminalId }), /not found/);
		assert.deepStrictEqual(bridge.terminalContent(result.terminalId), {
			resource,
			title: 'node',
		});
		bridge.dispose();
		assert.deepStrictEqual(manager.disposed, [resource]);
	});

	test('rejects terminal cwd outside the active workspace', async () => {
		await assert.rejects(() => bridge.create({
			sessionId: 'session',
			command: 'node',
			cwd: join(os.tmpdir(), 'vscode-acp-terminal-outside'),
		}), /outside the active workspace/);
	});
});
