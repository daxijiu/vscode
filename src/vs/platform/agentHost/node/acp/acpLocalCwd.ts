/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../common/acpAgentConfig.js';

export interface AcpResolvedLocalCwd {
	readonly processCwd?: string;
	readonly sessionCwd: string;
	readonly workingDirectory?: URI;
}

export function resolveAcpLocalCwd(agent: Pick<ExternalAcpAgentSnapshotAgent, 'cwdPolicy' | 'cwd'>, requested: URI | undefined): AcpResolvedLocalCwd {
	switch (agent.cwdPolicy) {
		case ExternalAcpAgentCwdPolicy.Fixed:
			if (!agent.cwd) {
				throw new Error(localize('acpLocalCwd.fixedMissing', "External ACP agent fixed CWD is missing."));
			}
			return {
				processCwd: agent.cwd,
				sessionCwd: agent.cwd,
				workingDirectory: URI.file(agent.cwd),
			};
		case ExternalAcpAgentCwdPolicy.Workspace:
			if (!requested) {
				throw new Error(localize('acpLocalCwd.workspaceMissing', "External ACP agents currently support only local file workspaces. Open a local folder or set the ACP agent CWD policy to No CWD."));
			}
			assertLocalFileWorkspace(requested);
			return {
				processCwd: requested.fsPath,
				sessionCwd: requested.fsPath,
				workingDirectory: requested,
			};
		case ExternalAcpAgentCwdPolicy.None:
		default:
			return { sessionCwd: '' };
	}
}

function assertLocalFileWorkspace(uri: URI): void {
	if (uri.scheme !== 'file' || uri.authority) {
		throw new Error(localize('acpLocalCwd.remoteUnsupported', "External ACP agents currently support only local file workspaces. Remote, WSL, container, and virtual workspaces are deferred for a later ACP release."));
	}
}
