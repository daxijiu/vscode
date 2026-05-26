/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getDirectorProviderRegistryResourceFromGlobalStorageHome, getDirectorProviderSnapshotResource, getDirectorProviderSnapshotResourceFromGlobalStorageHome, isAuthStateUsableForModelList, makeDirectorProviderModelKey, sanitizeDirectorProviderHeaders, sanitizeDirectorProviderId } from '../../common/directorProviderSnapshot.js';

suite('directorProviderSnapshot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses secret-free profile storage paths and helpers', () => {
		const appSettingsHome = URI.file('/user/User');
		const globalStorageHome = URI.file('/user/User/globalStorage/profile-a');

		assert.deepStrictEqual({
			defaultSnapshot: getDirectorProviderSnapshotResource(appSettingsHome).path,
			profileSnapshot: getDirectorProviderSnapshotResourceFromGlobalStorageHome(globalStorageHome).path,
			profileRegistry: getDirectorProviderRegistryResourceFromGlobalStorageHome(globalStorageHome).path,
			sanitized: sanitizeDirectorProviderId(' My Provider! '),
			modelKey: makeDirectorProviderModelKey(' My Provider! ', 'gpt-4.1'),
			ready: isAuthStateUsableForModelList({ kind: 'ready' }),
			missing: isAuthStateUsableForModelList({ kind: 'missing' }),
			headers: sanitizeDirectorProviderHeaders({
				authorization: 'nope',
				' X-Api-Key ': 'nope',
				'x-director-token': 'nope',
				'x-director-trace': 'safe',
			}),
		}, {
			defaultSnapshot: '/user/User/globalStorage/director/provider-snapshot.json',
			profileSnapshot: '/user/User/globalStorage/profile-a/director/provider-snapshot.json',
			profileRegistry: '/user/User/globalStorage/profile-a/director/provider-registry.json',
			sanitized: 'my-provider',
			modelKey: 'my-provider:gpt-4.1',
			ready: true,
			missing: false,
			headers: { 'x-director-trace': 'safe' },
		});
	});
});
