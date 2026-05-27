/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExternalAcpAgentCapability, ExternalAcpAgentSnapshotAgent } from '../../common/acpAgentConfig.js';
import { AcpClientCapabilities } from './acpProtocol.js';

export interface AcpClientCapabilityPolicy {
	readonly allowFileRead?: boolean;
	readonly allowFileWrite?: boolean;
	readonly allowTerminal?: boolean;
	readonly allowTools?: boolean;
}

export function buildAcpClientCapabilities(agent: Pick<ExternalAcpAgentSnapshotAgent, 'capabilities'>, policy: AcpClientCapabilityPolicy = {}): AcpClientCapabilities {
	const capabilities = new Set(agent.capabilities);
	const fs = capabilities.has(ExternalAcpAgentCapability.Files) ? buildFsCapabilities(policy) : undefined;
	const terminal = capabilities.has(ExternalAcpAgentCapability.Terminal) && policy.allowTerminal === true ? true : undefined;
	const tools = capabilities.has(ExternalAcpAgentCapability.Tools) && policy.allowTools === true ? true : undefined;

	return {
		...(fs !== undefined ? { fs } : {}),
		...(terminal !== undefined ? { terminal } : {}),
		...(tools !== undefined ? { _meta: { toolCalls: true } } : {}),
	};
}

function buildFsCapabilities(policy: AcpClientCapabilityPolicy): AcpClientCapabilities['fs'] | undefined {
	const readTextFile = policy.allowFileRead === true ? true : undefined;
	const writeTextFile = policy.allowFileWrite === true ? true : undefined;
	if (readTextFile === undefined && writeTextFile === undefined) {
		return undefined;
	}
	return {
		...(readTextFile !== undefined ? { readTextFile } : {}),
		...(writeTextFile !== undefined ? { writeTextFile } : {}),
	};
}
