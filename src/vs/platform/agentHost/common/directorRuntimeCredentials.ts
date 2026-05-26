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
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as { readonly accessToken?: unknown };
		return typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined;
	} catch {
		return undefined;
	}
}
