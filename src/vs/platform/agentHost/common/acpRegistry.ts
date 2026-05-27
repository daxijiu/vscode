/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { containsSuspiciousExternalAcpLoginSecret, ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, redactExternalAcpAgentStatusMessage, sanitizeEnvVariableNames } from './acpAgentConfig.js';

export const AcpRegistrySchemaVersion = 1;

export type AcpRegistryAgentSource = 'registry' | 'bundled';
export type AcpRegistryDistributionKind = 'binary' | 'npx' | 'uvx';

export interface AcpRegistryDistribution {
	readonly kind: AcpRegistryDistributionKind;
	readonly packageName?: string;
	readonly command?: string;
	readonly args: readonly string[];
	readonly envVariableNames?: readonly string[];
	readonly archiveUrl?: string;
}

export interface AcpRegistryAgent {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly authors?: readonly string[];
	readonly source: AcpRegistryAgentSource;
	readonly distribution: AcpRegistryDistribution;
	readonly installCommand?: string;
	readonly loginHint?: string;
	readonly loginCommand?: string;
	readonly loginHelpUrl?: string;
	readonly helpUrl?: string;
}

export interface AcpRegistryParseResult {
	readonly version: typeof AcpRegistrySchemaVersion;
	readonly agents: readonly AcpRegistryAgent[];
	readonly ignored: number;
}

export interface AcpRegistryDraftOptions {
	readonly id: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwdPolicy: ExternalAcpAgentCwdPolicy;
	readonly vendorLabel: string;
	readonly loginHint?: string;
	readonly loginCommand?: string;
	readonly loginHelpUrl?: string;
	readonly capabilities: readonly ExternalAcpAgentCapability[];
	readonly envVariableNames?: readonly string[];
	readonly registryId: string;
	readonly registryVersion: string;
}

const RegistryAgentIdPattern = /^[a-z][a-z0-9-]*$/;
const RegistryVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+/;

export function parseAcpRegistry(value: unknown, source: AcpRegistryAgentSource = 'registry'): AcpRegistryParseResult {
	const object = readObject(value);
	const agents = Array.isArray(object?.agents) ? object.agents : [];
	const normalized = agents
		.map(agent => normalizeAcpRegistryAgent(agent, source))
		.filter((agent): agent is AcpRegistryAgent => agent !== undefined);
	return {
		version: AcpRegistrySchemaVersion,
		agents: normalized,
		ignored: agents.length - normalized.length,
	};
}

export function normalizeAcpRegistryAgents(values: readonly unknown[], source: AcpRegistryAgentSource = 'bundled'): readonly AcpRegistryAgent[] {
	return values
		.map(value => normalizeAcpRegistryAgent(value, source))
		.filter((agent): agent is AcpRegistryAgent => agent !== undefined);
}

export function normalizeAcpRegistryAgent(value: unknown, source: AcpRegistryAgentSource = 'registry'): AcpRegistryAgent | undefined {
	const object = readObject(value);
	if (!object) {
		return undefined;
	}

	const id = readTrimmedString(object.id);
	const name = readTrimmedString(object.name);
	const version = readTrimmedString(object.version);
	const description = readTrimmedString(object.description);
	if (!id || !RegistryAgentIdPattern.test(id) || !name || !version || !RegistryVersionPattern.test(version) || !description) {
		return undefined;
	}

	const distribution = normalizeDistribution(object.distribution);
	if (!distribution) {
		return undefined;
	}

	return {
		id,
		name: redactExternalAcpAgentStatusMessage(name),
		version,
		description: redactExternalAcpAgentStatusMessage(description),
		...(readStringArray(object.authors).length ? { authors: readStringArray(object.authors).map(redactExternalAcpAgentStatusMessage) } : {}),
		source,
		distribution,
		...safeCopyField('installCommand', object.installCommand),
		...safeCopyField('loginHint', object.loginHint),
		...safeCopyField('loginCommand', object.loginCommand),
		...safeUrlField('loginHelpUrl', object.loginHelpUrl),
		...safeUrlField('helpUrl', object.helpUrl ?? object.website ?? object.repository),
	};
}

export function getAcpRegistryInstallCommandCopyText(agent: AcpRegistryAgent): string | undefined {
	return safeCommandCopy(agent.installCommand ?? renderInstallCommand(agent.distribution));
}

export function getAcpRegistryLoginCommandCopyText(agent: AcpRegistryAgent): string | undefined {
	return safeCommandCopy(agent.loginCommand);
}

export function toAcpRegistryDraftOptions(agent: AcpRegistryAgent): AcpRegistryDraftOptions | undefined {
	const command = commandForDistribution(agent.distribution);
	if (!command) {
		return undefined;
	}
	return {
		id: agent.id,
		displayName: agent.name,
		command: command.command,
		args: command.args,
		cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
		vendorLabel: `uses your ${agent.name} account`,
		...(agent.loginHint !== undefined ? { loginHint: agent.loginHint } : {}),
		...(agent.loginCommand !== undefined ? { loginCommand: agent.loginCommand } : {}),
		...(agent.loginHelpUrl !== undefined ? { loginHelpUrl: agent.loginHelpUrl } : {}),
		capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
		...(agent.distribution.envVariableNames?.length ? { envVariableNames: agent.distribution.envVariableNames } : {}),
		registryId: agent.id,
		registryVersion: agent.version,
	};
}

function normalizeDistribution(value: unknown): AcpRegistryDistribution | undefined {
	const distribution = readObject(value);
	if (!distribution) {
		return undefined;
	}

	const bundled = readObject(distribution.bundled);
	if (bundled) {
		return normalizeCommandDistribution('binary', bundled);
	}

	const npx = readObject(distribution.npx);
	if (npx) {
		return normalizePackageDistribution('npx', npx);
	}

	const uvx = readObject(distribution.uvx);
	if (uvx) {
		return normalizePackageDistribution('uvx', uvx);
	}

	const binary = readObject(distribution.binary);
	if (binary) {
		const target = Object.values(binary).map(readObject).find((candidate): candidate is { readonly [key: string]: unknown } => candidate !== undefined);
		if (!target) {
			return undefined;
		}
		return normalizeCommandDistribution('binary', target);
	}

	return undefined;
}

function normalizeCommandDistribution(kind: AcpRegistryDistributionKind, value: { readonly [key: string]: unknown }): AcpRegistryDistribution | undefined {
	const command = readTrimmedString(value.cmd ?? value.command);
	const args = readSafeArgs(value.args);
	if (!command || containsSuspiciousExternalAcpLoginSecret(command) || args === undefined) {
		return undefined;
	}
	const archiveUrl = readAllowedUrl(value.archive);
	return {
		kind,
		command,
		args,
		...(sanitizeEnvVariableNames(Object.keys(readObject(value.env) ?? {})).length ? { envVariableNames: sanitizeEnvVariableNames(Object.keys(readObject(value.env) ?? {})) } : {}),
		...(archiveUrl !== undefined ? { archiveUrl } : {}),
	};
}

function normalizePackageDistribution(kind: 'npx' | 'uvx', value: { readonly [key: string]: unknown }): AcpRegistryDistribution | undefined {
	const packageName = readTrimmedString(value.package);
	const args = readSafeArgs(value.args);
	if (!packageName || containsSuspiciousExternalAcpLoginSecret(packageName) || args === undefined) {
		return undefined;
	}
	return {
		kind,
		packageName,
		args,
		...(sanitizeEnvVariableNames(Object.keys(readObject(value.env) ?? {})).length ? { envVariableNames: sanitizeEnvVariableNames(Object.keys(readObject(value.env) ?? {})) } : {}),
	};
}

function commandForDistribution(distribution: AcpRegistryDistribution): { readonly command: string; readonly args: readonly string[] } | undefined {
	switch (distribution.kind) {
		case 'npx':
			return distribution.packageName ? { command: 'npx', args: ['-y', distribution.packageName, ...distribution.args] } : undefined;
		case 'uvx':
			return distribution.packageName ? { command: 'uvx', args: [distribution.packageName, ...distribution.args] } : undefined;
		case 'binary':
			return distribution.command ? { command: distribution.command, args: distribution.args } : undefined;
	}
}

function renderInstallCommand(distribution: AcpRegistryDistribution): string | undefined {
	switch (distribution.kind) {
		case 'npx':
			return distribution.packageName ? joinCommandParts(['npx', '-y', distribution.packageName, ...distribution.args]) : undefined;
		case 'uvx':
			return distribution.packageName ? joinCommandParts(['uvx', distribution.packageName, ...distribution.args]) : undefined;
		case 'binary':
			return distribution.archiveUrl !== undefined ? `Download ${distribution.archiveUrl}` : undefined;
	}
}

function safeCopyField(name: 'installCommand', value: unknown): { readonly installCommand?: string };
function safeCopyField(name: 'loginHint', value: unknown): { readonly loginHint?: string };
function safeCopyField(name: 'loginCommand', value: unknown): { readonly loginCommand?: string };
function safeCopyField(name: 'installCommand' | 'loginHint' | 'loginCommand', value: unknown): { readonly installCommand?: string; readonly loginHint?: string; readonly loginCommand?: string } {
	const stringValue = readTrimmedString(value);
	if (!stringValue || containsSuspiciousExternalAcpLoginSecret(stringValue)) {
		return {};
	}
	if (name === 'installCommand') {
		return { installCommand: stringValue };
	}
	if (name === 'loginHint') {
		return { loginHint: redactExternalAcpAgentStatusMessage(stringValue) };
	}
	return { loginCommand: stringValue };
}

function safeUrlField(name: 'loginHelpUrl', value: unknown): { readonly loginHelpUrl?: string };
function safeUrlField(name: 'helpUrl', value: unknown): { readonly helpUrl?: string };
function safeUrlField(name: 'loginHelpUrl' | 'helpUrl', value: unknown): { readonly loginHelpUrl?: string; readonly helpUrl?: string } {
	const url = readAllowedUrl(value);
	if (url === undefined) {
		return {};
	}
	return name === 'loginHelpUrl' ? { loginHelpUrl: url } : { helpUrl: url };
}

function safeCommandCopy(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && !containsSuspiciousExternalAcpLoginSecret(trimmed) ? trimmed : undefined;
}

function readSafeArgs(value: unknown): readonly string[] | undefined {
	const values = readStringArray(value);
	return values.some(containsSuspiciousExternalAcpLoginSecret) ? undefined : values;
}

function readStringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return Array.from(new Set(value.map(readTrimmedString).filter((item): item is string => item !== undefined)));
}

function readTrimmedString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readAllowedUrl(value: unknown): string | undefined {
	const text = readTrimmedString(value);
	if (!text || containsSuspiciousExternalAcpLoginSecret(text)) {
		return undefined;
	}
	try {
		const uri = URI.parse(text, true);
		if ((uri.scheme === 'https' || uri.scheme === 'http') && uri.authority.length > 0) {
			return text;
		}
	} catch {
		// Invalid registry URLs are ignored rather than making the whole entry fail.
	}
	return undefined;
}

function joinCommandParts(parts: readonly string[]): string {
	return parts.map(part => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(' ');
}

function readObject(value: unknown): { readonly [key: string]: unknown } | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : undefined;
}
