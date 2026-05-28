/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgent } from '../../common/agentService.js';
import { IAgentHostTerminalManager } from '../agentHostTerminalManager.js';
import { AcpAgent, toAcpAgentProviderId } from './acpAgent.js';
import { AcpAgentSnapshotLoader } from './acpAgentSnapshotLoader.js';

export interface RegisterAcpAgentsFromSnapshotOptions {
	readonly agentService: { registerProvider(provider: IAgent): void };
	readonly snapshotResource: URI;
	readonly fileService: IFileService;
	readonly logService: ILogService;
	readonly terminalManager?: IAgentHostTerminalManager;
	readonly disposables?: DisposableStore;
	readonly executionEnabled?: boolean;
}

export async function registerAcpAgentsFromSnapshot(options: RegisterAcpAgentsFromSnapshotOptions): Promise<number> {
	if (options.executionEnabled === false) {
		options.logService.info('[ACP AgentHost] External ACP agent execution is disabled by setting or policy; skipping snapshot registration');
		return 0;
	}
	const loader = new AcpAgentSnapshotLoader(options.fileService, options.logService);
	const snapshotAgents = await loader.load(options.snapshotResource);
	const registeredProviderIds = new Set<string>();
	let registered = 0;

	for (const snapshotAgent of snapshotAgents) {
		const providerId = toAcpAgentProviderId(snapshotAgent.id);
		if (registeredProviderIds.has(providerId)) {
			options.logService.warn(`[ACP AgentHost] Skipping duplicate external ACP agent provider '${providerId}'`);
			continue;
		}
		registeredProviderIds.add(providerId);

		const agent = new AcpAgent(snapshotAgent, { fileService: options.fileService, terminalManager: options.terminalManager });
		try {
			options.agentService.registerProvider(agent);
			options.disposables?.add(agent);
			registered++;
		} catch (err) {
			agent.dispose();
			options.logService.warn(`[ACP AgentHost] Failed to register external ACP agent provider '${providerId}'`, err);
		}
	}

	if (registered > 0) {
		options.logService.info(`[ACP AgentHost] Registered ${registered} external ACP agent provider(s) from snapshot`);
	}
	return registered;
}
