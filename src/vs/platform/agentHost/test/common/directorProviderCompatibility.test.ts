/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resolveDirectorProtocolRoute } from '../../common/directorProviderCompatibility.js';

suite('directorProviderCompatibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes native, adapter, and reserved protocol combinations', () => {
		assert.deepStrictEqual([
			resolveDirectorProtocolRoute('anthropic-messages', 'anthropic-messages'),
			resolveDirectorProtocolRoute('openai-chat-completions', 'openai-completions'),
			resolveDirectorProtocolRoute('openai-codex', 'openai-codex'),
			resolveDirectorProtocolRoute('director-normalized', 'gemini-generative').kind,
			resolveDirectorProtocolRoute('openai-responses', 'openai-codex').kind,
			resolveDirectorProtocolRoute('anthropic-messages', 'openai-completions').kind,
		], [
			{ kind: 'native' },
			{ kind: 'native' },
			{ kind: 'native' },
			'adapter',
			'unsupported',
			'unsupported',
		]);
	});
});
