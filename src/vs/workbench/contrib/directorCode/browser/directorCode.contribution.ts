/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { DirectorApiKeyService, DirectorModelResolverService, DirectorOAuthService, DirectorProviderRegistryService, DirectorProviderSnapshotService, IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderRegistryService, IDirectorProviderSnapshotService, createDirectorProviderInstance, type DirectorStoredProviderInstance } from '../common/provider/directorProviderServices.js';
import type { DirectorProviderApiType, DirectorProviderKind } from '../../../../platform/agentHost/common/directorProviderBackend.js';
import { buildDirectorConnectionTestRequest } from '../../../../platform/agentHost/common/directorProviderRequest.js';

registerSingleton(IDirectorProviderRegistryService, DirectorProviderRegistryService, InstantiationType.Delayed);
registerSingleton(IDirectorApiKeyService, DirectorApiKeyService, InstantiationType.Delayed);
registerSingleton(IDirectorOAuthService, DirectorOAuthService, InstantiationType.Delayed);
registerSingleton(IDirectorModelResolverService, DirectorModelResolverService, InstantiationType.Delayed);
registerSingleton(IDirectorProviderSnapshotService, DirectorProviderSnapshotService, InstantiationType.Delayed);

class DirectorCodeContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.directorCode';

	constructor(@IDirectorProviderSnapshotService snapshotService: IDirectorProviderSnapshotService) {
		void snapshotService.writeSnapshot();
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
		await openDirectorSettings({
			quickInputService: accessor.get(IQuickInputService),
			notificationService: accessor.get(INotificationService),
			registryService: accessor.get(IDirectorProviderRegistryService),
			apiKeyService: accessor.get(IDirectorApiKeyService),
			oauthService: accessor.get(IDirectorOAuthService),
			modelResolverService: accessor.get(IDirectorModelResolverService),
			snapshotService: accessor.get(IDirectorProviderSnapshotService),
		});
	}
});

interface DirectorProviderTemplate extends IQuickPickItem {
	readonly kind: DirectorProviderKind;
	readonly apiType: DirectorProviderApiType;
	readonly baseURL: string;
	readonly defaultModelId: string;
}

interface DirectorSettingsServices {
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	readonly registryService: IDirectorProviderRegistryService;
	readonly apiKeyService: IDirectorApiKeyService;
	readonly oauthService: IDirectorOAuthService;
	readonly modelResolverService: IDirectorModelResolverService;
	readonly snapshotService: IDirectorProviderSnapshotService;
}

async function openDirectorSettings(services: DirectorSettingsServices): Promise<void> {
	const { quickInputService, notificationService, registryService, snapshotService } = services;
	const providers = await registryService.listProviders();
	const choice = await quickInputService.pick([
		{ id: 'add-api-key', label: localize('directorCode.settings.addApiKey', "Add API-Key Provider") },
		{ id: 'add-codex-oauth', label: localize('directorCode.settings.addCodexOAuth', "Add OpenAI Codex OAuth Provider") },
		{ id: 'set-default', label: localize('directorCode.settings.setDefault', "Set Default Provider and Model"), description: providers.length ? undefined : localize('directorCode.settings.noProviders', "No providers configured") },
		{ id: 'test-provider', label: localize('directorCode.settings.testProvider', "Validate Provider Setup"), description: providers.length ? localize('directorCode.settings.noNetwork', "No network request") : localize('directorCode.settings.noProviders', "No providers configured") },
		{ id: 'remove', label: localize('directorCode.settings.remove', "Remove Provider"), description: providers.length ? undefined : localize('directorCode.settings.noProviders', "No providers configured") },
		{ id: 'write-snapshot', label: localize('directorCode.settings.writeSnapshot', "Refresh AgentHost Provider Snapshot") },
		{ id: 'show-snapshot', label: localize('directorCode.settings.showSnapshot', "Show Snapshot Location") },
	], { placeHolder: localize('directorCode.settings.placeHolder', "Director Settings") });

	if (!choice) {
		return;
	}

	switch (choice.id) {
		case 'add-api-key':
			await addApiKeyProvider(services);
			break;
		case 'add-codex-oauth':
			await addOpenAICodexProvider(services);
			break;
		case 'set-default':
			await setDefaultProviderAndModel(services);
			break;
		case 'test-provider':
			await validateProviderSetup(services);
			break;
		case 'remove':
			await removeProvider(services);
			break;
		case 'write-snapshot':
			await snapshotService.writeSnapshot();
			notificationService.info(localize('directorCode.snapshot.refreshed', "Director provider snapshot refreshed."));
			break;
		case 'show-snapshot':
			notificationService.info(await snapshotService.getSnapshotResource());
			break;
	}
}

async function addApiKeyProvider(services: DirectorSettingsServices): Promise<void> {
	const { quickInputService, notificationService, registryService, apiKeyService, snapshotService } = services;

	const template = await quickInputService.pick<DirectorProviderTemplate>([
		{ label: localize('directorCode.template.openaiCompatible', "OpenAI Compatible"), kind: 'openai-compatible', apiType: 'openai-completions', baseURL: 'https://api.openai.com/v1', defaultModelId: 'gpt-4.1' },
		{ label: localize('directorCode.template.anthropicCompatible', "Anthropic Compatible"), kind: 'anthropic-compatible', apiType: 'anthropic-messages', baseURL: 'https://api.anthropic.com', defaultModelId: 'claude-sonnet-4.5' },
		{ label: localize('directorCode.template.gemini', "Gemini"), kind: 'gemini', apiType: 'gemini-generative', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModelId: 'gemini-2.5-pro' },
	], { placeHolder: localize('directorCode.template.placeHolder', "Select provider type") });
	if (!template) {
		return;
	}

	const displayName = await quickInputService.input({ prompt: localize('directorCode.input.displayName', "Provider name"), value: template.label });
	if (!displayName) {
		return;
	}
	const baseURL = await quickInputService.input({ prompt: localize('directorCode.input.baseURL', "Base URL"), value: template.baseURL });
	if (!baseURL) {
		return;
	}
	const modelId = await quickInputService.input({ prompt: localize('directorCode.input.modelId', "Model ID"), value: template.defaultModelId });
	if (!modelId) {
		return;
	}
	const apiKey = await quickInputService.input({ prompt: localize('directorCode.input.apiKey', "API key"), password: true });
	if (!apiKey) {
		return;
	}

	const provider = createDirectorProviderInstance({
		kind: template.kind,
		displayName,
		authKind: 'api-key',
		apiType: template.apiType,
		baseURL,
		modelId,
	});
	await apiKeyService.setProviderInstanceKey(provider.id, apiKey);
	await registryService.saveProvider(provider);
	await snapshotService.writeSnapshot();
	notificationService.info(localize('directorCode.provider.added', "Director provider '{0}' added.", provider.displayName));
}

async function addOpenAICodexProvider(services: DirectorSettingsServices): Promise<void> {
	const { notificationService, registryService, oauthService, snapshotService } = services;

	const provider = createDirectorProviderInstance({
		id: 'openai-codex',
		kind: 'openai-codex',
		displayName: 'OpenAI Codex',
		authKind: 'oauth',
		apiType: 'openai-codex',
		authVariant: 'openai-codex',
		baseURL: 'https://chatgpt.com/backend-api/codex',
		modelId: 'gpt-5.2-codex',
	});
	await registryService.saveProvider(provider);
	await oauthService.signInOpenAICodex(provider.id);
	await snapshotService.writeSnapshot();
	notificationService.info(localize('directorCode.codex.fakeSignIn', "OpenAI Codex OAuth provider added with the deterministic Phase 3 fake sign-in token."));
}

async function setDefaultProviderAndModel(services: DirectorSettingsServices): Promise<void> {
	const { quickInputService, notificationService, registryService, modelResolverService, snapshotService } = services;
	const provider = await pickProvider(quickInputService, await registryService.listProviders(), localize('directorCode.pickDefaultProvider', "Select default Director provider"));
	if (!provider) {
		return;
	}
	const models = await modelResolverService.resolveModels(provider);
	const model = await quickInputService.pick(models.map(model => ({ label: model.name, description: model.id, modelId: model.id })), { placeHolder: localize('directorCode.pickDefaultModel', "Select default model") });
	if (!model) {
		return;
	}
	await registryService.setDefaults(provider.id, model.modelId);
	await snapshotService.writeSnapshot();
	notificationService.info(localize('directorCode.defaults.updated', "Director default provider and model updated."));
}

async function validateProviderSetup(services: DirectorSettingsServices): Promise<void> {
	const { quickInputService, notificationService, registryService, apiKeyService, oauthService, modelResolverService } = services;
	const provider = await pickProvider(quickInputService, await registryService.listProviders(), localize('directorCode.pickTestProvider', "Select Director provider to validate"));
	if (!provider) {
		return;
	}

	const authState = provider.authKind === 'api-key'
		? await apiKeyService.getAuthState(provider)
		: provider.authKind === 'none'
			? { kind: 'none' as const }
			: await oauthService.getAuthState(provider);
	if (authState.kind !== 'ready' && authState.kind !== 'none') {
		notificationService.warn(authState.message ?? localize('directorCode.provider.notReady', "Director provider credentials are not ready."));
		return;
	}

	if (!provider.baseURL && provider.apiType !== 'local') {
		notificationService.warn(localize('directorCode.provider.missingBaseUrl', "Director provider '{0}' needs a base URL before it can be tested.", provider.displayName));
		return;
	}

	const models = await modelResolverService.resolveModels(provider);
	const model = await quickInputService.pick(models.map(model => ({ label: model.name, description: model.providerModelId ?? model.id, model })), { placeHolder: localize('directorCode.pickTestModel', "Select model to validate") });
	if (!model) {
		return;
	}

	const request = buildDirectorConnectionTestRequest(provider.apiType, provider.baseURL ?? '', model.model.providerModelId ?? model.model.id, '<redacted>');
	notificationService.info(localize('directorCode.provider.validated', "Director provider '{0}' is configured. Test template: {1} {2}", provider.displayName, request.method, request.url));
}

async function removeProvider(services: DirectorSettingsServices): Promise<void> {
	const { quickInputService, notificationService, registryService, apiKeyService, oauthService, snapshotService } = services;
	const provider = await pickProvider(quickInputService, await registryService.listProviders(), localize('directorCode.pickRemoveProvider', "Select Director provider to remove"));
	if (!provider) {
		return;
	}
	await registryService.removeProvider(provider.id);
	await apiKeyService.deleteProviderInstanceKey(provider.id);
	await oauthService.signOutOpenAICodex(provider.id);
	await snapshotService.writeSnapshot();
	notificationService.info(localize('directorCode.provider.removed', "Director provider '{0}' removed.", provider.displayName));
}

function pickProvider(quickInputService: IQuickInputService, providers: readonly DirectorStoredProviderInstance[], placeHolder: string): Promise<(DirectorStoredProviderInstance & IQuickPickItem) | undefined> {
	return quickInputService.pick(providers.map(provider => ({
		...provider,
		label: provider.displayName,
		description: `${provider.kind} / ${provider.apiType}`,
	})), { placeHolder });
}
