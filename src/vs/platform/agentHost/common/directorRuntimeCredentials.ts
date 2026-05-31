/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { DirectorProviderAuthKind } from './directorProviderBackend.js';
import type { DirectorProviderAuthStateKind } from './directorProviderSnapshot.js';

export const DirectorRuntimeCredentialChannelName = 'directorRuntimeCredentials';
export const DirectorApiKeySecretStoragePrefix = 'director-code.providerInstanceKey';
export const DirectorOAuthTokenSecretStoragePrefix = 'director-code.oauth';

export type DirectorOAuthAuthVariant = 'default' | 'openai-codex';

export interface DirectorOAuthTokenRecord {
	readonly providerInstanceId: string;
	readonly providerId: string;
	readonly authVariant: DirectorOAuthAuthVariant;
	readonly identityKey: string;
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface DirectorRuntimeCredentialRequest {
	readonly providerInstanceId: string;
	readonly authKind: DirectorProviderAuthKind;
	readonly authStateKind?: DirectorProviderAuthStateKind;
}

export type DirectorRuntimeCredential =
	| { readonly kind: 'none' }
	| { readonly kind: 'api-key'; readonly value: string }
	| { readonly kind: 'bearer'; readonly accessToken: string }
	| { readonly kind: 'missing'; readonly message: string };

export interface IDirectorRuntimeCredentialService {
	readonly _serviceBrand: undefined;
	resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential>;
}

export const IDirectorRuntimeCredentialService = createDecorator<IDirectorRuntimeCredentialService>('directorRuntimeCredentialService');

export class DirectorRuntimeCredentialChannel implements IServerChannel {

	constructor(private readonly service: IDirectorRuntimeCredentialService) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`No event '${event}' on DirectorRuntimeCredentialChannel`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'resolveCredential':
				return this.service.resolveCredential(arg as DirectorRuntimeCredentialRequest) as Promise<T>;
		}
		throw new Error(`Unknown command '${command}' on DirectorRuntimeCredentialChannel`);
	}
}

export function createDirectorRuntimeCredentialConnection(channel: IChannel): IDirectorRuntimeCredentialService {
	return {
		_serviceBrand: undefined,
		resolveCredential: request => channel.call('resolveCredential', request) as Promise<DirectorRuntimeCredential>,
	};
}

export function getDirectorApiKeySecretStorageKey(providerInstanceId: string): string {
	return `${DirectorApiKeySecretStoragePrefix}.${providerInstanceId}`;
}

export function getDirectorOAuthTokenSecretStorageKey(providerInstanceId: string): string {
	return `${DirectorOAuthTokenSecretStoragePrefix}.${providerInstanceId}`;
}

export function parseDirectorOAuthAccessToken(value: string | undefined): string | undefined {
	const record = parseDirectorOAuthTokenRecord(value);
	if (record !== undefined) {
		return isDirectorOAuthTokenExpired(record) ? undefined : record.accessToken;
	}
	const legacy = parseLegacyDirectorOAuthAccessToken(value);
	if (legacy === undefined || isExpiredAt(legacy.expiresAt)) {
		return undefined;
	}
	return legacy.accessToken;
}

export function parseDirectorOAuthTokenRecord(value: string | undefined): DirectorOAuthTokenRecord | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as {
			readonly providerInstanceId?: unknown;
			readonly providerId?: unknown;
			readonly authVariant?: unknown;
			readonly identityKey?: unknown;
			readonly accessToken?: unknown;
			readonly refreshToken?: unknown;
			readonly expiresAt?: unknown;
			readonly createdAt?: unknown;
			readonly updatedAt?: unknown;
		};
		if (
			typeof parsed.providerInstanceId !== 'string'
			|| typeof parsed.providerId !== 'string'
			|| (parsed.authVariant !== 'default' && parsed.authVariant !== 'openai-codex')
			|| typeof parsed.identityKey !== 'string'
			|| typeof parsed.accessToken !== 'string'
			|| typeof parsed.createdAt !== 'number'
			|| typeof parsed.updatedAt !== 'number'
		) {
			return undefined;
		}
		return {
			providerInstanceId: parsed.providerInstanceId,
			providerId: parsed.providerId,
			authVariant: parsed.authVariant,
			identityKey: parsed.identityKey,
			accessToken: parsed.accessToken,
			...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
			...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
			createdAt: parsed.createdAt,
			updatedAt: parsed.updatedAt,
		};
	} catch {
		return undefined;
	}
}

export function isDirectorOAuthTokenExpired(record: DirectorOAuthTokenRecord, now = Date.now()): boolean {
	return isExpiredAt(record.expiresAt, now);
}

function parseLegacyDirectorOAuthAccessToken(value: string | undefined): { readonly accessToken: string; readonly expiresAt?: number } | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as { readonly accessToken?: unknown; readonly expiresAt?: unknown };
		if (typeof parsed.accessToken !== 'string') {
			return undefined;
		}
		return {
			accessToken: parsed.accessToken,
			...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
		};
	} catch {
		return undefined;
	}
}

function isExpiredAt(expiresAt: number | undefined, now = Date.now()): boolean {
	return expiresAt !== undefined && expiresAt <= now;
}
