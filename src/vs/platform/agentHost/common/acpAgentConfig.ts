/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

export const ExternalAcpAgentConfigVersion = 1;
export const ExternalAcpAgentSnapshotVersion = 1;
export const ExternalAcpAgentStorageDirName = 'external-acp-agents';
export const ExternalAcpAgentRegistryFileName = 'manual-agents.json';
export const ExternalAcpAgentSnapshotFileName = 'manual-agents-snapshot.json';

export enum ExternalAcpAgentCwdPolicy {
	None = 'none',
	Workspace = 'workspace',
	Fixed = 'fixed',
}

export enum ExternalAcpAgentCapability {
	Text = 'text',
	Reasoning = 'reasoning',
	Auth = 'auth',
	Tools = 'tools',
	Files = 'files',
	Terminal = 'terminal',
}

export type ExternalAcpAgentApplyState = 'clean' | 'pendingRestart' | 'snapshotWriteFailed' | 'invalidConfig';

export interface ExternalAcpAgentConfig {
	readonly id: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwdPolicy: ExternalAcpAgentCwdPolicy;
	readonly cwd?: string;
	readonly vendorLabel?: string;
	readonly loginHint?: string;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly capabilities: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
	readonly applyState?: ExternalAcpAgentApplyState;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ExternalAcpAgentRegistry {
	readonly version: typeof ExternalAcpAgentConfigVersion;
	readonly agents: readonly ExternalAcpAgentConfig[];
}

export interface ExternalAcpAgentSnapshotAgent {
	readonly id: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwdPolicy: ExternalAcpAgentCwdPolicy;
	readonly cwd?: string;
	readonly vendorLabel?: string;
	readonly loginHint?: string;
	readonly capabilities: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
}

export interface ExternalAcpAgentSnapshot {
	readonly version: typeof ExternalAcpAgentSnapshotVersion;
	readonly updatedAt: number;
	readonly agents: readonly ExternalAcpAgentSnapshotAgent[];
}

export interface ExternalAcpAgentValidationResult {
	readonly valid: boolean;
	readonly message?: string;
}

const AcpAgentIdMaxLength = 80;
const AcpAgentIdPattern = /^[a-z0-9][a-z0-9_.-]*$/;
const EnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getExternalAcpAgentStorageHomeFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(globalStorageHome, ExternalAcpAgentStorageDirName);
}

export function getExternalAcpAgentRegistryResourceFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(getExternalAcpAgentStorageHomeFromGlobalStorageHome(globalStorageHome), ExternalAcpAgentRegistryFileName);
}

export function getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(getExternalAcpAgentStorageHomeFromGlobalStorageHome(globalStorageHome), ExternalAcpAgentSnapshotFileName);
}

export function getExternalAcpAgentSnapshotResourceFromAppSettingsHome(appSettingsHome: URI): URI {
	return getExternalAcpAgentSnapshotResourceFromGlobalStorageHome(joinPath(appSettingsHome, 'globalStorage'));
}

export function sanitizeExternalAcpAgentId(value: string): string {
	const id = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, AcpAgentIdMaxLength);
	return id || 'acp-agent';
}

export function validateExternalAcpAgentId(id: string): ExternalAcpAgentValidationResult {
	if (id.length < 1) {
		return { valid: false, message: 'Agent id is required.' };
	}
	if (id.length > AcpAgentIdMaxLength) {
		return { valid: false, message: `Agent id must be ${AcpAgentIdMaxLength} characters or fewer.` };
	}
	if (!AcpAgentIdPattern.test(id)) {
		return { valid: false, message: 'Agent id may contain lowercase letters, numbers, dots, underscores, and hyphens, and must start with a letter or number.' };
	}
	return { valid: true };
}

export function validateExternalAcpAgentConfig(agent: ExternalAcpAgentConfig): ExternalAcpAgentValidationResult {
	const idValidation = validateExternalAcpAgentId(agent.id);
	if (!idValidation.valid) {
		return idValidation;
	}
	if (!agent.displayName.trim()) {
		return { valid: false, message: 'Display name is required.' };
	}
	if (!agent.command.trim()) {
		return { valid: false, message: 'Command is required.' };
	}
	if (agent.cwdPolicy === ExternalAcpAgentCwdPolicy.Fixed && !agent.cwd?.trim()) {
		return { valid: false, message: 'Fixed cwd policy requires a cwd path.' };
	}
	return { valid: true };
}

export function normalizeExternalAcpAgentConfig(agent: ExternalAcpAgentConfig): ExternalAcpAgentConfig {
	const id = sanitizeExternalAcpAgentId(agent.id);
	const now = Date.now();
	return {
		id,
		displayName: agent.displayName.trim() || id,
		command: agent.command.trim(),
		args: normalizeStringList(agent.args),
		cwdPolicy: normalizeCwdPolicy(agent.cwdPolicy),
		...(agent.cwd?.trim() ? { cwd: agent.cwd.trim() } : {}),
		...(agent.vendorLabel?.trim() ? { vendorLabel: agent.vendorLabel.trim() } : {}),
		...(agent.loginHint?.trim() ? { loginHint: agent.loginHint.trim() } : {}),
		enabled: agent.enabled !== false,
		trusted: agent.trusted === true,
		capabilities: normalizeCapabilities(agent.capabilities),
		...(agent.envVariableNames !== undefined ? { envVariableNames: sanitizeEnvVariableNames(agent.envVariableNames) } : {}),
		...(agent.secretRefs !== undefined ? { secretRefs: normalizeStringList(agent.secretRefs) } : {}),
		applyState: agent.applyState ?? 'pendingRestart',
		createdAt: agent.createdAt ?? now,
		updatedAt: agent.updatedAt ?? now,
	};
}

export function createExternalAcpAgentConfig(options: {
	readonly id?: string;
	readonly displayName: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwdPolicy?: ExternalAcpAgentCwdPolicy;
	readonly cwd?: string;
	readonly vendorLabel?: string;
	readonly loginHint?: string;
	readonly enabled?: boolean;
	readonly trusted?: boolean;
	readonly capabilities?: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
}): ExternalAcpAgentConfig {
	const now = Date.now();
	return normalizeExternalAcpAgentConfig({
		id: options.id ?? options.displayName,
		displayName: options.displayName,
		command: options.command,
		args: options.args ?? [],
		cwdPolicy: options.cwdPolicy ?? ExternalAcpAgentCwdPolicy.Workspace,
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.vendorLabel !== undefined ? { vendorLabel: options.vendorLabel } : {}),
		...(options.loginHint !== undefined ? { loginHint: options.loginHint } : {}),
		enabled: options.enabled ?? false,
		trusted: options.trusted ?? false,
		capabilities: options.capabilities ?? [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
		...(options.envVariableNames !== undefined ? { envVariableNames: options.envVariableNames } : {}),
		...(options.secretRefs !== undefined ? { secretRefs: options.secretRefs } : {}),
		applyState: 'pendingRestart',
		createdAt: now,
		updatedAt: now,
	});
}

export function toExternalAcpAgentSnapshot(agents: readonly ExternalAcpAgentConfig[], updatedAt = Date.now()): ExternalAcpAgentSnapshot {
	return {
		version: ExternalAcpAgentSnapshotVersion,
		updatedAt,
		agents: agents.map(normalizeExternalAcpAgentConfig)
			.filter(agent => agent.enabled && agent.trusted && validateExternalAcpAgentConfig(agent).valid)
			.map(agent => ({
				id: agent.id,
				displayName: agent.displayName,
				command: agent.command,
				args: agent.args,
				cwdPolicy: agent.cwdPolicy,
				...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
				...(agent.vendorLabel !== undefined ? { vendorLabel: agent.vendorLabel } : {}),
				...(agent.loginHint !== undefined ? { loginHint: agent.loginHint } : {}),
				capabilities: safeSnapshotCapabilities(agent.capabilities),
				...(agent.envVariableNames !== undefined ? { envVariableNames: sanitizeEnvVariableNames(agent.envVariableNames) } : {}),
				...(agent.secretRefs !== undefined ? { secretRefs: normalizeStringList(agent.secretRefs) } : {}),
			})),
	};
}

export function sanitizeEnvVariableNames(names: readonly string[]): readonly string[] {
	return Array.from(new Set(names
		.map(name => name.split('=', 1)[0].trim())
		.filter(name => EnvNamePattern.test(name))));
}

export function normalizeCapabilities(capabilities: readonly ExternalAcpAgentCapability[]): readonly ExternalAcpAgentCapability[] {
	const allowed = new Set(Object.values(ExternalAcpAgentCapability));
	const normalized = capabilities.filter(capability => allowed.has(capability));
	return Array.from(new Set(normalized.length ? normalized : [ExternalAcpAgentCapability.Text]));
}

function safeSnapshotCapabilities(capabilities: readonly ExternalAcpAgentCapability[]): readonly ExternalAcpAgentCapability[] {
	return normalizeCapabilities(capabilities).filter(capability =>
		capability !== ExternalAcpAgentCapability.Files
		&& capability !== ExternalAcpAgentCapability.Terminal
		&& capability !== ExternalAcpAgentCapability.Tools
	);
}

function normalizeStringList(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values.map(value => value.trim()).filter(value => value.length > 0)));
}

function normalizeCwdPolicy(policy: ExternalAcpAgentCwdPolicy | undefined): ExternalAcpAgentCwdPolicy {
	switch (policy) {
		case ExternalAcpAgentCwdPolicy.None:
		case ExternalAcpAgentCwdPolicy.Fixed:
		case ExternalAcpAgentCwdPolicy.Workspace:
			return policy;
		default:
			return ExternalAcpAgentCwdPolicy.Workspace;
	}
}
