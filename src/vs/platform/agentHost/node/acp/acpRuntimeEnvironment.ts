/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../common/acpAgentConfig.js';
import { acpMissingRuntimeEnvError, acpUnsupportedRuntimeSecretError } from './acpErrors.js';

export interface AcpRuntimeEnvironmentOptions {
	readonly hostEnv?: NodeJS.ProcessEnv;
	readonly workspaceCwd?: string;
}

export interface AcpRuntimeEnvironment {
	readonly cwd?: string;
	readonly env: NodeJS.ProcessEnv;
	readonly redactionValues: readonly string[];
}

const BaseEnvNames = [
	'PATH',
	'Path',
	'HOME',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'TMP',
	'TEMP',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
];

export function resolveAcpRuntimeEnvironment(agent: ExternalAcpAgentSnapshotAgent, options: AcpRuntimeEnvironmentOptions = {}): AcpRuntimeEnvironment {
	if (agent.secretRefs?.length) {
		throw acpUnsupportedRuntimeSecretError(agent.secretRefs[0]);
	}

	const hostEnv = options.hostEnv ?? process.env;
	const env: NodeJS.ProcessEnv = {};
	const redactionValues: string[] = [];

	for (const name of BaseEnvNames) {
		copyEnvValue(hostEnv, env, name, redactionValues);
	}

	for (const name of agent.envVariableNames ?? []) {
		if (!copyEnvValue(hostEnv, env, name, redactionValues)) {
			throw acpMissingRuntimeEnvError(name, 'env');
		}
	}

	return {
		cwd: resolveCwd(agent, options.workspaceCwd),
		env,
		redactionValues,
	};
}

function resolveCwd(agent: ExternalAcpAgentSnapshotAgent, workspaceCwd: string | undefined): string | undefined {
	switch (agent.cwdPolicy) {
		case ExternalAcpAgentCwdPolicy.Fixed:
			return agent.cwd;
		case ExternalAcpAgentCwdPolicy.Workspace:
			return workspaceCwd;
		case ExternalAcpAgentCwdPolicy.None:
		default:
			return undefined;
	}
}

function copyEnvValue(source: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv, name: string, redactionValues: string[]): boolean {
	const actualName = findEnvName(source, name);
	if (!actualName) {
		return false;
	}
	const value = source[actualName];
	if (value === undefined) {
		return false;
	}
	target[actualName] = value;
	if (isSensitiveEnvName(actualName)) {
		redactionValues.push(value);
	}
	return true;
}

function findEnvName(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (env[name] !== undefined) {
		return name;
	}
	const lowerName = name.toLowerCase();
	return Object.keys(env).find(key => key.toLowerCase() === lowerName);
}

function isSensitiveEnvName(name: string): boolean {
	return /(?:token|secret|password|credential|api[_-]?key)/i.test(name);
}
