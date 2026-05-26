/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import type { DirectorProviderApiType, DirectorProviderCapabilities, DirectorProviderInstance, DirectorProviderModel } from './directorProviderBackend.js';

export const DirectorProviderSnapshotVersion = 1;
export const DirectorProviderStorageDirName = 'director';
export const DirectorProviderRegistryFileName = 'provider-registry.json';
export const DirectorProviderSnapshotFileName = 'provider-snapshot.json';

export type DirectorProviderAuthStateKind = 'none' | 'ready' | 'missing' | 'expired' | 'signedOut' | 'error';

export interface DirectorProviderAuthState {
	readonly kind: DirectorProviderAuthStateKind;
	readonly message?: string;
	readonly identityKey?: string;
	readonly updatedAt?: number;
}

export interface DirectorProviderSnapshotProvider extends DirectorProviderInstance {
	readonly apiType: DirectorProviderApiType;
	readonly authState: DirectorProviderAuthState;
}

export interface DirectorProviderSnapshotModel extends DirectorProviderModel {
	readonly apiType: DirectorProviderApiType;
	readonly providerDisplayName?: string;
	readonly capabilities?: DirectorProviderCapabilities;
}

export interface DirectorProviderSnapshot {
	readonly version: typeof DirectorProviderSnapshotVersion;
	readonly updatedAt: number;
	readonly defaultProviderId?: string;
	readonly defaultModelId?: string;
	readonly providers: readonly DirectorProviderSnapshotProvider[];
	readonly models: readonly DirectorProviderSnapshotModel[];
}

export function getDirectorProviderStorageHome(appSettingsHome: URI): URI {
	return joinPath(appSettingsHome, 'globalStorage', DirectorProviderStorageDirName);
}

export function getDirectorProviderStorageHomeFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(globalStorageHome, DirectorProviderStorageDirName);
}

export function getDirectorProviderRegistryResource(appSettingsHome: URI): URI {
	return joinPath(getDirectorProviderStorageHome(appSettingsHome), DirectorProviderRegistryFileName);
}

export function getDirectorProviderRegistryResourceFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(getDirectorProviderStorageHomeFromGlobalStorageHome(globalStorageHome), DirectorProviderRegistryFileName);
}

export function getDirectorProviderSnapshotResource(appSettingsHome: URI): URI {
	return joinPath(getDirectorProviderStorageHome(appSettingsHome), DirectorProviderSnapshotFileName);
}

export function getDirectorProviderSnapshotResourceFromGlobalStorageHome(globalStorageHome: URI): URI {
	return joinPath(getDirectorProviderStorageHomeFromGlobalStorageHome(globalStorageHome), DirectorProviderSnapshotFileName);
}

export function isAuthStateUsableForModelList(authState: DirectorProviderAuthState): boolean {
	return authState.kind === 'none' || authState.kind === 'ready';
}

export function sanitizeDirectorProviderId(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
}

export function makeDirectorProviderModelKey(providerInstanceId: string, modelId: string): string {
	return `${sanitizeDirectorProviderId(providerInstanceId)}:${modelId.trim()}`;
}

export function sanitizeDirectorProviderHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (headers === undefined) {
		return undefined;
	}

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!isDirectorSensitiveHeaderName(key)) {
			result[key.trim()] = value;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

export function isDirectorSensitiveHeaderName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	const compact = normalized.replace(/[^a-z0-9]+/g, '');
	return normalized === 'authorization'
		|| normalized === 'proxy-authorization'
		|| normalized.includes('api-key')
		|| normalized.includes('api_key')
		|| normalized.includes('token')
		|| compact.includes('apikey');
}
