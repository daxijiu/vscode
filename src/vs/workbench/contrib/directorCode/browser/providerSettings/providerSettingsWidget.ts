/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { DirectorProviderApiType, DirectorProviderAuthKind, DirectorProviderKind } from '../../../../../platform/agentHost/common/directorProviderBackend.js';
import { buildDirectorConnectionTestRequest } from '../../../../../platform/agentHost/common/directorProviderRequest.js';
import { DirectorProviderAuthState, makeDirectorProviderModelKey, sanitizeDirectorProviderHeaders, sanitizeDirectorProviderId } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { createDirectorProviderInstance, DirectorProviderRegistryState, DirectorStoredProviderInstance, DirectorStoredProviderModel, IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderConnectionTestService, IDirectorProviderRegistryService, IDirectorProviderSnapshotService } from '../../common/provider/directorProviderServices.js';

const $ = DOM.$;

interface DirectorProviderTemplate {
	readonly id: string;
	readonly kind: DirectorProviderKind;
	readonly apiType: DirectorProviderApiType;
	readonly authKind: DirectorProviderAuthKind;
	readonly label: string;
	readonly note: string;
	readonly baseURL?: string;
	readonly defaultModelId: string;
	readonly recommended?: boolean;
	readonly custom?: boolean;
	readonly allowMultiple?: boolean;
	readonly authVariant?: 'default' | 'openai-codex';
}

type ProviderDialogMode =
	| { readonly kind: 'new'; readonly template: DirectorProviderTemplate }
	| { readonly kind: 'edit'; readonly provider: DirectorStoredProviderInstance };

type ProviderSettingsRefreshScope = 'all' | 'providersAndModels' | 'connectedAndModels' | 'models';

type StatusKind = 'info' | 'success' | 'error';

interface DirectorProviderModelRow {
	readonly id: string;
	readonly providerModelId: string;
	readonly name: string;
	readonly family?: string;
	readonly hidden?: boolean;
	readonly maxContextWindow?: number;
	readonly supportsVision?: boolean;
	readonly capabilities?: DirectorStoredProviderModel['capabilities'];
}

interface ProviderSettingsShell {
	readonly root: HTMLElement;
	readonly status: HTMLElement;
	readonly connectedProviders: HTMLElement;
	readonly popularProviders: HTMLElement;
	readonly models: HTMLElement;
	readonly diagnostics: HTMLElement;
}

const providerLabels: Record<DirectorProviderKind, string> = {
	anthropic: 'Anthropic',
	'anthropic-compatible': 'Anthropic Compatible',
	openai: 'OpenAI',
	'openai-compatible': 'OpenAI Compatible',
	'openai-codex': 'OpenAI Codex',
	gemini: 'Google Gemini',
	local: 'Local',
	'custom-http': 'Custom HTTP',
};

const apiKeyProviderTemplates: readonly DirectorProviderTemplate[] = [
	{
		id: 'anthropic',
		kind: 'anthropic',
		apiType: 'anthropic-messages',
		authKind: 'api-key',
		label: localize('directorSettings.template.anthropic', "Anthropic"),
		note: localize('directorSettings.template.anthropic.note', "Claude models through an Anthropic API key."),
		baseURL: 'https://api.anthropic.com',
		defaultModelId: 'claude-sonnet-4.5',
		recommended: true,
	},
	{
		id: 'openai',
		kind: 'openai',
		apiType: 'openai-completions',
		authKind: 'api-key',
		label: localize('directorSettings.template.openai', "OpenAI"),
		note: localize('directorSettings.template.openai.note', "GPT and compatible OpenAI models through an API key."),
		baseURL: 'https://api.openai.com/v1',
		defaultModelId: 'gpt-4.1',
		recommended: true,
	},
	{
		id: 'openai-compatible',
		kind: 'openai-compatible',
		apiType: 'openai-completions',
		authKind: 'api-key',
		label: localize('directorSettings.template.openaiCompatible', "OpenAI Compatible"),
		note: localize('directorSettings.template.openaiCompatible.note', "OpenAI-compatible gateways, local proxies, and custom endpoints."),
		baseURL: 'https://api.openai.com/v1',
		defaultModelId: 'gpt-4.1',
		custom: true,
		allowMultiple: true,
	},
	{
		id: 'anthropic-compatible',
		kind: 'anthropic-compatible',
		apiType: 'anthropic-messages',
		authKind: 'api-key',
		label: localize('directorSettings.template.anthropicCompatible', "Anthropic Compatible"),
		note: localize('directorSettings.template.anthropicCompatible.note', "Claude-compatible endpoints and Anthropic Messages proxies."),
		baseURL: 'https://api.anthropic.com',
		defaultModelId: 'claude-sonnet-4.5',
		custom: true,
		allowMultiple: true,
	},
	{
		id: 'gemini',
		kind: 'gemini',
		apiType: 'gemini-generative',
		authKind: 'api-key',
		label: localize('directorSettings.template.gemini', "Google Gemini"),
		note: localize('directorSettings.template.gemini.note', "Gemini models through a Google AI Studio API key."),
		baseURL: 'https://generativelanguage.googleapis.com/v1beta',
		defaultModelId: 'gemini-2.5-pro',
	},
];

const oauthProviderTemplates: readonly DirectorProviderTemplate[] = [
	{
		id: 'openai-codex-oauth',
		kind: 'openai-codex',
		apiType: 'openai-codex',
		authKind: 'oauth',
		authVariant: 'openai-codex',
		label: localize('directorSettings.template.openaiCodexOAuth', "OpenAI Codex OAuth"),
		note: localize('directorSettings.template.openaiCodexOAuth.note', "OpenAI Codex provider using Director-owned OAuth state."),
		baseURL: 'https://chatgpt.com/backend-api/codex',
		defaultModelId: 'gpt-5.2-codex',
		recommended: true,
	},
];

const providerTemplates: readonly DirectorProviderTemplate[] = [
	...oauthProviderTemplates,
	...apiKeyProviderTemplates,
];

export class ProviderSettingsWidget extends Disposable {

	private container: HTMLElement | undefined;
	private shell: ProviderSettingsShell | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly statusRenderDisposables = this._register(new DisposableStore());
	private readonly connectedRenderDisposables = this._register(new DisposableStore());
	private readonly popularRenderDisposables = this._register(new DisposableStore());
	private readonly modelCatalogDisposables = this._register(new DisposableStore());
	private readonly diagnosticsRenderDisposables = this._register(new DisposableStore());
	private readonly modalDisposables = this._register(new DisposableStore());
	private renderGeneration = 0;
	private refreshSuppression = 0;
	private modelFilter = '';

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IDirectorProviderRegistryService private readonly registryService: IDirectorProviderRegistryService,
		@IDirectorApiKeyService private readonly apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly oauthService: IDirectorOAuthService,
		@IDirectorModelResolverService private readonly modelResolverService: IDirectorModelResolverService,
		@IDirectorProviderConnectionTestService private readonly connectionTestService: IDirectorProviderConnectionTestService,
		@IDirectorProviderSnapshotService private readonly snapshotService: IDirectorProviderSnapshotService,
	) {
		super();
		this._register(this.registryService.onDidChangeProviders(() => this.handleProviderStateChanged('providersAndModels')));
		this._register(this.apiKeyService.onDidChangeAuth(() => this.handleProviderStateChanged('connectedAndModels')));
		this._register(this.oauthService.onDidChangeAuth(() => this.handleProviderStateChanged('connectedAndModels')));
	}

	render(container: HTMLElement): void {
		if (this.container !== container) {
			this.renderDisposables.clear();
			this.clearSectionDisposables();
			this.modalDisposables.clear();
			this.shell = undefined;
			DOM.clearNode(container);
		}
		this.container = container;
		void this.refresh();
	}

	async refresh(options: { readonly preserveScroll?: boolean; readonly scope?: ProviderSettingsRefreshScope } = {}): Promise<void> {
		if (!this.container) {
			return;
		}

		const generation = ++this.renderGeneration;
		const scrollTop = options.preserveScroll ? this.container.scrollTop : undefined;
		const state = await this.registryService.getState();
		if (generation !== this.renderGeneration || !this.container) {
			return;
		}

		const shell = this.ensureShell(this.container);
		await this.refreshSections(shell, state, options.scope ?? 'all', generation);
		if (scrollTop !== undefined && generation === this.renderGeneration && this.container) {
			this.container.scrollTop = scrollTop;
		}
	}

	private ensureShell(container: HTMLElement): ProviderSettingsShell {
		if (this.shell !== undefined && container.contains(this.shell.root)) {
			return this.shell;
		}

		this.renderDisposables.clear();
		this.clearSectionDisposables();
		DOM.clearNode(container);

		const root = DOM.append(container, $('.director-code-provider-settings-widget'));
		const header = DOM.append(root, $('.dc-page-heading'));
		DOM.append(header, $('.dc-section-header')).textContent = localize('directorSettings.title', "Providers");
		DOM.append(header, $('.dc-section-subtitle')).textContent = localize('directorSettings.subtitle', "Connect model providers and choose which models Director exposes to non-Copilot agents.");
		const status = DOM.append(root, $('.dc-status-host'));
		const surface = DOM.append(root, $('.dc-provider-surface'));
		this.shell = {
			root,
			status,
			connectedProviders: DOM.append(surface, $('.dc-connected-providers-host')),
			popularProviders: DOM.append(surface, $('.dc-popular-providers-host')),
			models: DOM.append(surface, $('.dc-models-host')),
			diagnostics: DOM.append(surface, $('.dc-diagnostics-host')),
		};
		return this.shell;
	}

	private async refreshSections(shell: ProviderSettingsShell, state: DirectorProviderRegistryState, scope: ProviderSettingsRefreshScope, generation: number): Promise<void> {
		const renderStatus = scope !== 'models';
		const renderConnected = scope === 'all' || scope === 'providersAndModels' || scope === 'connectedAndModels';
		const renderPopular = scope === 'all' || scope === 'providersAndModels';
		const renderModels = scope === 'all' || scope === 'providersAndModels' || scope === 'connectedAndModels' || scope === 'models';
		const renderDiagnostics = scope !== 'models';

		if (renderStatus) {
			if (!await this.replaceRenderedSection(shell.status, this.statusRenderDisposables, generation, parent => this.renderStatusBar(parent, state.instances, state.defaultProviderId, state.defaultModelId))) {
				return;
			}
		}
		if (renderConnected) {
			if (!await this.replaceRenderedSection(shell.connectedProviders, this.connectedRenderDisposables, generation, (parent, disposables) => this.renderConnectedProviders(parent, disposables, state.instances, state.defaultProviderId, state.defaultModelId))) {
				return;
			}
		}
		if (renderPopular) {
			if (!await this.replaceRenderedSection(shell.popularProviders, this.popularRenderDisposables, generation, (parent, disposables) => this.renderPopularProviders(parent, disposables, state.instances))) {
				return;
			}
		}
		if (renderModels) {
			if (!await this.replaceRenderedSection(shell.models, this.modelCatalogDisposables, generation, (parent, disposables) => this.renderModelCatalog(parent, disposables, state.instances, state.defaultProviderId, state.defaultModelId))) {
				return;
			}
		}
		if (renderDiagnostics) {
			await this.replaceRenderedSection(shell.diagnostics, this.diagnosticsRenderDisposables, generation, (parent, disposables) => this.renderDiagnostics(parent, disposables, state.instances.length, state.defaultProviderId, state.defaultModelId));
		}
	}

	private async replaceRenderedSection(parent: HTMLElement, disposables: DisposableStore, generation: number, render: (scratch: HTMLElement, disposables: DisposableStore) => Promise<void> | void): Promise<boolean> {
		const scratch = document.createElement('div');
		const nextDisposables = new DisposableStore();
		try {
			await render(scratch, nextDisposables);
			if (generation !== this.renderGeneration || !this.container?.contains(parent)) {
				nextDisposables.dispose();
				return false;
			}
			disposables.clear();
			DOM.clearNode(parent);
			while (scratch.firstChild) {
				parent.appendChild(scratch.firstChild);
			}
			disposables.add(nextDisposables);
			return true;
		} catch (err) {
			nextDisposables.dispose();
			throw err;
		}
	}

	private handleProviderStateChanged(scope: ProviderSettingsRefreshScope): void {
		if (this.refreshSuppression > 0) {
			return;
		}
		void this.refresh({ preserveScroll: true, scope });
	}

	private async runLocalMutation(operation: () => Promise<void>, scope: ProviderSettingsRefreshScope): Promise<void> {
		this.refreshSuppression++;
		try {
			await operation();
		} finally {
			this.refreshSuppression--;
		}
		await this.refresh({ preserveScroll: true, scope });
	}

	private clearSectionDisposables(): void {
		this.statusRenderDisposables.clear();
		this.connectedRenderDisposables.clear();
		this.popularRenderDisposables.clear();
		this.modelCatalogDisposables.clear();
		this.diagnosticsRenderDisposables.clear();
	}

	private async renderStatusBar(parent: HTMLElement, providers: readonly DirectorStoredProviderInstance[], defaultProviderId: string | undefined, defaultModelId: string | undefined): Promise<void> {
		const provider = providers.find(provider => provider.id === defaultProviderId);
		const models = provider ? await this.modelResolverService.resolveModels(provider) : [];
		const model = models.find(model => model.id === defaultModelId) ?? models[0];
		const authState = await this.getAuthState(provider);
		const statusBar = DOM.append(parent, $('.dc-status-bar'));
		this.appendStatusBarItem(statusBar, localize('directorSettings.statusProvider', "Provider:"), provider?.displayName ?? localize('directorSettings.notConfigured', "Not Configured"));
		this.appendStatusBarItem(statusBar, localize('directorSettings.statusModel', "Model:"), model?.name ?? '-');
		this.appendStatusBarItem(statusBar, localize('directorSettings.statusAuth', "Auth:"), provider ? this.authLabel(provider) : localize('directorSettings.missing', "Missing"));
		const readyLabel = authState.kind === 'ready' || authState.kind === 'none'
			? localize('directorSettings.ready', "Ready")
			: localize('directorSettings.needsConfig', "Needs Config");
		const readyValue = this.appendStatusBarItem(statusBar, localize('directorSettings.statusState', "Status:"), readyLabel);
		readyValue.classList.toggle('dc-ready', authState.kind === 'ready' || authState.kind === 'none');
		readyValue.classList.toggle('dc-not-ready', authState.kind !== 'ready' && authState.kind !== 'none');
	}

	private async renderConnectedProviders(parent: HTMLElement, disposables: DisposableStore, providers: readonly DirectorStoredProviderInstance[], defaultProviderId: string | undefined, defaultModelId: string | undefined): Promise<void> {
		const section = this.createPanel(parent, localize('directorSettings.connectedProviders', "Connected Providers"));
		const list = DOM.append(section, $('.dc-settings-list'));
		if (!providers.length) {
			DOM.append(list, $('.dc-empty-state')).textContent = localize('directorSettings.connectedEmpty', "No providers connected yet.");
			return;
		}

		for (const provider of this.sortProviders(providers)) {
			const authState = await this.getAuthState(provider);
			const models = await this.modelResolverService.resolveModels(provider);
			const row = DOM.append(list, $('.dc-provider-row-flat'));
			row.classList.toggle('dc-provider-row-disabled', !provider.enabled);

			const main = DOM.append(row, $('.dc-provider-main'));
			this.renderProviderIdentity(main, {
				kind: provider.kind,
				name: provider.displayName,
				description: localize('directorSettings.connectedDescription', "{0} / {1} / {2} models", providerLabels[provider.kind], this.authLabel(provider), models.length),
			});

			const tags = DOM.append(main, $('.dc-tag-row'));
			this.createTag(tags, provider.enabled ? localize('directorSettings.connectedTag', "Connected") : localize('directorSettings.disabledTag', "Disabled"), provider.enabled ? 'success' : 'muted');
			this.createTag(tags, authState.kind === 'ready' || authState.kind === 'none' ? localize('directorSettings.authReadyTag', "Ready") : localize('directorSettings.needsAuthTag', "Needs Auth"), authState.kind === 'ready' || authState.kind === 'none' ? 'neutral' : 'danger');
			if (provider.id === defaultProviderId) {
				this.createTag(tags, localize('directorSettings.defaultProviderTag', "Default Provider"), 'accent');
			}
			if (provider.baseURL) {
				this.createTag(tags, provider.baseURL, 'neutral');
			}

			const actions = DOM.append(row, $('.dc-provider-actions'));
			this.addAction(actions, localize('directorSettings.configure', "Configure"), 'secondary', () => this.showProviderDialog({ kind: 'edit', provider }), disposables);
			this.addAction(actions, localize('directorSettings.validate', "Validate"), 'secondary', () => this.validateProvider(provider), disposables);
			if (provider.id !== defaultProviderId && provider.enabled) {
				this.addAction(actions, localize('directorSettings.setDefault', "Set Default"), 'secondary', () => this.setDefaultProvider(provider), disposables);
			}
			this.addAction(actions, provider.enabled ? localize('directorSettings.disable', "Disable") : localize('directorSettings.enable', "Enable"), 'secondary', () => this.toggleProvider(provider), disposables);
			this.addAction(actions, localize('directorSettings.remove', "Remove"), 'danger', () => this.removeProvider(provider), disposables);

			if (provider.id === defaultProviderId && defaultModelId) {
				const defaultModel = models.find(model => model.id === defaultModelId);
				if (defaultModel) {
					const detail = DOM.append(main, $('.dc-provider-desc.dc-provider-default-model'));
					detail.textContent = localize('directorSettings.defaultModelInline', "Default model: {0}", defaultModel.name);
				}
			}
		}
	}

	private renderPopularProviders(parent: HTMLElement, disposables: DisposableStore, providers: readonly DirectorStoredProviderInstance[]): void {
		const section = this.createPanel(parent, localize('directorSettings.popularProviders', "Popular Providers"));
		const list = DOM.append(section, $('.dc-settings-list'));
		const templates = providerTemplates.filter(template => template.allowMultiple || !providers.some(provider =>
			provider.kind === template.kind
			&& provider.authKind === template.authKind
			&& provider.authVariant === template.authVariant
		));

		if (!templates.length) {
			DOM.append(list, $('.dc-empty-state')).textContent = localize('directorSettings.popularEmpty', "All built-in provider templates are already connected.");
			return;
		}

		for (const template of templates) {
			const row = DOM.append(list, $('.dc-provider-row-flat'));
			const main = DOM.append(row, $('.dc-provider-main'));
			this.renderProviderIdentity(main, {
				kind: template.kind,
				name: template.label,
				description: template.note,
			});
			const tags = DOM.append(main, $('.dc-tag-row'));
			if (template.recommended) {
				this.createTag(tags, localize('directorSettings.recommendedTag', "Recommended"), 'accent');
			}
			if (template.custom) {
				this.createTag(tags, localize('directorSettings.customTag', "Custom"), 'neutral');
			}
			if (template.authKind === 'oauth') {
				this.createTag(tags, localize('directorSettings.oauthTag', "OAuth"), 'neutral');
			}

			const actions = DOM.append(row, $('.dc-provider-actions'));
			this.addAction(actions, localize('directorSettings.connect', "Connect"), 'primary', () => this.showProviderDialog({ kind: 'new', template }), disposables);
		}
	}

	private async renderModelCatalog(parent: HTMLElement, disposables: DisposableStore, providers: readonly DirectorStoredProviderInstance[], defaultProviderId: string | undefined, defaultModelId: string | undefined): Promise<void> {
		const section = this.createPanel(parent, localize('directorSettings.models', "Models"));
		const modelRenderDisposables = new DisposableStore();
		disposables.add(modelRenderDisposables);
		const searchRow = DOM.append(section, $('.dc-search-row'));
		DOM.append(searchRow, $('.dc-search-icon')).textContent = localize('directorSettings.searchLabel', "Search");
		const search = DOM.append(searchRow, $<HTMLInputElement>('input.dc-form-input.dc-search-input'));
		search.type = 'text';
		search.placeholder = localize('directorSettings.modelSearch', "Search models");
		search.value = this.modelFilter;
		const modelGroups = DOM.append(section, $('.dc-model-groups'));
		disposables.add(DOM.addDisposableListener(search, 'input', () => {
			this.modelFilter = search.value;
			void this.renderModelGroups(modelGroups, modelRenderDisposables, providers, defaultProviderId, defaultModelId);
		}));
		await this.renderModelGroups(modelGroups, modelRenderDisposables, providers, defaultProviderId, defaultModelId);
	}

	private async renderModelGroups(parent: HTMLElement, disposables: DisposableStore, providers: readonly DirectorStoredProviderInstance[], defaultProviderId: string | undefined, defaultModelId: string | undefined): Promise<void> {
		disposables.clear();
		DOM.clearNode(parent);
		const filter = this.modelFilter.trim().toLowerCase();
		let rendered = false;

		for (const provider of this.sortProviders(providers.filter(provider => provider.enabled))) {
			const models = (await this.getProviderModelRows(provider)).filter(model => {
				if (!filter) {
					return true;
				}
				return model.name.toLowerCase().includes(filter)
					|| model.id.toLowerCase().includes(filter)
					|| model.providerModelId.toLowerCase().includes(filter)
					|| provider.displayName.toLowerCase().includes(filter);
			});
			if (!models.length) {
				continue;
			}

			rendered = true;
			const group = DOM.append(parent, $('.dc-model-group'));
			const groupHeader = DOM.append(group, $('.dc-model-group-header'));
			const title = DOM.append(groupHeader, $('.dc-model-group-title'));
			this.renderProviderIcon(title, provider.kind);
			DOM.append(title, $('span')).textContent = provider.displayName;
			const groupActions = DOM.append(groupHeader, $('.dc-model-group-actions'));
			const groupToggleLabel = DOM.append(groupActions, $<HTMLLabelElement>('label.dc-switch-label'));
			const groupToggle = DOM.append(groupToggleLabel, $<HTMLInputElement>('input.dc-switch'));
			groupToggle.type = 'checkbox';
			groupToggle.checked = models.every(model => model.hidden !== true);
			DOM.append(groupToggleLabel, $('span')).textContent = localize('directorSettings.showAll', "Show All");
			disposables.add(DOM.addDisposableListener(groupToggle, DOM.EventType.CHANGE, () => void this.setProviderModelsVisible(provider, groupToggle.checked)));
			this.addAction(groupActions, localize('directorSettings.refreshModels', "Refresh Models"), 'secondary', () => this.refreshModels(provider), disposables);
			this.addAction(groupActions, localize('directorSettings.configureProvider', "Configure Provider"), 'secondary', () => this.showProviderDialog({ kind: 'edit', provider }), disposables);

			const list = DOM.append(group, $('.dc-settings-list'));
			for (const model of models) {
				const row = DOM.append(list, $('.dc-model-row'));
				const info = DOM.append(row, $('.dc-model-info'));
				DOM.append(info, $('.dc-model-name')).textContent = model.name;
				DOM.append(info, $('.dc-model-meta')).textContent = model.providerModelId ?? model.id;
				const actions = DOM.append(row, $('.dc-model-actions'));
				if (provider.id === defaultProviderId && model.id === defaultModelId && model.hidden !== true) {
					this.createTag(actions, localize('directorSettings.defaultTag', "Default"), 'accent');
				} else {
					const setDefaultButton = this.addAction(actions, localize('directorSettings.setDefault', "Set Default"), 'secondary', () => this.setDefaultModel(provider.id, model.id), disposables);
					setDefaultButton.disabled = model.hidden === true;
					setDefaultButton.title = model.hidden === true ? localize('directorSettings.hiddenModelDefaultDisabled', "Hidden models are not exposed to AgentHost.") : '';
				}
				const visibleLabel = DOM.append(actions, $<HTMLLabelElement>('label.dc-switch-label'));
				const visibleToggle = DOM.append(visibleLabel, $<HTMLInputElement>('input.dc-switch'));
				visibleToggle.type = 'checkbox';
				visibleToggle.checked = model.hidden !== true;
				DOM.append(visibleLabel, $('span')).textContent = model.hidden === true
					? localize('directorSettings.hidden', "Hidden")
					: localize('directorSettings.visible', "Visible");
				disposables.add(DOM.addDisposableListener(visibleToggle, DOM.EventType.CHANGE, () => void this.setModelVisibility(provider, model.providerModelId, visibleToggle.checked)));
				this.createTag(actions, provider.apiType, 'neutral');
			}
		}

		if (!rendered) {
			DOM.append(parent, $('.dc-empty-state')).textContent = filter
				? localize('directorSettings.modelsNoMatches', "No models match '{0}'.", this.modelFilter.trim())
				: localize('directorSettings.modelsEmpty', "Connect a provider to manage models.");
		}
	}

	private async getProviderModelRows(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderModelRow[]> {
		if (provider.models?.length) {
			return provider.models.map(model => {
				const providerModelId = model.providerModelId ?? getProviderModelId(provider.id, model.id);
				return {
					id: makeDirectorProviderModelKey(provider.id, providerModelId),
					providerModelId,
					name: model.name ?? providerModelId,
					family: model.family,
					hidden: model.hidden,
					maxContextWindow: model.maxContextWindow,
					supportsVision: model.supportsVision,
					capabilities: model.capabilities,
				};
			});
		}

		const models = await this.modelResolverService.resolveModels(provider);
		return models.map(model => ({
			id: model.id,
			providerModelId: model.providerModelId ?? getProviderModelId(provider.id, model.id),
			name: model.name,
			family: model.family,
			maxContextWindow: model.maxContextWindow,
			supportsVision: model.supportsVision,
			capabilities: model.capabilities,
		}));
	}

	private async renderDiagnostics(parent: HTMLElement, disposables: DisposableStore, providerCount: number, defaultProviderId: string | undefined, defaultModelId: string | undefined): Promise<void> {
		const section = this.createPanel(parent, localize('directorSettings.diagnostics', "Snapshot"));
		const list = DOM.append(section, $('.dc-settings-list'));
		const row = DOM.append(list, $('.dc-provider-row-flat'));
		const main = DOM.append(row, $('.dc-provider-main'));
		DOM.append(main, $('.dc-provider-name')).textContent = localize('directorSettings.snapshotTitle', "AgentHost Provider Snapshot");
		DOM.append(main, $('.dc-provider-desc')).textContent = localize('directorSettings.snapshotDescription', "{0} providers. Default provider: {1}. Default model: {2}.", providerCount, defaultProviderId ?? localize('directorSettings.none', "None"), defaultModelId ?? localize('directorSettings.none', "None"));
		const tags = DOM.append(main, $('.dc-tag-row'));
		this.createTag(tags, await this.snapshotService.getSnapshotResource(), 'neutral');
		const actions = DOM.append(row, $('.dc-provider-actions'));
		this.addAction(actions, localize('directorSettings.refreshSnapshot', "Refresh Snapshot"), 'secondary', () => this.refreshSnapshot(), disposables);
		this.addAction(actions, localize('directorSettings.showSnapshot', "Show Location"), 'secondary', () => this.showSnapshotLocation(), disposables);
	}

	private showProviderDialog(mode: ProviderDialogMode): void {
		if ((mode.kind === 'new' && mode.template.authKind === 'oauth') || (mode.kind === 'edit' && mode.provider.authKind === 'oauth')) {
			this.showOAuthDialog(mode);
			return;
		}
		void this.showApiKeyProviderDialog(mode);
	}

	private async showApiKeyProviderDialog(mode: ProviderDialogMode): Promise<void> {
		const isEdit = mode.kind === 'edit';
		const provider = isEdit ? mode.provider : undefined;
		const template = mode.kind === 'new' ? mode.template : this.templateForProvider(provider!);
		const state = await this.registryService.getState();
		const hasStoredKey = provider ? await this.apiKeyService.hasProviderInstanceKey(provider.id) : false;
		const modelIds = provider?.models?.length
			? provider.models.map(model => model.providerModelId ?? getProviderModelId(provider.id, model.id))
			: [template.defaultModelId];

		this.showDialog(isEdit ? localize('directorSettings.configureProviderTitle', "Configure {0}", provider!.displayName) : localize('directorSettings.connectProviderTitle', "Connect {0}", template.label), (body, footer, close) => {
			const form = DOM.append(body, $('.dc-dialog-form'));
			const idInput = this.createInputRow(form, localize('directorSettings.providerId', "Provider ID"), 'my-provider');
			idInput.value = provider?.id ?? this.uniqueProviderId(sanitizeDirectorProviderId(template.label), state.instances);
			idInput.disabled = isEdit;
			DOM.append(idInput.parentElement!, $('.dc-form-hint')).textContent = localize('directorSettings.providerIdHint', "Stable key for models and secrets. It cannot be changed after saving.");

			const displayNameInput = this.createInputRow(form, localize('directorSettings.displayName', "Display Name"), template.label);
			displayNameInput.value = provider?.displayName ?? template.label;

			const enabledRow = DOM.append(form, $('.dc-form-row.dc-inline-form-row'));
			const enabledLabel = DOM.append(enabledRow, $<HTMLLabelElement>('label.dc-switch-label'));
			const enabledInput = DOM.append(enabledLabel, $<HTMLInputElement>('input.dc-switch'));
			enabledInput.type = 'checkbox';
			enabledInput.checked = provider?.enabled ?? true;
			DOM.append(enabledLabel, $('span')).textContent = localize('directorSettings.enabled', "Enabled");

			const providerSelect = this.createSelectRow(form, localize('directorSettings.providerKind', "Provider Type"), apiKeyProviderTemplates.map(template => ({ value: template.kind, label: template.label })));
			providerSelect.value = provider?.kind ?? template.kind;
			providerSelect.disabled = isEdit;

			const baseURLInput = this.createInputRow(form, localize('directorSettings.baseURL', "Base URL"), template.baseURL ?? 'https://api.example.com/v1');
			baseURLInput.value = provider?.baseURL ?? template.baseURL ?? '';

			const keyInput = this.createInputRow(form, localize('directorSettings.apiKey', "API Key"), hasStoredKey ? localize('directorSettings.apiKeyStoredPlaceholder', "Stored. Leave blank to keep it.") : 'sk-...');
			keyInput.type = 'password';
			keyInput.classList.add('dc-api-key-input');
			DOM.append(keyInput.parentElement!, $('.dc-form-hint')).textContent = hasStoredKey
				? localize('directorSettings.apiKeyStoredHint', "A key is already stored. Enter a new key only to replace it.")
				: localize('directorSettings.apiKeyNewHint', "Stored in VS Code SecretStorage, not in the registry JSON.");

			const headersTextArea = this.createTextAreaRow(form, localize('directorSettings.headers', "Custom Headers"), 'X-Provider-Header: value', 3);
			headersTextArea.value = formatHeaders(provider?.headers);
			DOM.append(headersTextArea.parentElement!, $('.dc-form-hint')).textContent = localize('directorSettings.headersHint', "Optional. One header per line. Sensitive headers are omitted from snapshots.");

			const modelsTextArea = this.createTextAreaRow(form, localize('directorSettings.modelList', "Models"), localize('directorSettings.modelsPlaceholder', "One model ID per line. Example: gpt-4o"), 6);
			modelsTextArea.value = modelIds.join('\n');

			const defaultModelSelect = this.createSelectRow(form, localize('directorSettings.defaultModel', "Default Model"), []);
			this.populateDefaultModelSelect(defaultModelSelect, this.parseModelIds(modelsTextArea.value), provider?.defaultModelId ? getProviderModelId(provider.id, provider.defaultModelId) : template.defaultModelId);

			const status = DOM.append(form, $('.dc-dialog-status'));
			const setStatus = (message: string, kind: StatusKind = 'info') => this.setStatus(status, message, kind);
			if (hasStoredKey) {
				setStatus(localize('directorSettings.apiKeyConfigured', "API key is stored for this provider."), 'success');
			}

			this.modalDisposables.add(DOM.addDisposableListener(providerSelect, 'change', () => {
				const nextTemplate = this.templateForKind(providerSelect.value as DirectorProviderKind);
				if (nextTemplate) {
					baseURLInput.value = nextTemplate.baseURL ?? '';
					modelsTextArea.value = nextTemplate.defaultModelId;
					this.populateDefaultModelSelect(defaultModelSelect, [nextTemplate.defaultModelId], nextTemplate.defaultModelId);
				}
			}));
			this.modalDisposables.add(DOM.addDisposableListener(modelsTextArea, 'input', () => {
				this.populateDefaultModelSelect(defaultModelSelect, this.parseModelIds(modelsTextArea.value), defaultModelSelect.value);
			}));

			this.addModalAction(footer, localize('directorSettings.cancel', "Cancel"), 'secondary', close);
			this.addModalAction(footer, localize('directorSettings.validateSetup', "Validate Setup"), 'secondary', () => {
				this.validateApiKeyDialog({
					existing: provider,
					hasStoredKey,
					providerSelect,
					baseURLInput,
					keyInput,
					modelsTextArea,
					defaultModelSelect,
					status: setStatus,
				});
			});
			this.addModalAction(footer, localize('directorSettings.refreshModels', "Refresh Models"), 'secondary', () => {
				void this.refreshModelFieldsFromDialog({
					existing: provider,
					stateProviders: state.instances,
					idInput,
					displayNameInput,
					enabledInput,
					keyInput,
					providerSelect,
					baseURLInput,
					headersTextArea,
					modelsTextArea,
					defaultModelSelect,
					status: setStatus,
				});
			});
			if (isEdit) {
				this.addModalAction(footer, localize('directorSettings.deleteProvider', "Delete"), 'danger', () => {
					void this.removeProvider(provider!).then(close);
				});
			}
			this.addModalAction(footer, isEdit ? localize('directorSettings.saveProvider', "Save") : localize('directorSettings.connect', "Connect"), 'primary', () => {
				void this.saveApiKeyProviderFromDialog({
					existing: provider,
					stateProviders: state.instances,
					idInput,
					displayNameInput,
					enabledInput,
					providerSelect,
					baseURLInput,
					keyInput,
					headersTextArea,
					modelsTextArea,
					defaultModelSelect,
					status: setStatus,
					close,
				});
			});
		});
	}

	private showOAuthDialog(mode: ProviderDialogMode): void {
		const provider = mode.kind === 'edit' ? mode.provider : undefined;
		const template = mode.kind === 'new' ? mode.template : this.templateForProvider(provider!);

		this.showDialog(provider ? localize('directorSettings.configureProviderTitle', "Configure {0}", provider.displayName) : localize('directorSettings.connectProviderTitle', "Connect {0}", template.label), (body, footer, close) => {
			const form = DOM.append(body, $('.dc-dialog-form'));
			const header = DOM.append(form, $('.dc-oauth-dialog-header'));
			this.renderProviderIcon(header, template.kind);
			DOM.append(header, $('.dc-oauth-dialog-title')).textContent = template.label;
			DOM.append(form, $('.dc-section-subtitle')).textContent = template.note;

			const idInput = this.createInputRow(form, localize('directorSettings.providerId', "Provider ID"), 'openai-codex');
			idInput.value = provider?.id ?? 'openai-codex';
			idInput.disabled = !!provider;
			const displayNameInput = this.createInputRow(form, localize('directorSettings.displayName', "Display Name"), template.label);
			displayNameInput.value = provider?.displayName ?? template.label;
			const status = DOM.append(form, $('.dc-dialog-status'));
			const setStatus = (message: string, kind: StatusKind = 'info') => this.setStatus(status, message, kind);
			void this.getAuthState(provider).then(authState => {
				setStatus(authState.kind === 'ready'
					? localize('directorSettings.oauthReady', "OAuth state is ready.")
					: localize('directorSettings.oauthSignedOut', "OAuth state is signed out."),
					authState.kind === 'ready' ? 'success' : 'info');
			});

			this.addModalAction(footer, localize('directorSettings.cancel', "Cancel"), 'secondary', close);
			if (provider) {
				this.addModalAction(footer, localize('directorSettings.validateSetup', "Validate Setup"), 'secondary', () => void this.validateProvider(provider, setStatus));
				this.addModalAction(footer, localize('directorSettings.signOut', "Sign Out"), 'secondary', () => void this.oauthService.signOutOpenAICodex(provider.id).then(() => {
					void this.snapshotService.writeSnapshot();
					setStatus(localize('directorSettings.oauthSignedOut', "OAuth state is signed out."), 'info');
				}));
				this.addModalAction(footer, localize('directorSettings.signIn', "Sign In"), 'primary', () => void this.oauthService.signInOpenAICodex(provider.id).then(() => {
					void this.snapshotService.writeSnapshot();
					setStatus(localize('directorSettings.oauthReady', "OAuth state is ready."), 'success');
				}));
				this.addModalAction(footer, localize('directorSettings.deleteProvider', "Delete"), 'danger', () => {
					void this.removeProvider(provider).then(close);
				});
				return;
			}

			this.addModalAction(footer, localize('directorSettings.connect', "Connect"), 'primary', () => {
				void this.saveOAuthProviderFromDialog(template, idInput, displayNameInput, setStatus, close);
			});
		});
	}

	private async saveApiKeyProviderFromDialog(args: {
		readonly existing: DirectorStoredProviderInstance | undefined;
		readonly stateProviders: readonly DirectorStoredProviderInstance[];
		readonly idInput: HTMLInputElement;
		readonly displayNameInput: HTMLInputElement;
		readonly enabledInput: HTMLInputElement;
		readonly providerSelect: HTMLSelectElement;
		readonly baseURLInput: HTMLInputElement;
		readonly keyInput: HTMLInputElement;
		readonly headersTextArea: HTMLTextAreaElement;
		readonly modelsTextArea: HTMLTextAreaElement;
		readonly defaultModelSelect: HTMLSelectElement;
		readonly status: (message: string, kind?: StatusKind) => void;
		readonly close: () => void;
	}): Promise<void> {
		const id = sanitizeDirectorProviderId(args.idInput.value);
		if (!id) {
			args.status(localize('directorSettings.providerIdRequired', "Provider ID is required."), 'error');
			return;
		}
		if (!args.existing && args.stateProviders.some(provider => provider.id === id)) {
			args.status(localize('directorSettings.providerIdDuplicate', "Provider ID already exists."), 'error');
			return;
		}
		const existingHasKey = args.existing ? await this.apiKeyService.hasProviderInstanceKey(args.existing.id) : false;
		if (!args.keyInput.value.trim() && !existingHasKey) {
			args.status(localize('directorSettings.apiKeyRequired', "API key is required."), 'error');
			return;
		}
		const modelIds = this.parseModelIds(args.modelsTextArea.value);
		if (!modelIds.length) {
			args.status(localize('directorSettings.modelsRequired', "Add at least one model."), 'error');
			return;
		}

		const now = Date.now();
		const kind = args.providerSelect.value as DirectorProviderKind;
		const defaultProviderModelId = args.defaultModelSelect.value || modelIds[0];
		const models = this.buildModelEntries(id, modelIds, args.existing?.models);
		const defaultModelId = this.pickDefaultStoredModel(models, defaultProviderModelId)?.id;
		const provider: DirectorStoredProviderInstance = {
			id,
			kind,
			displayName: args.displayNameInput.value.trim() || providerLabels[kind] || id,
			enabled: args.enabledInput.checked,
			authKind: 'api-key',
			apiType: this.apiTypeForKind(kind),
			baseURL: args.baseURLInput.value.trim() || undefined,
			headers: sanitizeDirectorProviderHeaders(parseHeadersValue(args.headersTextArea.value)),
			models,
			defaultModelId,
			createdAt: args.existing?.createdAt ?? now,
			updatedAt: now,
		};

		const nextApiKey = args.keyInput.value.trim();
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider(provider);
			if (nextApiKey) {
				await this.apiKeyService.setProviderInstanceKey(provider.id, nextApiKey);
				args.keyInput.value = '';
			}
			if (!args.existing || !(await this.registryService.getState()).defaultProviderId) {
				await this.registryService.setDefaults(provider.id, provider.defaultModelId);
			}
			await this.snapshotService.writeSnapshot();
		}, 'providersAndModels');
		args.status(localize('directorSettings.savedProvider', "Saved {0}.", provider.displayName), 'success');
		args.close();
		this.notificationService.info(localize('directorSettings.savedProvider', "Saved {0}.", provider.displayName));
	}

	private async refreshModelFieldsFromDialog(args: {
		readonly existing: DirectorStoredProviderInstance | undefined;
		readonly stateProviders: readonly DirectorStoredProviderInstance[];
		readonly idInput: HTMLInputElement;
		readonly displayNameInput: HTMLInputElement;
		readonly enabledInput: HTMLInputElement;
		readonly keyInput: HTMLInputElement;
		readonly providerSelect: HTMLSelectElement;
		readonly baseURLInput: HTMLInputElement;
		readonly headersTextArea: HTMLTextAreaElement;
		readonly modelsTextArea: HTMLTextAreaElement;
		readonly defaultModelSelect: HTMLSelectElement;
		readonly status: (message: string, kind?: StatusKind) => void;
	}): Promise<void> {
		const id = sanitizeDirectorProviderId(args.idInput.value);
		if (!id) {
			args.status(localize('directorSettings.providerIdRequired', "Provider ID is required."), 'error');
			return;
		}
		if (!args.existing && args.stateProviders.some(provider => provider.id === id)) {
			args.status(localize('directorSettings.providerIdDuplicate', "Provider ID already exists."), 'error');
			return;
		}
		const existingHasKey = args.existing ? await this.apiKeyService.hasProviderInstanceKey(args.existing.id) : false;
		if (!args.keyInput.value.trim() && !existingHasKey) {
			args.status(localize('directorSettings.refreshModelsMissingCredential', "Saved provider credentials are required before models can be refreshed."), 'error');
			return;
		}

		const kind = args.providerSelect.value as DirectorProviderKind;
		const existingModelIds = this.parseModelIds(args.modelsTextArea.value);
		const template = this.templateForKind(kind);
		const seedModelIds = existingModelIds.length ? existingModelIds : template ? [template.defaultModelId] : ['model'];
		const now = Date.now();
		const provider: DirectorStoredProviderInstance = {
			id,
			kind,
			displayName: args.displayNameInput.value.trim() || providerLabels[kind] || id,
			enabled: args.enabledInput.checked,
			authKind: 'api-key',
			apiType: this.apiTypeForKind(kind),
			baseURL: args.baseURLInput.value.trim() || undefined,
			headers: sanitizeDirectorProviderHeaders(parseHeadersValue(args.headersTextArea.value)),
			models: this.buildModelEntries(id, seedModelIds, args.existing?.models),
			defaultModelId: seedModelIds[0] ? makeDirectorProviderModelKey(id, seedModelIds[0]) : undefined,
			createdAt: args.existing?.createdAt ?? now,
			updatedAt: now,
		};
		args.status(localize('directorSettings.refreshingModels', "Refreshing models..."));
		const nextApiKey = args.keyInput.value.trim();
		this.refreshSuppression++;
		try {
			await this.registryService.saveProvider(provider);
			if (nextApiKey) {
				await this.apiKeyService.setProviderInstanceKey(provider.id, nextApiKey);
				args.keyInput.value = '';
			}
		} finally {
			this.refreshSuppression--;
		}
		let refreshedModels: readonly DirectorStoredProviderModel[];
		try {
			refreshedModels = await this.modelResolverService.refreshModels(provider);
		} catch (err) {
			args.status(err instanceof Error ? err.message : String(err), 'error');
			return;
		}
		const preferredModelId = args.defaultModelSelect.value || seedModelIds[0];
		const defaultModelId = this.pickDefaultStoredModel(refreshedModels, preferredModelId)?.id;
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider({
				...provider,
				models: refreshedModels,
				...(defaultModelId !== undefined ? { defaultModelId } : {}),
				updatedAt: Date.now(),
			});
			if (!(await this.registryService.getState()).defaultProviderId) {
				await this.registryService.setDefaults(provider.id, defaultModelId);
			}
			await this.snapshotService.writeSnapshot();
		}, 'providersAndModels');
		const providerModelIds = refreshedModels.map(model => model.providerModelId ?? getProviderModelId(provider.id, model.id));
		args.modelsTextArea.value = providerModelIds.join('\n');
		this.populateDefaultModelSelect(args.defaultModelSelect, providerModelIds, defaultModelId ? getProviderModelId(provider.id, defaultModelId) : providerModelIds[0]);
		args.status(localize('directorSettings.refreshModelsSuccess', "Refreshed {0} models.", providerModelIds.length), 'success');
	}

	private async saveOAuthProviderFromDialog(template: DirectorProviderTemplate, idInput: HTMLInputElement, displayNameInput: HTMLInputElement, status: (message: string, kind?: StatusKind) => void, close: () => void): Promise<void> {
		const id = sanitizeDirectorProviderId(idInput.value);
		if (!id) {
			status(localize('directorSettings.providerIdRequired', "Provider ID is required."), 'error');
			return;
		}
		if (await this.registryService.getProvider(id)) {
			status(localize('directorSettings.providerIdDuplicate', "Provider ID already exists."), 'error');
			return;
		}

		const provider = createDirectorProviderInstance({
			id,
			kind: template.kind,
			displayName: displayNameInput.value.trim() || template.label,
			authKind: 'oauth',
			apiType: template.apiType,
			authVariant: template.authVariant,
			baseURL: template.baseURL,
			modelId: template.defaultModelId,
		});
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider(provider);
			await this.oauthService.signInOpenAICodex(provider.id);
			await this.registryService.setDefaults(provider.id, provider.defaultModelId);
			await this.snapshotService.writeSnapshot();
		}, 'providersAndModels');
		status(localize('directorSettings.connectedProvider', "Connected {0}.", provider.displayName), 'success');
		close();
		this.notificationService.info(localize('directorSettings.connectedProvider', "Connected {0}.", provider.displayName));
	}

	private async validateProvider(provider: DirectorStoredProviderInstance, setStatus?: (message: string, kind?: StatusKind) => void): Promise<void> {
		const result = await this.connectionTestService.validateProviderSetup(provider, provider.defaultModelId);
		if (result.status === 'ok' && result.request) {
			const message = localize('directorSettings.validationOk', "{0} Template: {1} {2}", result.message, result.request.method, result.request.url);
			setStatus?.(message, 'success');
			this.notificationService.info(message);
			return;
		}
		setStatus?.(result.message, result.status === 'missingAuth' ? 'error' : 'info');
		this.notificationService.notify({
			severity: result.status === 'missingAuth' ? Severity.Warning : Severity.Info,
			message: result.message,
		});
	}

	private async setDefaultProvider(provider: DirectorStoredProviderInstance): Promise<void> {
		const models = await this.modelResolverService.resolveModels(provider);
		const modelId = provider.defaultModelId ?? models[0]?.id;
		await this.setDefaultModel(provider.id, modelId);
	}

	private async setDefaultModel(providerId: string, modelId: string | undefined): Promise<void> {
		await this.runLocalMutation(async () => {
			await this.registryService.setDefaults(providerId, modelId);
			await this.snapshotService.writeSnapshot();
		}, 'connectedAndModels');
		this.notificationService.info(localize('directorSettings.defaultUpdated', "Director default provider and model updated."));
	}

	private async toggleProvider(provider: DirectorStoredProviderInstance): Promise<void> {
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider({ ...provider, enabled: !provider.enabled, updatedAt: Date.now() });
			await this.snapshotService.writeSnapshot();
		}, 'connectedAndModels');
	}

	private async refreshModels(provider: DirectorStoredProviderInstance): Promise<void> {
		const refreshedModels = await this.modelResolverService.refreshModels(provider);
		const previousByProviderModelId = new Map<string, DirectorStoredProviderModel>();
		for (const model of provider.models ?? []) {
			previousByProviderModelId.set(model.providerModelId ?? getProviderModelId(provider.id, model.id), model);
		}
		const models = refreshedModels.map(model => {
			const previous = previousByProviderModelId.get(model.providerModelId ?? getProviderModelId(provider.id, model.id));
			return {
				...model,
				...(previous?.hidden !== undefined ? { hidden: previous.hidden } : {}),
			};
		});
		const preferredModelId = provider.defaultModelId ? getProviderModelId(provider.id, provider.defaultModelId) : undefined;
		const defaultModelId = this.pickDefaultStoredModel(models, preferredModelId)?.id;
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider({
				...provider,
				models,
				...(defaultModelId !== undefined ? { defaultModelId } : {}),
				updatedAt: Date.now(),
			});
			await this.snapshotService.writeSnapshot();
		}, 'connectedAndModels');
		this.notificationService.info(localize('directorSettings.modelsRefreshed', "Director models refreshed for '{0}'.", provider.displayName));
	}

	private async setModelVisibility(provider: DirectorStoredProviderInstance, providerModelId: string, visible: boolean): Promise<void> {
		const models = await this.getProviderModelRows(provider);
		const targetModelId = makeDirectorProviderModelKey(provider.id, providerModelId);
		const nextModels = this.toStoredModels(models.map(model => ({
			...model,
			hidden: model.providerModelId === providerModelId ? !visible : model.hidden,
		})));
		const currentDefaultIsVisible = provider.defaultModelId !== undefined && nextModels.some(model => model.id === provider.defaultModelId && model.hidden !== true);
		const nextDefaultModelId = provider.defaultModelId === targetModelId && !visible
			? nextModels.find(model => model.hidden !== true)?.id
			: visible && !currentDefaultIsVisible
				? targetModelId
				: provider.defaultModelId;
		const defaultMayChange = provider.defaultModelId !== nextDefaultModelId;
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider({
				...provider,
				models: nextModels,
				defaultModelId: nextDefaultModelId,
				updatedAt: Date.now(),
			});
			const state = await this.registryService.getState();
			if (state.defaultProviderId === provider.id && state.defaultModelId === targetModelId && !visible) {
				await this.registryService.setDefaults(provider.id, nextDefaultModelId);
			}
			await this.snapshotService.writeSnapshot();
		}, defaultMayChange ? 'connectedAndModels' : 'models');
	}

	private async setProviderModelsVisible(provider: DirectorStoredProviderInstance, visible: boolean): Promise<void> {
		const models = await this.getProviderModelRows(provider);
		const nextModels = this.toStoredModels(models.map(model => ({
			...model,
			hidden: !visible,
		})));
		const nextDefaultModelId = visible ? provider.defaultModelId ?? nextModels[0]?.id : undefined;
		await this.runLocalMutation(async () => {
			await this.registryService.saveProvider({
				...provider,
				models: nextModels,
				defaultModelId: nextDefaultModelId,
				updatedAt: Date.now(),
			});
			const state = await this.registryService.getState();
			if (state.defaultProviderId === provider.id && !visible) {
				await this.registryService.setDefaults(provider.id, undefined);
			}
			await this.snapshotService.writeSnapshot();
		}, 'connectedAndModels');
	}

	private async removeProvider(provider: DirectorStoredProviderInstance): Promise<void> {
		await this.runLocalMutation(async () => {
			await this.registryService.removeProvider(provider.id);
			await this.apiKeyService.deleteProviderInstanceKey(provider.id);
			if (provider.authKind === 'oauth') {
				await this.oauthService.signOutOpenAICodex(provider.id);
			}
			await this.snapshotService.writeSnapshot();
		}, 'providersAndModels');
		this.notificationService.info(localize('directorSettings.providerRemoved', "Director provider '{0}' removed.", provider.displayName));
	}

	private async refreshSnapshot(): Promise<void> {
		await this.runLocalMutation(async () => {
			await this.snapshotService.writeSnapshot();
		}, 'all');
		this.notificationService.info(localize('directorSettings.snapshotRefreshed', "Director provider snapshot refreshed."));
	}

	private async showSnapshotLocation(): Promise<void> {
		this.notificationService.info(await this.snapshotService.getSnapshotResource());
	}

	private getAuthState(provider: DirectorStoredProviderInstance | undefined): Promise<DirectorProviderAuthState> {
		if (!provider) {
			return Promise.resolve({ kind: 'signedOut', updatedAt: Date.now() });
		}
		if (provider.authKind === 'api-key') {
			return this.apiKeyService.getAuthState(provider);
		}
		if (provider.authKind === 'oauth' || provider.authKind === 'bearer') {
			return this.oauthService.getAuthState(provider);
		}
		return Promise.resolve({ kind: 'none', updatedAt: Date.now() });
	}

	private authLabel(provider: DirectorStoredProviderInstance): string {
		if (provider.authKind === 'oauth') {
			return provider.authVariant === 'openai-codex' ? 'ChatGPT/Codex OAuth' : 'OAuth';
		}
		if (provider.authKind === 'api-key') {
			return 'API Key';
		}
		if (provider.authKind === 'bearer') {
			return 'Bearer';
		}
		return 'None';
	}

	private templateForProvider(provider: DirectorStoredProviderInstance): DirectorProviderTemplate {
		return providerTemplates.find(template => template.kind === provider.kind && template.authKind === provider.authKind && template.authVariant === provider.authVariant)
			?? {
			id: provider.id,
			kind: provider.kind,
			apiType: provider.apiType,
			authKind: provider.authKind,
			authVariant: provider.authVariant,
			label: provider.displayName,
			note: this.authLabel(provider),
			baseURL: provider.baseURL,
			defaultModelId: provider.models?.[0]?.providerModelId ?? provider.defaultModelId ?? 'model',
		};
	}

	private templateForKind(kind: DirectorProviderKind): DirectorProviderTemplate | undefined {
		return apiKeyProviderTemplates.find(template => template.kind === kind);
	}

	private apiTypeForKind(kind: DirectorProviderKind): DirectorProviderApiType {
		return this.templateForKind(kind)?.apiType ?? 'custom-http';
	}

	private validateApiKeyDialog(args: {
		readonly existing: DirectorStoredProviderInstance | undefined;
		readonly hasStoredKey: boolean;
		readonly providerSelect: HTMLSelectElement;
		readonly baseURLInput: HTMLInputElement;
		readonly keyInput: HTMLInputElement;
		readonly modelsTextArea: HTMLTextAreaElement;
		readonly defaultModelSelect: HTMLSelectElement;
		readonly status: (message: string, kind?: StatusKind) => void;
	}): void {
		const kind = args.providerSelect.value as DirectorProviderKind;
		const apiType = this.apiTypeForKind(kind);
		const baseURL = args.baseURLInput.value.trim();
		if (!baseURL && apiType !== 'local') {
			args.status(localize('directorSettings.baseURLRequired', "Base URL is required."), 'error');
			return;
		}
		if (!args.keyInput.value.trim() && !args.hasStoredKey && args.existing?.authKind !== 'none') {
			args.status(localize('directorSettings.apiKeyRequired', "API key is required."), 'error');
			return;
		}
		const modelIds = this.parseModelIds(args.modelsTextArea.value);
		const modelId = args.defaultModelSelect.value || modelIds[0];
		if (!modelId) {
			args.status(localize('directorSettings.modelsRequired', "Add at least one model."), 'error');
			return;
		}
		const request = buildDirectorConnectionTestRequest(apiType, baseURL, modelId, '<redacted>');
		args.status(localize('directorSettings.validationTemplate', "Request template: {0} {1}", request.method, request.url), 'success');
	}

	private buildModelEntries(providerId: string, modelIds: readonly string[], existingModels?: readonly DirectorStoredProviderModel[]): readonly DirectorStoredProviderModel[] {
		const existingByProviderModelId = new Map<string, DirectorStoredProviderModel>();
		for (const model of existingModels ?? []) {
			existingByProviderModelId.set(model.providerModelId ?? getProviderModelId(providerId, model.id), model);
		}
		return modelIds.map(modelId => {
			const existing = existingByProviderModelId.get(modelId);
			return {
				id: makeDirectorProviderModelKey(providerId, modelId),
				providerModelId: modelId,
				name: existing?.name ?? modelId,
				...(existing?.family !== undefined ? { family: existing.family } : {}),
				...(existing?.hidden !== undefined ? { hidden: existing.hidden } : {}),
				...(existing?.maxContextWindow !== undefined ? { maxContextWindow: existing.maxContextWindow } : {}),
				...(existing?.supportsVision !== undefined ? { supportsVision: existing.supportsVision } : {}),
				...(existing?.capabilities !== undefined ? { capabilities: existing.capabilities } : {}),
			};
		});
	}

	private toStoredModels(models: readonly DirectorProviderModelRow[]): readonly DirectorStoredProviderModel[] {
		return models.map(model => ({
			id: model.id,
			providerModelId: model.providerModelId,
			name: model.name,
			...(model.family !== undefined ? { family: model.family } : {}),
			...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
			...(model.maxContextWindow !== undefined ? { maxContextWindow: model.maxContextWindow } : {}),
			...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
			...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {}),
		}));
	}

	private pickDefaultStoredModel(models: readonly DirectorStoredProviderModel[], preferredProviderModelId: string | undefined): DirectorStoredProviderModel | undefined {
		if (preferredProviderModelId !== undefined) {
			const preferred = models.find(model => (model.providerModelId ?? model.id) === preferredProviderModelId);
			if (preferred?.hidden !== true) {
				return preferred;
			}
		}
		return models.find(model => model.hidden !== true);
	}

	private parseModelIds(value: string): string[] {
		return Array.from(new Set(value
			.split(/[\n,]+/g)
			.map(model => model.trim())
			.filter(model => model.length > 0)));
	}

	private populateDefaultModelSelect(select: HTMLSelectElement, modelIds: readonly string[], preferred: string | undefined): void {
		DOM.clearNode(select);
		for (const modelId of modelIds) {
			this.appendOption(select, modelId, modelId);
		}
		if (preferred && modelIds.includes(preferred)) {
			select.value = preferred;
		} else if (modelIds[0]) {
			select.value = modelIds[0];
		}
	}

	private uniqueProviderId(base: string, providers: readonly DirectorStoredProviderInstance[]): string {
		const used = new Set(providers.map(provider => provider.id));
		const root = sanitizeDirectorProviderId(base) || 'provider';
		if (!used.has(root)) {
			return root;
		}
		for (let index = 2; index < 1000; index++) {
			const candidate = `${root}-${index}`;
			if (!used.has(candidate)) {
				return candidate;
			}
		}
		return `${root}-${Date.now().toString(36)}`;
	}

	private sortProviders(providers: readonly DirectorStoredProviderInstance[]): readonly DirectorStoredProviderInstance[] {
		return [...providers].sort((left, right) => {
			if (left.enabled !== right.enabled) {
				return left.enabled ? -1 : 1;
			}
			return left.displayName.localeCompare(right.displayName);
		});
	}

	private renderProviderIdentity(parent: HTMLElement, provider: { readonly kind: DirectorProviderKind; readonly name: string; readonly description: string }): void {
		const row = DOM.append(parent, $('.dc-provider-identity'));
		this.renderProviderIcon(row, provider.kind);
		const text = DOM.append(row, $('.dc-provider-text'));
		DOM.append(text, $('.dc-provider-name')).textContent = provider.name;
		DOM.append(text, $('.dc-provider-desc')).textContent = provider.description;
	}

	private renderProviderIcon(parent: HTMLElement, provider: DirectorProviderKind): void {
		const icon = DOM.append(parent, $('.dc-provider-icon'));
		icon.textContent = providerLabels[provider].slice(0, 1).toUpperCase();
		icon.classList.add(`dc-provider-icon-${provider.replace(/[^a-z0-9]+/g, '-')}`);
	}

	private createPanel(parent: HTMLElement, title: string, subtitle?: string): HTMLElement {
		const section = DOM.append(parent, $('.dc-settings-panel'));
		const header = DOM.append(section, $('.dc-settings-panel-header'));
		DOM.append(header, $('.dc-settings-panel-title')).textContent = title;
		if (subtitle) {
			DOM.append(header, $('.dc-section-subtitle')).textContent = subtitle;
		}
		return section;
	}

	private createTag(parent: HTMLElement, label: string, tone: 'neutral' | 'accent' | 'success' | 'danger' | 'muted'): HTMLElement {
		const tag = DOM.append(parent, $(`.dc-tag.dc-tag-${tone}`));
		tag.textContent = label;
		return tag;
	}

	private appendStatusBarItem(parent: HTMLElement, label: string, value: string): HTMLElement {
		const item = DOM.append(parent, $('.dc-status-bar-item'));
		DOM.append(item, $('.dc-status-bar-label')).textContent = label;
		const valueElement = DOM.append(item, $('.dc-status-bar-value'));
		valueElement.textContent = value;
		return valueElement;
	}

	private createSelectRow(parent: HTMLElement, labelText: string, options: readonly { readonly value: string; readonly label: string }[]): HTMLSelectElement {
		const row = DOM.append(parent, $('.dc-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.dc-form-label')).textContent = labelText;
		const select = DOM.append(row, $<HTMLSelectElement>('select.dc-form-select'));
		for (const option of options) {
			this.appendOption(select, option.value, option.label);
		}
		return select;
	}

	private createInputRow(parent: HTMLElement, labelText: string, placeholder: string, type: string = 'text'): HTMLInputElement {
		const row = DOM.append(parent, $('.dc-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.dc-form-label')).textContent = labelText;
		const input = DOM.append(row, $<HTMLInputElement>('input.dc-form-input'));
		input.type = type;
		input.placeholder = placeholder;
		input.autocomplete = 'off';
		return input;
	}

	private createTextAreaRow(parent: HTMLElement, labelText: string, placeholder: string, rows: number): HTMLTextAreaElement {
		const row = DOM.append(parent, $('.dc-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.dc-form-label')).textContent = labelText;
		const textArea = DOM.append(row, $<HTMLTextAreaElement>('textarea.dc-form-input'));
		textArea.rows = rows;
		textArea.placeholder = placeholder;
		return textArea;
	}

	private createButton(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'danger' = 'secondary'): HTMLButtonElement {
		const button = DOM.append(parent, $<HTMLButtonElement>(`button.dc-btn.dc-btn-${variant}`));
		button.type = 'button';
		button.textContent = label;
		return button;
	}

	private addAction(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'danger', run: () => Promise<void> | void, disposables: DisposableStore): HTMLButtonElement {
		const button = this.createButton(parent, label, variant);
		disposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			void Promise.resolve(run()).catch(err => this.notificationService.error(err instanceof Error ? err : String(err)));
		}));
		return button;
	}

	private addModalAction(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'danger', run: () => Promise<void> | void): HTMLButtonElement {
		const button = this.createButton(parent, label, variant);
		this.modalDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			void Promise.resolve(run()).catch(err => this.notificationService.error(err instanceof Error ? err : String(err)));
		}));
		return button;
	}

	private appendOption(select: HTMLSelectElement, value: string, label: string): void {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		select.appendChild(option);
	}

	private setStatus(element: HTMLElement, message: string, kind: StatusKind): void {
		element.textContent = message;
		element.classList.toggle('dc-test-success', kind === 'success');
		element.classList.toggle('dc-test-error', kind === 'error');
	}

	private showDialog(title: string, render: (body: HTMLElement, footer: HTMLElement, close: () => void) => void): void {
		this.modalDisposables.clear();
		const targetWindow = DOM.getWindow(this.container);
		const targetDocument = targetWindow.document;
		const overlay = targetDocument.createElement('div');
		overlay.className = 'dc-modal-backdrop';
		const dialog = DOM.append(overlay, $('.dc-modal'));
		const header = DOM.append(dialog, $('.dc-modal-header'));
		DOM.append(header, $('.dc-modal-title')).textContent = title;
		const closeButton = DOM.append(header, $<HTMLButtonElement>('button.dc-icon-button'));
		closeButton.type = 'button';
		closeButton.textContent = 'x';
		closeButton.title = localize('directorSettings.close', "Close");
		const body = DOM.append(dialog, $('.dc-modal-body'));
		const footer = DOM.append(dialog, $('.dc-modal-footer'));

		const close = () => this.modalDisposables.clear();
		this.modalDisposables.add({ dispose: () => overlay.remove() });
		this.modalDisposables.add(DOM.addDisposableListener(closeButton, DOM.EventType.CLICK, close));
		this.modalDisposables.add(DOM.addDisposableListener(targetDocument, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				close();
			}
		}));

		targetDocument.body.appendChild(overlay);
		render(body, footer, close);
	}
}

function getProviderModelId(providerInstanceId: string, modelId: string): string {
	const prefix = `${sanitizeDirectorProviderId(providerInstanceId)}:`;
	return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function formatHeaders(headers: Record<string, string> | undefined): string {
	return headers ? Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n') : '';
}

function parseHeadersValue(value: string): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (const line of value.split(/\r?\n/g)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const separator = trimmed.indexOf(':');
		if (separator <= 0) {
			continue;
		}
		const name = trimmed.slice(0, separator).trim();
		const headerValue = trimmed.slice(separator + 1).trim();
		if (name && headerValue) {
			headers[name] = headerValue;
		}
	}
	return Object.keys(headers).length ? headers : undefined;
}
