/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { IAgentModelInfo, AgentProvider } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { SessionConfigPropertySchema, SessionConfigSchema, SessionConfigValueItem } from '../../common/state/protocol/commands.js';
import type { AcpInitializeResult, AcpJsonObject, AcpJsonValue } from './acpProtocol.js';

export interface AcpNegotiatedCapabilities {
	readonly models: readonly AcpNegotiatedModel[];
	readonly sessionConfigSchema: SessionConfigSchema;
	readonly sessionConfigDefaults: Readonly<Record<string, unknown>>;
	readonly sessionConfigCompletions: Readonly<Record<string, readonly SessionConfigValueItem[]>>;
	readonly restore: AcpRestoreCapabilityState;
}

export interface AcpNegotiatedModel {
	readonly id: string;
	readonly name: string;
	readonly maxContextWindow?: number;
	readonly supportsVision: boolean;
	readonly configSchema?: SessionConfigSchema;
}

export interface AcpRestoreCapabilityState {
	readonly canList: boolean;
	readonly canLoad: boolean;
	readonly canRestore: boolean;
}

export const EmptyAcpSessionConfigSchema: SessionConfigSchema = Object.freeze({
	type: 'object',
	properties: Object.freeze({}),
});

export const EmptyAcpNegotiatedCapabilities: AcpNegotiatedCapabilities = Object.freeze({
	models: Object.freeze([]),
	sessionConfigSchema: EmptyAcpSessionConfigSchema,
	sessionConfigDefaults: Object.freeze({}),
	sessionConfigCompletions: Object.freeze({}),
	restore: Object.freeze({ canList: false, canLoad: false, canRestore: false }),
});

const SecretLikeValuePattern = /\b(?:sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_]{6,}|(?:api[_-]?key|token|bearer|password|secret)\s*[:=]\s*[^\s,;]+)/gi;

export function normalizeAcpCapabilities(result: AcpInitializeResult): AcpNegotiatedCapabilities {
	const sources = capabilitySources(result);
	const models = normalizeModels(sources);
	const schema = normalizeSessionConfigSchema(sources);
	const completions = normalizeSessionConfigCompletions(sources, schema.schema);
	const restore = normalizeRestoreCapabilities(sources);

	if (!models.length && !Object.keys(schema.schema.properties).length && !Object.keys(completions).length && !restore.canList && !restore.canLoad && !restore.canRestore) {
		return EmptyAcpNegotiatedCapabilities;
	}

	return {
		models,
		sessionConfigSchema: schema.schema,
		sessionConfigDefaults: schema.defaults,
		sessionConfigCompletions: completions,
		restore,
	};
}

export function acpModelsToAgentModels(provider: AgentProvider, vendorLabel: string, capabilities: AcpNegotiatedCapabilities): readonly IAgentModelInfo[] {
	return capabilities.models.map(model => ({
		provider,
		id: model.id,
		name: model.name,
		...(model.maxContextWindow !== undefined ? { maxContextWindow: model.maxContextWindow } : {}),
		supportsVision: model.supportsVision,
		...(model.configSchema !== undefined ? { configSchema: model.configSchema } : {}),
		_meta: {
			externalAcpAgent: true,
			vendorLabel,
		},
	}));
}

export function resolveAcpSessionConfigValues(capabilities: AcpNegotiatedCapabilities, config: Record<string, unknown> | undefined): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(capabilities.sessionConfigSchema.properties)) {
		const candidate = config?.[key];
		if (candidate !== undefined && isValueValidForSchema(candidate, schema) && !containsSecretLikeValue(candidate)) {
			values[key] = candidate;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(capabilities.sessionConfigDefaults, key)) {
			values[key] = capabilities.sessionConfigDefaults[key];
		}
	}
	return values;
}

function capabilitySources(result: AcpInitializeResult): readonly AcpJsonObject[] {
	const sources: AcpJsonObject[] = [];
	addObject(sources, result.agentCapabilities);
	addObject(sources, objectValue(result._meta, 'capabilities'));
	addObject(sources, objectValue(result._meta, 'agentCapabilities'));
	addObject(sources, objectValue(result.agentInfo?._meta, 'capabilities'));
	addObject(sources, objectValue(result.agentInfo?._meta, 'agentCapabilities'));
	return sources;
}

function normalizeModels(sources: readonly AcpJsonObject[]): readonly AcpNegotiatedModel[] {
	const rawModels = firstArray(sources, ['models', 'availableModels']);
	if (!rawModels) {
		return [];
	}

	const models: AcpNegotiatedModel[] = [];
	const seen = new Set<string>();
	for (const rawModel of rawModels) {
		const model = normalizeModel(rawModel);
		if (!model || seen.has(model.id)) {
			continue;
		}
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

function normalizeModel(value: AcpJsonValue): AcpNegotiatedModel | undefined {
	if (typeof value === 'string') {
		const id = sanitizeString(value);
		if (!id || containsRedaction(id)) {
			return undefined;
		}
		return { id, name: id, supportsVision: false };
	}
	if (!isObject(value)) {
		return undefined;
	}

	const id = sanitizeString(stringValue(value.id) ?? stringValue(value.model) ?? stringValue(value.name));
	if (!id || containsRedaction(id)) {
		return undefined;
	}
	const name = sanitizeString(stringValue(value.name) ?? stringValue(value.title) ?? id);
	if (!name || containsRedaction(name)) {
		return undefined;
	}
	const maxContextWindow = positiveNumberValue(value.maxContextWindow) ?? positiveNumberValue(value.contextWindow) ?? positiveNumberValue(value.maxInputTokens);
	const configSchema = normalizeConfigSchema(objectValue(value, 'configSchema'))?.schema;
	return {
		id,
		name,
		...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
		supportsVision: value.supportsVision === true || value.vision === true,
		...(configSchema !== undefined ? { configSchema } : {}),
	};
}

function normalizeSessionConfigSchema(sources: readonly AcpJsonObject[]): { readonly schema: SessionConfigSchema; readonly defaults: Readonly<Record<string, unknown>> } {
	const explicitSchema = normalizeConfigSchema(firstObject(sources, ['sessionConfigSchema', 'configSchema', 'config']));
	const modeProperty = normalizeModeProperty(firstArray(sources, ['modes', 'sessionModes']));
	if (!explicitSchema && !modeProperty) {
		return { schema: EmptyAcpSessionConfigSchema, defaults: {} };
	}

	const properties: Record<string, SessionConfigPropertySchema> = {
		...(explicitSchema?.schema.properties ?? {}),
		...(modeProperty && explicitSchema?.schema.properties[SessionConfigKey.Mode] === undefined ? { [SessionConfigKey.Mode]: modeProperty.property } : {}),
	};
	const defaults = {
		...(explicitSchema?.defaults ?? {}),
		...(modeProperty && explicitSchema?.schema.properties[SessionConfigKey.Mode] === undefined && modeProperty.defaultValue !== undefined ? { [SessionConfigKey.Mode]: modeProperty.defaultValue } : {}),
	};

	return {
		schema: {
			type: 'object',
			properties,
			...(explicitSchema?.schema.required?.length ? { required: explicitSchema.schema.required.filter(key => properties[key] !== undefined) } : {}),
		},
		defaults,
	};
}

function normalizeConfigSchema(value: AcpJsonValue | undefined): { readonly schema: SessionConfigSchema; readonly defaults: Readonly<Record<string, unknown>> } | undefined {
	if (!isObject(value) || value.type !== 'object') {
		return undefined;
	}
	const rawProperties = objectValue(value, 'properties');
	if (!rawProperties) {
		return { schema: { type: 'object', properties: {} }, defaults: {} };
	}

	const properties: Record<string, SessionConfigPropertySchema> = {};
	const defaults: Record<string, unknown> = {};
	for (const key of Object.keys(rawProperties)) {
		if (isSecretLikeKey(key)) {
			continue;
		}
		const property = normalizeConfigProperty(rawProperties[key]);
		if (!property) {
			continue;
		}
		properties[key] = property.schema;
		if (property.defaultValue !== undefined) {
			defaults[key] = property.defaultValue;
		}
	}

	const required = arrayValue(value.required)
		?.filter((item): item is string => typeof item === 'string' && properties[item] !== undefined && !isSecretLikeKey(item));

	return {
		schema: {
			type: 'object',
			properties,
			...(required?.length ? { required } : {}),
		},
		defaults,
	};
}

function normalizeConfigProperty(value: AcpJsonValue | undefined): { readonly schema: SessionConfigPropertySchema; readonly defaultValue?: unknown } | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const type = stringValue(value.type);
	if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'array' && type !== 'object') {
		return undefined;
	}
	const title = sanitizeString(stringValue(value.title));
	if (!title || containsRedaction(title)) {
		return undefined;
	}

	const enumValues = arrayValue(value.enum)?.filter((item): item is string => typeof item === 'string' && !containsRedaction(sanitizeString(item)));
	const schema: SessionConfigPropertySchema = {
		type,
		title,
		...(sanitizedOptionalString(value.description) !== undefined ? { description: sanitizedOptionalString(value.description) } : {}),
		...(enumValues?.length ? { enum: enumValues } : {}),
		...(parallelStrings(value.enumLabels, enumValues?.length) !== undefined ? { enumLabels: parallelStrings(value.enumLabels, enumValues?.length) } : {}),
		...(parallelStrings(value.enumDescriptions, enumValues?.length) !== undefined ? { enumDescriptions: parallelStrings(value.enumDescriptions, enumValues?.length) } : {}),
		...(value.readOnly === true ? { readOnly: true } : {}),
		...(value.sessionMutable === true ? { sessionMutable: true } : {}),
		...(value.enumDynamic === true ? { enumDynamic: true } : {}),
	};

	const defaultValue = sanitizeDefault(value.default, schema);
	if (defaultValue !== undefined) {
		schema.default = defaultValue;
	}

	const items = normalizeConfigProperty(value.items);
	if (type === 'array' && items) {
		schema.items = items.schema;
	}

	const childSchema = normalizeConfigSchema({ type: 'object', properties: objectValue(value, 'properties'), required: value.required });
	if (type === 'object' && childSchema) {
		schema.properties = childSchema.schema.properties;
		if (childSchema.schema.required?.length) {
			schema.required = childSchema.schema.required;
		}
	}

	return { schema, ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

function normalizeModeProperty(value: readonly AcpJsonValue[] | undefined): { readonly property: SessionConfigPropertySchema; readonly defaultValue?: string } | undefined {
	if (!value?.length) {
		return undefined;
	}
	const enumValues: string[] = [];
	const enumLabels: string[] = [];
	const enumDescriptions: string[] = [];

	for (const item of value) {
		const mode = normalizeMode(item);
		if (!mode || enumValues.includes(mode.id)) {
			continue;
		}
		enumValues.push(mode.id);
		enumLabels.push(mode.label);
		enumDescriptions.push(mode.description ?? '');
	}

	if (!enumValues.length) {
		return undefined;
	}

	return {
		property: {
			type: 'string',
			title: localize('acpAgent.config.mode', "Mode"),
			description: localize('acpAgent.config.modeDescription', "Vendor-advertised ACP session mode."),
			enum: enumValues,
			enumLabels,
			...(enumDescriptions.some(description => description.length > 0) ? { enumDescriptions } : {}),
			default: enumValues[0],
			sessionMutable: false,
		},
		defaultValue: enumValues[0],
	};
}

function normalizeMode(value: AcpJsonValue): { readonly id: string; readonly label: string; readonly description?: string } | undefined {
	if (typeof value === 'string') {
		const id = sanitizeString(value);
		return !id || containsRedaction(id) ? undefined : { id, label: id };
	}
	if (!isObject(value)) {
		return undefined;
	}
	const id = sanitizeString(stringValue(value.id) ?? stringValue(value.mode) ?? stringValue(value.name));
	if (!id || containsRedaction(id)) {
		return undefined;
	}
	const label = sanitizeString(stringValue(value.label) ?? stringValue(value.title) ?? stringValue(value.name) ?? id);
	if (!label || containsRedaction(label)) {
		return undefined;
	}
	const description = sanitizedOptionalString(value.description);
	return { id, label, ...(description !== undefined ? { description } : {}) };
}

function normalizeSessionConfigCompletions(sources: readonly AcpJsonObject[], schema: SessionConfigSchema): Readonly<Record<string, readonly SessionConfigValueItem[]>> {
	const raw = firstObject(sources, ['sessionConfigCompletions', 'configCompletions']);
	if (!raw) {
		return {};
	}
	const completions: Record<string, readonly SessionConfigValueItem[]> = {};
	for (const key of Object.keys(raw)) {
		if (!Object.prototype.hasOwnProperty.call(schema.properties, key) || isSecretLikeKey(key)) {
			continue;
		}
		const items = arrayValue(raw[key])
			?.map(normalizeCompletionItem)
			.filter((item): item is SessionConfigValueItem => item !== undefined);
		if (items?.length) {
			completions[key] = items;
		}
	}
	return completions;
}

function normalizeCompletionItem(value: AcpJsonValue): SessionConfigValueItem | undefined {
	if (typeof value === 'string') {
		const sanitized = sanitizeString(value);
		return !sanitized || isSecretLikeString(sanitized) ? undefined : { value: sanitized, label: sanitized };
	}
	if (!isObject(value)) {
		return undefined;
	}
	const itemValue = sanitizeString(stringValue(value.value) ?? stringValue(value.id) ?? stringValue(value.label));
	const label = sanitizeString(stringValue(value.label) ?? itemValue);
	if (!itemValue || !label || isSecretLikeString(itemValue) || isSecretLikeString(label)) {
		return undefined;
	}
	const description = sanitizedOptionalString(value.description);
	return { value: itemValue, label, ...(description !== undefined ? { description } : {}) };
}

function normalizeRestoreCapabilities(sources: readonly AcpJsonObject[]): AcpRestoreCapabilityState {
	const candidates = sources.flatMap(source => [
		objectValue(source, 'restore'),
		objectValue(source, 'sessionRestore'),
		objectValue(source, 'sessions'),
	].filter((item): item is AcpJsonObject => item !== undefined));
	const methods = sources.flatMap(source => arrayValue(source.methods) ?? []);
	return {
		canList: candidates.some(candidate => candidate.list === true || candidate.listSessions === true) || methods.includes('session/list'),
		canLoad: candidates.some(candidate => candidate.load === true || candidate.loadSession === true) || methods.includes('session/load'),
		canRestore: candidates.some(candidate => candidate.restore === true || candidate.resume === true || candidate.load === true || candidate.loadSession === true) || methods.includes('session/restore') || methods.includes('session/load'),
	};
}

function firstArray(sources: readonly AcpJsonObject[], keys: readonly string[]): readonly AcpJsonValue[] | undefined {
	for (const source of sources) {
		for (const key of keys) {
			const value = arrayValue(source[key]);
			if (value) {
				return value;
			}
		}
	}
	return undefined;
}

function firstObject(sources: readonly AcpJsonObject[], keys: readonly string[]): AcpJsonObject | undefined {
	for (const source of sources) {
		for (const key of keys) {
			const value = objectValue(source, key);
			if (value) {
				return value;
			}
		}
	}
	return undefined;
}

function addObject(target: AcpJsonObject[], value: AcpJsonValue | undefined): void {
	if (isObject(value)) {
		target.push(value);
	}
}

function objectValue(value: AcpJsonValue | undefined, key: string): AcpJsonObject | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const candidate = value[key];
	return isObject(candidate) ? candidate : undefined;
}

function arrayValue(value: AcpJsonValue | undefined): readonly AcpJsonValue[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function stringValue(value: AcpJsonValue | undefined): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function positiveNumberValue(value: AcpJsonValue | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isObject(value: AcpJsonValue | undefined): value is AcpJsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretLikeKey(key: string): boolean {
	const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
	return normalized === 'token'
		|| normalized === 'tokens'
		|| normalized === 'credential'
		|| normalized === 'credentials'
		|| normalized === 'secret'
		|| normalized === 'secrets'
		|| normalized === 'password'
		|| normalized === 'passwords'
		|| normalized === 'apikey'
		|| normalized === 'accesstoken'
		|| normalized === 'refreshtoken'
		|| normalized === 'authtoken'
		|| normalized === 'bearer'
		|| normalized === 'clientsecret';
}

function sanitizeString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	return trimmed.replace(SecretLikeValuePattern, match => {
		const separator = match.includes('=') ? '=' : match.includes(':') ? ':' : ' ';
		const prefix = match.split(separator)[0].trim();
		return `${prefix}${separator}[redacted]`;
	});
}

function sanitizedOptionalString(value: AcpJsonValue | undefined): string | undefined {
	const sanitized = sanitizeString(stringValue(value));
	return sanitized && !containsRedaction(sanitized) ? sanitized : undefined;
}

function containsRedaction(value: string | undefined): boolean {
	return value?.includes('[redacted]') === true;
}

function isSecretLikeString(value: string): boolean {
	return containsRedaction(sanitizeString(value)) || isSecretLikeKey(value);
}

function parallelStrings(value: AcpJsonValue | undefined, expectedLength: number | undefined): string[] | undefined {
	const strings = arrayValue(value)
		?.map(item => sanitizeString(stringValue(item)))
		.filter((item): item is string => !!item && !containsRedaction(item));
	if (!strings?.length || expectedLength === undefined || strings.length !== expectedLength) {
		return undefined;
	}
	return strings;
}

function sanitizeDefault(value: AcpJsonValue | undefined, schema: SessionConfigPropertySchema): unknown {
	if (value === undefined || !isValueValidForSchema(value, schema) || containsSecretLikeValue(value)) {
		return undefined;
	}
	return value;
}

function isValueValidForSchema(value: unknown, schema: SessionConfigPropertySchema): boolean {
	switch (schema.type) {
		case 'string':
			if (typeof value !== 'string') {
				return false;
			}
			return schema.enum === undefined || schema.enum.includes(value);
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		case 'object':
			return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
}

function containsSecretLikeValue(value: unknown): boolean {
	if (typeof value === 'string') {
		return containsRedaction(sanitizeString(value));
	}
	if (Array.isArray(value)) {
		return value.some(item => containsSecretLikeValue(item));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value).some(([key, item]) => isSecretLikeKey(key) || containsSecretLikeValue(item));
	}
	return false;
}
