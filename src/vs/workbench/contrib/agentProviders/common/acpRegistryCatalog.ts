/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AcpRegistryAgent, normalizeAcpRegistryAgents } from '../../../../platform/agentHost/common/acpRegistry.js';

const BundledAcpRegistryCatalog: readonly unknown[] = [
	{
		id: 'cursor-agent',
		name: 'Cursor Agent',
		version: '1.0.0',
		description: 'Cursor-owned ACP runtime that uses your Cursor subscription.',
		authors: ['Cursor'],
		distribution: {
			bundled: {
				command: 'cursor-agent',
				args: ['acp'],
			},
		},
		installCommand: 'npm install -g @cursor/agent',
		loginHint: 'Run the Cursor agent login flow outside VS Code before enabling this draft.',
		loginCommand: 'cursor-agent login',
		loginHelpUrl: 'https://cursor.com/docs',
		helpUrl: 'https://cursor.com/docs',
	},
	{
		id: 'codebuddy-code',
		name: 'CodeBuddy Code',
		version: '1.0.0',
		description: 'CodeBuddy-owned ACP runtime that uses your CodeBuddy account.',
		authors: ['CodeBuddy'],
		distribution: {
			bundled: {
				command: 'codebuddy',
				args: ['--acp'],
			},
		},
		installCommand: 'npm install -g @tencent/codebuddy-code',
		loginHint: 'Run the CodeBuddy login flow outside VS Code before enabling this draft.',
		loginCommand: 'codebuddy login',
		loginHelpUrl: 'https://codebuddy.ai',
		helpUrl: 'https://codebuddy.ai',
	},
	{
		id: 'claude-acp',
		name: 'Claude ACP',
		version: '1.0.0',
		description: 'Claude Code ACP runtime that uses your Claude Code or Anthropic-side auth.',
		authors: ['Anthropic'],
		distribution: {
			bundled: {
				command: 'claude',
				args: ['acp'],
			},
		},
		installCommand: 'npm install -g @anthropic-ai/claude-code',
		loginHint: 'Run Claude Code and complete the vendor-owned auth flow outside VS Code before enabling this draft.',
		loginCommand: 'claude',
		loginHelpUrl: 'https://docs.anthropic.com',
		helpUrl: 'https://docs.anthropic.com',
	},
];

export function getBundledAcpRegistryCatalog(): readonly AcpRegistryAgent[] {
	return normalizeAcpRegistryAgents(BundledAcpRegistryCatalog, 'bundled');
}
