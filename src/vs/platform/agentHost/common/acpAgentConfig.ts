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
export const ExternalAcpAgentsExecutionEnabledSetting = 'externalAcpAgents.execution.enabled';
export const ExternalAcpAgentsExecutionEnabledEnvVar = 'VSCODE_EXTERNAL_ACP_AGENTS_EXECUTION_ENABLED';
export const ExternalAcpAgentsRegistryBrowseEnabledSetting = 'externalAcpAgents.registryBrowse.enabled';
export const ExternalAcpAgentsManagedInstallEnabledSetting = 'externalAcpAgents.managedInstall.enabled';
export const ExternalAcpAgentsToolsEnabledSetting = 'externalAcpAgents.capabilities.tools.enabled';
export const ExternalAcpAgentsFilesEnabledSetting = 'externalAcpAgents.capabilities.files.enabled';
export const ExternalAcpAgentsTerminalEnabledSetting = 'externalAcpAgents.capabilities.terminal.enabled';

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
export type ExternalAcpAgentConnectionStatusKind = 'unknown' | 'disabled' | 'authRequired' | 'loginHelpShown' | 'testSucceeded' | 'testFailed' | 'processNotFound' | 'missingRuntimeEnv' | 'timeout';
export type ExternalAcpAgentConnectionStatusSource = 'cached' | 'userAction' | 'runtimeError' | 'testConnection';

export interface ExternalAcpAgentAuthMethodInfo {
	readonly id?: string;
	readonly label?: string;
}

export interface ExternalAcpAgentConnectionStatus {
	readonly kind: ExternalAcpAgentConnectionStatusKind;
	readonly source: ExternalAcpAgentConnectionStatusSource;
	readonly updatedAt: number;
	readonly message?: string;
	readonly authMethods?: readonly ExternalAcpAgentAuthMethodInfo[];
}

export interface ExternalAcpAgentConfig {
	readonly id: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwdPolicy: ExternalAcpAgentCwdPolicy;
	readonly cwd?: string;
	readonly vendorLabel?: string;
	readonly loginHint?: string;
	readonly loginCommand?: string;
	readonly loginHelpUrl?: string;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly capabilities: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
	readonly registryDraft?: boolean;
	readonly registryId?: string;
	readonly registryVersion?: string;
	readonly applyState?: ExternalAcpAgentApplyState;
	readonly connectionStatus?: ExternalAcpAgentConnectionStatus;
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
	readonly loginCommand?: string;
	readonly loginHelpUrl?: string;
	readonly capabilities: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
	readonly connectionStatus?: ExternalAcpAgentConnectionStatus;
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

export interface ExternalAcpAgentSnapshotPolicy {
	readonly executionEnabled?: boolean;
	readonly allowTools?: boolean;
	readonly allowFiles?: boolean;
	readonly allowTerminal?: boolean;
}

const AcpAgentIdMaxLength = 80;
const AcpAgentIdPattern = /^[a-z0-9][a-z0-9_.-]*$/;
const EnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SuspiciousSecretPattern = /(?:\b(?:bearer|token|api[_-]?key|secret|password)\b\s*[=:]|--(?:token|api-key|apikey|password|secret)\b|\bbearer\s+[A-Za-z0-9._~+/-]+=*)/i;

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
	const registryDraft = agent.registryDraft === true;
	return {
		id,
		displayName: agent.displayName.trim() || id,
		command: agent.command.trim(),
		args: normalizeStringList(agent.args),
		cwdPolicy: normalizeCwdPolicy(agent.cwdPolicy),
		...(agent.cwd?.trim() ? { cwd: agent.cwd.trim() } : {}),
		...(agent.vendorLabel?.trim() ? { vendorLabel: agent.vendorLabel.trim() } : {}),
		...(agent.loginHint?.trim() ? { loginHint: agent.loginHint.trim() } : {}),
		...safePersistedLoginField('loginCommand', agent.loginCommand),
		...safePersistedLoginField('loginHelpUrl', agent.loginHelpUrl),
		enabled: registryDraft ? false : agent.enabled !== false,
		trusted: registryDraft ? false : agent.trusted === true,
		capabilities: normalizeCapabilities(agent.capabilities),
		...(agent.envVariableNames !== undefined ? { envVariableNames: sanitizeEnvVariableNames(agent.envVariableNames) } : {}),
		...(agent.secretRefs !== undefined ? { secretRefs: normalizeStringList(agent.secretRefs) } : {}),
		...(registryDraft ? { registryDraft: true } : {}),
		...(agent.registryId?.trim() ? { registryId: sanitizeExternalAcpAgentId(agent.registryId) } : {}),
		...(agent.registryVersion?.trim() ? { registryVersion: agent.registryVersion.trim() } : {}),
		applyState: agent.applyState ?? 'pendingRestart',
		...(agent.connectionStatus !== undefined ? { connectionStatus: normalizeConnectionStatus(agent.connectionStatus) } : {}),
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
	readonly loginCommand?: string;
	readonly loginHelpUrl?: string;
	readonly enabled?: boolean;
	readonly trusted?: boolean;
	readonly capabilities?: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly secretRefs?: readonly string[];
	readonly registryDraft?: boolean;
	readonly registryId?: string;
	readonly registryVersion?: string;
	readonly connectionStatus?: ExternalAcpAgentConnectionStatus;
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
		...(options.loginCommand !== undefined ? { loginCommand: options.loginCommand } : {}),
		...(options.loginHelpUrl !== undefined ? { loginHelpUrl: options.loginHelpUrl } : {}),
		enabled: options.enabled ?? false,
		trusted: options.trusted ?? false,
		capabilities: options.capabilities ?? [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
		...(options.envVariableNames !== undefined ? { envVariableNames: options.envVariableNames } : {}),
		...(options.secretRefs !== undefined ? { secretRefs: options.secretRefs } : {}),
		...(options.registryDraft !== undefined ? { registryDraft: options.registryDraft } : {}),
		...(options.registryId !== undefined ? { registryId: options.registryId } : {}),
		...(options.registryVersion !== undefined ? { registryVersion: options.registryVersion } : {}),
		...(options.connectionStatus !== undefined ? { connectionStatus: options.connectionStatus } : {}),
		applyState: 'pendingRestart',
		createdAt: now,
		updatedAt: now,
	});
}

export function createRegistryDraftExternalAcpAgentConfig(options: Omit<Parameters<typeof createExternalAcpAgentConfig>[0], 'enabled' | 'trusted' | 'registryDraft'> & {
	readonly registryId: string;
	readonly registryVersion: string;
}): ExternalAcpAgentConfig {
	return createExternalAcpAgentConfig({
		...options,
		enabled: false,
		trusted: false,
		registryDraft: true,
	});
}

export function toExternalAcpAgentSnapshot(agents: readonly ExternalAcpAgentConfig[], updatedAt = Date.now(), policy: ExternalAcpAgentSnapshotPolicy = {}): ExternalAcpAgentSnapshot {
	if (policy.executionEnabled === false) {
		return {
			version: ExternalAcpAgentSnapshotVersion,
			updatedAt,
			agents: [],
		};
	}
	return {
		version: ExternalAcpAgentSnapshotVersion,
		updatedAt,
		agents: agents.map(normalizeExternalAcpAgentConfig)
			.filter(agent => !agent.registryDraft && agent.enabled && agent.trusted && validateExternalAcpAgentConfig(agent).valid)
			.map(agent => ({
				id: agent.id,
				displayName: agent.displayName,
				command: agent.command,
				args: agent.args,
				cwdPolicy: agent.cwdPolicy,
				...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
				...(agent.vendorLabel !== undefined ? { vendorLabel: agent.vendorLabel } : {}),
				...(agent.loginHint !== undefined ? { loginHint: agent.loginHint } : {}),
				...(agent.loginCommand !== undefined ? { loginCommand: agent.loginCommand } : {}),
				...(agent.loginHelpUrl !== undefined ? { loginHelpUrl: agent.loginHelpUrl } : {}),
				capabilities: safeSnapshotCapabilities(agent.capabilities, policy),
				...(agent.envVariableNames !== undefined ? { envVariableNames: sanitizeEnvVariableNames(agent.envVariableNames) } : {}),
				...(agent.secretRefs !== undefined ? { secretRefs: normalizeStringList(agent.secretRefs) } : {}),
				...(agent.connectionStatus !== undefined ? { connectionStatus: normalizeConnectionStatus(agent.connectionStatus) } : {}),
			})),
	};
}

export function normalizeConnectionStatus(status: ExternalAcpAgentConnectionStatus): ExternalAcpAgentConnectionStatus {
	return {
		kind: normalizeConnectionStatusKind(status.kind),
		source: normalizeConnectionStatusSource(status.source),
		updatedAt: typeof status.updatedAt === 'number' ? status.updatedAt : Date.now(),
		...(status.message?.trim() ? { message: redactExternalAcpAgentStatusMessage(status.message.trim()) } : {}),
		...(status.authMethods !== undefined ? { authMethods: normalizeAuthMethods(status.authMethods) } : {}),
	};
}

export function redactExternalAcpAgentStatusMessage(message: string): string {
	let redacted = message.replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)\s*=\s*)[^\s]+/gi, '$1[redacted]');
	redacted = redacted.replace(/(--(?:api-key|apikey|token|secret|password)(?:=|\s+))[^\s]+/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)[_-])[^\s,;]+/gi, '$1[redacted]');
	redacted = redacted.replace(/((?:api[_-]?key|token|secret|password)["']?\s*:\s*["'])[^\s"']+/gi, '$1[redacted]');
	return redacted;
}

export function containsSuspiciousExternalAcpLoginSecret(value: string | undefined): boolean {
	return typeof value === 'string' && SuspiciousSecretPattern.test(value);
}

export function isExternalAcpLoginHelpUrlAllowed(value: string | undefined): boolean {
	if (!value?.trim() || containsSuspiciousExternalAcpLoginSecret(value)) {
		return false;
	}
	try {
		const uri = URI.parse(value.trim(), true);
		return (uri.scheme === 'https' || uri.scheme === 'http') && uri.authority.length > 0;
	} catch {
		return false;
	}
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

function safeSnapshotCapabilities(capabilities: readonly ExternalAcpAgentCapability[], policy: ExternalAcpAgentSnapshotPolicy): readonly ExternalAcpAgentCapability[] {
	const filtered = normalizeCapabilities(capabilities).filter(capability => {
		switch (capability) {
			case ExternalAcpAgentCapability.Tools:
				return policy.allowTools !== false;
			case ExternalAcpAgentCapability.Files:
				return policy.allowFiles !== false;
			case ExternalAcpAgentCapability.Terminal:
				return policy.allowTerminal !== false;
			default:
				return true;
		}
	});
	return filtered.length ? filtered : [ExternalAcpAgentCapability.Text];
}

function normalizeStringList(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values.map(value => value.trim()).filter(value => value.length > 0)));
}

function safePersistedLoginField(name: 'loginCommand', value: string | undefined): { readonly loginCommand?: string };
function safePersistedLoginField(name: 'loginHelpUrl', value: string | undefined): { readonly loginHelpUrl?: string };
function safePersistedLoginField(name: 'loginCommand' | 'loginHelpUrl', value: string | undefined): { readonly loginCommand?: string; readonly loginHelpUrl?: string } {
	const trimmed = value?.trim();
	if (!trimmed || containsSuspiciousExternalAcpLoginSecret(trimmed)) {
		return {};
	}
	if (name === 'loginCommand') {
		return { loginCommand: trimmed };
	}
	return { loginHelpUrl: trimmed };
}

function normalizeAuthMethods(methods: readonly ExternalAcpAgentAuthMethodInfo[]): readonly ExternalAcpAgentAuthMethodInfo[] {
	return methods
		.map(method => ({
			...(method.id?.trim() ? { id: redactExternalAcpAgentStatusMessage(method.id.trim()) } : {}),
			...(method.label?.trim() ? { label: redactExternalAcpAgentStatusMessage(method.label.trim()) } : {}),
		}))
		.filter(method => method.id !== undefined || method.label !== undefined)
		.slice(0, 8);
}

function normalizeConnectionStatusKind(kind: ExternalAcpAgentConnectionStatusKind): ExternalAcpAgentConnectionStatusKind {
	switch (kind) {
		case 'authRequired':
		case 'disabled':
		case 'loginHelpShown':
		case 'testSucceeded':
		case 'testFailed':
		case 'processNotFound':
		case 'missingRuntimeEnv':
		case 'timeout':
			return kind;
		case 'unknown':
		default:
			return 'unknown';
	}
}

function normalizeConnectionStatusSource(source: ExternalAcpAgentConnectionStatusSource): ExternalAcpAgentConnectionStatusSource {
	switch (source) {
		case 'userAction':
		case 'runtimeError':
		case 'testConnection':
			return source;
		case 'cached':
		default:
			return 'cached';
	}
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
