/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { posix, win32 } from '../../../../base/common/path.js';
import { acpProcessNotFoundError, acpUnsupportedCommandError } from './acpErrors.js';

export interface AcpResolvedCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments?: boolean;
	readonly summary: AcpRedactedCommandSummary;
}

export interface AcpRedactedCommandSummary {
	readonly executable: string;
	readonly argCount: number;
	readonly resolvedBy: 'direct' | 'path' | 'cmd-shim';
	readonly shim?: 'cmd.exe';
}

export interface AcpCommandResolverOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}

const DefaultWindowsPathExt = ['.COM', '.EXE', '.BAT', '.CMD'];
const UnsafeCmdArgumentPattern = /["&|<>%!^\r\n]/;
const getPath = (platform: NodeJS.Platform) => platform === 'win32' ? win32 : posix;

export function resolveAcpCommand(command: string, args: readonly string[], options: AcpCommandResolverOptions = {}): AcpResolvedCommand {
	const platform = options.platform ?? process.platform;
	const trimmedCommand = command.trim();
	if (!trimmedCommand) {
		throw acpProcessNotFoundError(command);
	}

	const resolvedCommand = resolveCommandPath(trimmedCommand, options, platform);
	if (platform === 'win32' && isWindowsBatchCommand(resolvedCommand)) {
		validateSafeWindowsBatchInvocation(resolvedCommand, args);
		const cmdExe = findEnvValue(options.env, 'ComSpec') || 'cmd.exe';
		return {
			command: cmdExe,
			args: ['/d', '/s', '/c', buildCmdCommandLine(resolvedCommand, args)],
			windowsVerbatimArguments: true,
			summary: {
				executable: summarizeExecutable(resolvedCommand),
				argCount: args.length,
				resolvedBy: 'cmd-shim',
				shim: 'cmd.exe',
			},
		};
	}

	return {
		command: resolvedCommand,
		args: [...args],
		summary: {
			executable: summarizeExecutable(resolvedCommand),
			argCount: args.length,
			resolvedBy: resolvedCommand === trimmedCommand ? 'direct' : 'path',
		},
	};
}

export function summarizeUnresolvedAcpCommand(command: string, argCount = 0): AcpRedactedCommandSummary {
	return {
		executable: summarizeExecutable(command),
		argCount,
		resolvedBy: 'direct',
	};
}

function resolveCommandPath(command: string, options: AcpCommandResolverOptions, platform: NodeJS.Platform): string {
	const path = getPath(platform);
	if (isExplicitPath(command, platform)) {
		const candidate = path.resolve(options.cwd ?? process.cwd(), command);
		const resolved = resolveExistingCommandCandidate(candidate, options.env, platform);
		if (!resolved) {
			throw acpProcessNotFoundError(command);
		}
		return resolved;
	}

	const pathValue = findEnvValue(options.env, 'PATH') ?? findEnvValue(options.env, 'Path') ?? '';
	for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
		if (!dir) {
			continue;
		}
		const resolved = resolveExistingCommandCandidate(path.join(dir, command), options.env, platform);
		if (resolved) {
			return resolved;
		}
	}

	if (platform !== 'win32') {
		return command;
	}
	throw acpProcessNotFoundError(command);
}

function resolveExistingCommandCandidate(candidate: string, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string | undefined {
	if (isExecutableFile(candidate)) {
		return candidate;
	}
	const path = getPath(platform);
	if (platform !== 'win32' || path.extname(candidate)) {
		return undefined;
	}
	for (const extension of getPathExt(env)) {
		const extended = `${candidate}${extension.toLowerCase()}`;
		if (isExecutableFile(extended)) {
			return extended;
		}
		const upper = `${candidate}${extension.toUpperCase()}`;
		if (upper !== extended && isExecutableFile(upper)) {
			return upper;
		}
	}
	return undefined;
}

function isExplicitPath(command: string, platform: NodeJS.Platform): boolean {
	const path = getPath(platform);
	return path.isAbsolute(command)
		|| command.startsWith('.')
		|| command.includes('/')
		|| (platform === 'win32' && command.includes('\\'));
}

function isExecutableFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function getPathExt(env: NodeJS.ProcessEnv | undefined): readonly string[] {
	const value = findEnvValue(env, 'PATHEXT');
	const extensions = value?.split(';').map(extension => extension.trim()).filter(Boolean);
	return extensions?.length ? extensions : DefaultWindowsPathExt;
}

function isWindowsBatchCommand(command: string): boolean {
	const extension = win32.extname(command).toLowerCase();
	return extension === '.cmd' || extension === '.bat';
}

function buildCmdCommandLine(command: string, args: readonly string[]): string {
	const commandLine = [command, ...args].map(quoteCmdArgument).join(' ');
	return `"${commandLine}"`;
}

function quoteCmdArgument(value: string): string {
	return `"${value}"`;
}

function validateSafeWindowsBatchInvocation(command: string, args: readonly string[]): void {
	const unsafe = [command, ...args].find(value => UnsafeCmdArgumentPattern.test(value));
	if (unsafe !== undefined) {
		throw acpUnsupportedCommandError('cmd-batch-unsafe-metacharacter');
	}
}

function summarizeExecutable(command: string): string {
	const basename = win32.basename(command.trim());
	const redacted = basename || command.trim();
	return redacted.replace(/(?:token|secret|password|api[_-]?key)[^.\s]*/gi, '[redacted]');
}

function findEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
	const source = env ?? process.env;
	return source[name] ?? source[Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase()) ?? ''];
}
