/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './externalAcpAgents/media/externalAcpAgents.css';

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ExternalAcpAgentRegistryService, ExternalAcpAgentSnapshotService, ExternalAcpAgentsManagedInstallEnabledSetting, ExternalAcpAgentsRegistryBrowseEnabledSetting, IExternalAcpAgentConnectionTestService, IExternalAcpAgentRegistryService, IExternalAcpAgentSnapshotService, UnavailableExternalAcpAgentConnectionTestService } from '../common/externalAcpAgentProviderService.js';
import { ExternalAcpAgentsEditor } from './externalAcpAgents/externalAcpAgentsEditor.js';
import { ExternalAcpAgentsEditorInput, ExternalAcpAgentsEditorInputSerializer } from './externalAcpAgents/externalAcpAgentsEditorInput.js';

registerSingleton(IExternalAcpAgentRegistryService, ExternalAcpAgentRegistryService, InstantiationType.Delayed);
registerSingleton(IExternalAcpAgentSnapshotService, ExternalAcpAgentSnapshotService, InstantiationType.Delayed);
registerSingleton(IExternalAcpAgentConnectionTestService, UnavailableExternalAcpAgentConnectionTestService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ExternalAcpAgentsEditor,
		ExternalAcpAgentsEditor.ID,
		localize('externalAcpAgentsEditor', "External ACP Agents")
	),
	[
		new SyncDescriptor(ExternalAcpAgentsEditorInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ExternalAcpAgentsEditorInput.ID, ExternalAcpAgentsEditorInputSerializer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'externalAcpAgents',
	order: 100,
	title: localize('externalAcpAgents.configurationTitle', "External ACP Agents"),
	type: 'object',
	properties: {
		[ExternalAcpAgentsRegistryBrowseEnabledSetting]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('externalAcpAgents.registryBrowse.enabled', "Controls whether the External ACP Agents page shows the local Known ACP Agents browse catalog. This does not fetch from the network or install agents."),
		},
		[ExternalAcpAgentsManagedInstallEnabledSetting]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('externalAcpAgents.managedInstall.enabled', "Controls whether managed install UI for registry ACP agents may be enabled. Phase 7A keeps managed install unavailable even when this setting is changed."),
		},
	}
});

class ExternalAcpAgentsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.externalAcpAgents';

	constructor(@IExternalAcpAgentSnapshotService snapshotService: IExternalAcpAgentSnapshotService) {
		void snapshotService.writeSnapshot();
	}
}

registerWorkbenchContribution2(ExternalAcpAgentsContribution.ID, ExternalAcpAgentsContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenExternalAcpAgentsSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'externalAcpAgents.openSettings',
			title: localize2('externalAcpAgents.openSettings', "Open External ACP Agents"),
			shortTitle: localize('externalAcpAgents.openSettings.short', "External ACP Agents"),
			category: localize2('externalAcpAgents.category', "Agent Providers"),
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.MenubarPreferencesMenu, group: '2_configuration', order: 5 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(ExternalAcpAgentsEditorInput.getInstance(), { pinned: true, revealIfOpened: true });
	}
});
