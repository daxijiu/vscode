/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../../chat/common/languageModelsConfiguration.js';
import type { IDirectorProviderRegistryService } from '../../common/provider/directorProviderServices.js';
import { DirectorLanguageModelDisplayName, DirectorLanguageModelVendor } from './directorLanguageModelProvider.js';

export async function syncDirectorLanguageModelConfigurationGroup(
	registryService: IDirectorProviderRegistryService,
	languageModelsConfigurationService: ILanguageModelsConfigurationService,
): Promise<void> {
	const providers = await registryService.listProviders();
	const hasEnabledProvider = providers.some(provider => provider.enabled);
	const groups = languageModelsConfigurationService.getLanguageModelsProviderGroups();
	const managedGroup = groups.find(isDirectorManagedLanguageModelGroup);

	if (hasEnabledProvider) {
		if (!managedGroup) {
			await languageModelsConfigurationService.addLanguageModelsProviderGroup({
				vendor: DirectorLanguageModelVendor,
				name: DirectorLanguageModelDisplayName,
				directorManaged: true,
			});
		}
		return;
	}

	if (managedGroup) {
		await languageModelsConfigurationService.removeLanguageModelsProviderGroup(managedGroup);
	}
}

function isDirectorManagedLanguageModelGroup(group: ILanguageModelsProviderGroup): boolean {
	return group.vendor === DirectorLanguageModelVendor
		&& group.name === DirectorLanguageModelDisplayName
		&& group.directorManaged === true;
}
