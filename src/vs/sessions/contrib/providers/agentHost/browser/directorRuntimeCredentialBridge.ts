/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, getDirectorApiKeySecretStorageKey, getDirectorOAuthTokenSecretStorageKey, IDirectorRuntimeCredentialService, parseDirectorOAuthAccessToken } from '../../../../../platform/agentHost/common/directorRuntimeCredentials.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';

export class SessionsDirectorRuntimeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;

	constructor(@ISecretStorageService private readonly secretStorageService: ISecretStorageService) { }

	async resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		switch (request.authKind) {
			case 'none':
				return { kind: 'none' };
			case 'api-key': {
				const value = await this.secretStorageService.get(getDirectorApiKeySecretStorageKey(request.providerInstanceId));
				return value
					? { kind: 'api-key', value }
					: { kind: 'missing', message: `Director provider '${request.providerInstanceId}' is missing an API key.` };
			}
			case 'oauth':
			case 'bearer': {
				const accessToken = parseDirectorOAuthAccessToken(await this.secretStorageService.get(getDirectorOAuthTokenSecretStorageKey(request.providerInstanceId)));
				return accessToken
					? { kind: 'bearer', accessToken }
					: { kind: 'missing', message: `Director provider '${request.providerInstanceId}' is signed out or missing an OAuth token.` };
			}
		}
	}
}
