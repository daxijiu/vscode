/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../log/common/log.js';
import { createDirectorRuntimeCredentialConnection, type DirectorRuntimeCredential, type DirectorRuntimeCredentialRequest, type IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';

export class DirectorRuntimeCredentialService extends Disposable implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;

	private readonly connections = new Map<string, IDirectorRuntimeCredentialService>();

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	registerConnection(clientId: string, channel: IChannel): IDisposable {
		const connection = createDirectorRuntimeCredentialConnection(channel);
		this.connections.set(clientId, connection);
		return {
			dispose: () => {
				if (this.connections.get(clientId) === connection) {
					this.connections.delete(clientId);
				}
			},
		};
	}

	async resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		if (request.authKind === 'none') {
			return { kind: 'none' };
		}

		for (const [clientId, connection] of [...this.connections].reverse()) {
			try {
				const credential = await connection.resolveCredential(request);
				if (credential.kind !== 'missing') {
					return credential;
				}
			} catch (err) {
				this.logService.warn(`[Director] Credential bridge request failed for client '${clientId}'`, err);
			}
		}

		return {
			kind: 'missing',
			message: `Director provider '${request.providerInstanceId}' credentials are not available to AgentHost. Open Director Settings in this window, verify the provider is signed in or has an API key, then try again.`,
		};
	}
}
