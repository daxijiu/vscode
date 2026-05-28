/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './providerSettings/media/directorSettings.css';

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDirectorRuntimeCredentialService } from '../../../../platform/agentHost/common/directorRuntimeCredentials.js';
import { DirectorApiKeyService, DirectorModelResolverService, DirectorOAuthService, DirectorProviderConnectionTestService, DirectorProviderRegistryService, DirectorProviderSnapshotService, DirectorRuntimeCredentialService, IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderConnectionTestService, IDirectorProviderRegistryService, IDirectorProviderSnapshotService } from '../common/provider/directorProviderServices.js';
import { createDirectorLanguageModelProviderDescriptor, DirectorLanguageModelProvider, DirectorLanguageModelVendor } from './directorLanguageModel/directorLanguageModelProvider.js';
import { DirectorSettingsEditor } from './providerSettings/directorSettingsEditor.js';
import { DirectorSettingsEditorInput, DirectorSettingsEditorInputSerializer } from './providerSettings/directorSettingsEditorInput.js';

registerSingleton(IDirectorProviderRegistryService, DirectorProviderRegistryService, InstantiationType.Delayed);
registerSingleton(IDirectorApiKeyService, DirectorApiKeyService, InstantiationType.Delayed);
registerSingleton(IDirectorOAuthService, DirectorOAuthService, InstantiationType.Delayed);
registerSingleton(IDirectorModelResolverService, DirectorModelResolverService, InstantiationType.Delayed);
registerSingleton(IDirectorProviderSnapshotService, DirectorProviderSnapshotService, InstantiationType.Delayed);
registerSingleton(IDirectorProviderConnectionTestService, DirectorProviderConnectionTestService, InstantiationType.Delayed);
registerSingleton(IDirectorRuntimeCredentialService, DirectorRuntimeCredentialService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		DirectorSettingsEditor,
		DirectorSettingsEditor.ID,
		localize('directorSettingsEditor', "Director Settings")
	),
	[
		new SyncDescriptor(DirectorSettingsEditorInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DirectorSettingsEditorInput.ID, DirectorSettingsEditorInputSerializer);

export class DirectorCodeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.directorCode';

	constructor(
		@IDirectorProviderSnapshotService snapshotService: IDirectorProviderSnapshotService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super();
		void snapshotService.writeSnapshot();
		const descriptor = createDirectorLanguageModelProviderDescriptor();
		languageModelsService.deltaLanguageModelChatProviderDescriptors([descriptor], []);
		this._register(toDisposable(() => languageModelsService.deltaLanguageModelChatProviderDescriptors([], [descriptor])));
		const provider = this._register(instantiationService.createInstance(DirectorLanguageModelProvider));
		this._register(languageModelsService.registerLanguageModelProvider(DirectorLanguageModelVendor, provider));
		void languageModelsService.selectLanguageModels({ vendor: DirectorLanguageModelVendor }).catch(err => {
			logService.warn('[Director] Failed to resolve initial Director language models', err);
		});
	}
}

registerWorkbenchContribution2(DirectorCodeContribution.ID, DirectorCodeContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenDirectorSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'director-code.openSettings',
			title: localize2('directorCode.openSettings', "Open Director Settings"),
			shortTitle: localize('directorCode.openSettings.short', "Director Settings"),
			category: localize2('directorCode.category', "Director"),
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.MenubarPreferencesMenu, group: '2_configuration', order: 4 },
				{ id: MenuId.ChatTitleBarMenu, group: 'navigation', order: 90 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(DirectorSettingsEditorInput.getInstance(), { pinned: true, revealIfOpened: true });
	}
});
