/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentConfig, ExternalAcpAgentConnectionStatus, ExternalAcpAgentCwdPolicy, createExternalAcpAgentConfig, isExternalAcpLoginHelpUrlAllowed, sanitizeExternalAcpAgentId, toExternalAcpAgentSnapshot, validateExternalAcpAgentConfig } from '../../../../../platform/agentHost/common/acpAgentConfig.js';
import { AcpRegistryAgent, getAcpRegistryInstallCommandCopyText, getAcpRegistryLoginCommandCopyText } from '../../../../../platform/agentHost/common/acpRegistry.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { getBundledAcpRegistryCatalog } from '../../common/acpRegistryCatalog.js';
import { ExternalAcpAgentsRegistryBrowseEnabledSetting, IExternalAcpAgentConnectionTestService, IExternalAcpAgentRegistryService, IExternalAcpAgentSnapshotService } from '../../common/externalAcpAgentProviderService.js';

const $ = DOM.$;

interface ExternalAcpAgentsShell {
	readonly root: HTMLElement;
	readonly status: HTMLElement;
	readonly browse: HTMLElement;
	readonly agents: HTMLElement;
	readonly diagnostics: HTMLElement;
}

type AgentDialogMode =
	| { readonly kind: 'new' }
	| { readonly kind: 'edit'; readonly agent: ExternalAcpAgentConfig; readonly reviewRegistryDraft?: boolean };

type StatusKind = 'info' | 'success' | 'error';

const capabilityOptions: readonly { readonly capability: ExternalAcpAgentCapability; readonly label: string }[] = [
	{ capability: ExternalAcpAgentCapability.Text, label: localize('externalAcpAgents.capability.text', "Text") },
	{ capability: ExternalAcpAgentCapability.Reasoning, label: localize('externalAcpAgents.capability.reasoning', "Reasoning") },
	{ capability: ExternalAcpAgentCapability.Auth, label: localize('externalAcpAgents.capability.auth', "Auth") },
	{ capability: ExternalAcpAgentCapability.Tools, label: localize('externalAcpAgents.capability.tools', "Tools") },
	{ capability: ExternalAcpAgentCapability.Files, label: localize('externalAcpAgents.capability.files', "Files") },
	{ capability: ExternalAcpAgentCapability.Terminal, label: localize('externalAcpAgents.capability.terminal', "Terminal") },
];

export class ExternalAcpAgentsWidget extends Disposable {

	private container: HTMLElement | undefined;
	private shell: ExternalAcpAgentsShell | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly browseRenderDisposables = this._register(new DisposableStore());
	private readonly agentsRenderDisposables = this._register(new DisposableStore());
	private readonly modalDisposables = this._register(new DisposableStore());
	private renderGeneration = 0;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IExternalAcpAgentRegistryService private readonly registryService: IExternalAcpAgentRegistryService,
		@IExternalAcpAgentSnapshotService private readonly snapshotService: IExternalAcpAgentSnapshotService,
		@IExternalAcpAgentConnectionTestService private readonly connectionTestService: IExternalAcpAgentConnectionTestService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.registryService.onDidChangeAgents(() => { void this.refresh({ preserveScroll: true }); }));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ExternalAcpAgentsRegistryBrowseEnabledSetting)) {
				void this.refresh({ preserveScroll: true });
			}
		}));
	}

	render(container: HTMLElement): void {
		if (this.container !== container) {
			this.renderDisposables.clear();
			this.browseRenderDisposables.clear();
			this.agentsRenderDisposables.clear();
			this.modalDisposables.clear();
			this.shell = undefined;
			DOM.clearNode(container);
		}
		this.container = container;
		void this.refresh();
	}

	async refresh(options: { readonly preserveScroll?: boolean } = {}): Promise<void> {
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
		this.renderStatus(shell.status, state.agents);
		this.renderDiagnostics(shell.diagnostics, state.agents);
		this.renderBrowse(shell.browse, state.agents, generation);
		this.renderAgents(shell.agents, state.agents, generation);
		if (scrollTop !== undefined && generation === this.renderGeneration && this.container) {
			this.container.scrollTop = scrollTop;
		}
	}

	private ensureShell(container: HTMLElement): ExternalAcpAgentsShell {
		if (this.shell !== undefined && container.contains(this.shell.root)) {
			return this.shell;
		}

		this.renderDisposables.clear();
		this.browseRenderDisposables.clear();
		this.agentsRenderDisposables.clear();
		DOM.clearNode(container);

		const root = DOM.append(container, $('.external-acp-agents-widget'));
		const header = DOM.append(root, $('.eaa-page-heading'));
		DOM.append(header, $('h1.eaa-title')).textContent = localize('externalAcpAgents.title', "External ACP Agents");
		DOM.append(header, $('.eaa-subtitle')).textContent = localize('externalAcpAgents.subtitle', "Manage manually configured ACP agents that use their own subscriptions, login, billing, and model routing.");

		const toolbar = DOM.append(header, $('.eaa-toolbar'));
		this.addAction(toolbar, localize('externalAcpAgents.addAgent', "Add Agent"), 'primary', () => this.showAgentDialog({ kind: 'new' }), this.renderDisposables);
		this.addAction(toolbar, localize('externalAcpAgents.refreshSnapshot', "Refresh Snapshot"), 'secondary', () => this.refreshSnapshot(), this.renderDisposables);
		this.addAction(toolbar, localize('externalAcpAgents.showSnapshotLocation', "Show Snapshot Path"), 'secondary', () => this.showSnapshotLocation(), this.renderDisposables);

		const status = DOM.append(root, $('.eaa-status-host'));
		const browse = DOM.append(root, $('.eaa-browse-host'));
		const agents = DOM.append(root, $('.eaa-agents-host'));
		const diagnostics = DOM.append(root, $('.eaa-diagnostics-host'));
		this.shell = { root, status, browse, agents, diagnostics };
		return this.shell;
	}

	private renderStatus(parent: HTMLElement, agents: readonly ExternalAcpAgentConfig[]): void {
		DOM.clearNode(parent);
		const snapshot = toExternalAcpAgentSnapshot(agents);
		const statusBar = DOM.append(parent, $('.eaa-status-bar'));
		this.appendStatusBarItem(statusBar, localize('externalAcpAgents.statusConfigured', "Configured:"), String(agents.length));
		this.appendStatusBarItem(statusBar, localize('externalAcpAgents.statusSnapshot', "In Snapshot:"), String(snapshot.agents.length));
		const pending = agents.some(agent => agent.applyState === 'pendingRestart');
		this.appendStatusBarItem(statusBar, localize('externalAcpAgents.statusApply', "Apply:"), pending ? localize('externalAcpAgents.pendingRestart', "Restart/Reconnect Required") : localize('externalAcpAgents.clean', "Clean"));
	}

	private renderDiagnostics(parent: HTMLElement, agents: readonly ExternalAcpAgentConfig[]): void {
		DOM.clearNode(parent);
		const panel = this.createPanel(parent, localize('externalAcpAgents.applyStateTitle', "Apply State"));
		const list = DOM.append(panel, $('.eaa-note-list'));
		DOM.append(list, $('.eaa-note')).textContent = localize('externalAcpAgents.restartNote', "Manual config changes write the snapshot immediately, but AgentHost provider registration is not dynamically reconciled in Phase 1. Restart or reconnect AgentHost before expecting the live agent list to reflect changes.");
		DOM.append(list, $('.eaa-note')).textContent = localize('externalAcpAgents.noProbeNote', "This page never launches external ACP commands for status. Missing login is shown only as configured help text until a later explicit runtime action reports it.");
		DOM.append(list, $('.eaa-note')).textContent = localize('externalAcpAgents.registryBrowseNote', "Known ACP Agents are a local browse catalog. Install and login actions copy text or open help only; managed install and background detection are not implemented.");
		if (agents.some(agent => !validateExternalAcpAgentConfig(agent).valid)) {
			DOM.append(list, $('.eaa-note.eaa-note-error')).textContent = localize('externalAcpAgents.invalidConfigNote', "One or more manual configs are invalid and will not be emitted to the AgentHost snapshot.");
		}
	}

	private renderBrowse(parent: HTMLElement, agents: readonly ExternalAcpAgentConfig[], generation: number): void {
		this.browseRenderDisposables.clear();
		DOM.clearNode(parent);
		if (this.configurationService.getValue<boolean>(ExternalAcpAgentsRegistryBrowseEnabledSetting) === false) {
			return;
		}

		const section = this.createPanel(parent, localize('externalAcpAgents.browseKnownAgents', "Browse Known ACP Agents"));
		const list = DOM.append(section, $('.eaa-registry-grid'));
		for (const entry of getBundledAcpRegistryCatalog()) {
			if (generation !== this.renderGeneration) {
				return;
			}
			this.renderRegistryCard(list, entry, agents, this.browseRenderDisposables);
		}
	}

	private renderRegistryCard(parent: HTMLElement, entry: AcpRegistryAgent, agents: readonly ExternalAcpAgentConfig[], disposables: DisposableStore): void {
		const existingDraft = agents.find(agent => agent.registryDraft && agent.registryId === entry.id && agent.registryVersion === entry.version) ?? agents.find(agent => agent.registryDraft && agent.id === entry.id);
		const existingManual = agents.find(agent => !agent.registryDraft && (agent.id === entry.id || agent.registryId === entry.id));
		const card = DOM.append(parent, $('.eaa-registry-card'));
		const main = DOM.append(card, $('.eaa-agent-main'));
		const identity = DOM.append(main, $('.eaa-agent-identity'));
		DOM.append(identity, $('.eaa-agent-icon')).textContent = entry.name.slice(0, 1).toUpperCase();
		const text = DOM.append(identity, $('.eaa-agent-text'));
		DOM.append(text, $('.eaa-agent-name')).textContent = entry.name;
		DOM.append(text, $('.eaa-agent-desc')).textContent = entry.description;

		const tags = DOM.append(main, $('.eaa-tag-row'));
		this.createTag(tags, localize('externalAcpAgents.registryVersion', "Version {0}", entry.version), 'neutral');
		this.createTag(tags, this.registryDistributionLabel(entry), 'accent');
		this.createTag(tags, entry.source === 'bundled' ? localize('externalAcpAgents.registryBundled', "Bundled Catalog") : localize('externalAcpAgents.registryRemote', "Registry"), 'muted');
		if (existingDraft) {
			this.createTag(tags, localize('externalAcpAgents.registryDraft', "Disabled Draft"), 'warning');
		}
		if (existingManual) {
			this.createTag(tags, localize('externalAcpAgents.alreadyConfigured', "Already Configured"), 'success');
		}

		const details = DOM.append(main, $('.eaa-agent-details'));
		this.appendDetail(details, localize('externalAcpAgents.detailId', "ID"), entry.id);
		if (entry.authors?.length) {
			this.appendDetail(details, localize('externalAcpAgents.registryAuthors', "Authors"), entry.authors.join(', '));
		}
		if (entry.loginHint) {
			this.appendDetail(details, localize('externalAcpAgents.detailLogin', "Login Hint"), entry.loginHint);
		}
		if (entry.helpUrl) {
			this.appendDetail(details, localize('externalAcpAgents.registryHelp', "Help"), entry.helpUrl);
		}

		const actions = DOM.append(card, $('.eaa-agent-actions'));
		const installCommand = getAcpRegistryInstallCommandCopyText(entry);
		if (installCommand) {
			this.addAction(actions, localize('externalAcpAgents.copyInstallCommand', "Copy Install Command"), 'secondary', () => this.copyRegistryInstallCommand(entry, installCommand), disposables);
		}
		this.addAction(actions, existingManual ? localize('externalAcpAgents.alreadyConfiguredAction', "Already Configured") : localize('externalAcpAgents.addDisabledDraft', "Add Disabled Draft"), 'secondary', () => this.addRegistryDraft(entry), disposables, existingManual !== undefined);
		this.addAction(actions, localize('externalAcpAgents.reviewManualConfig', "Review Manual Config"), 'secondary', () => this.reviewRegistryDraft(entry, existingDraft), disposables, existingManual !== undefined);
		const loginCommand = getAcpRegistryLoginCommandCopyText(entry);
		if (loginCommand) {
			this.addAction(actions, localize('externalAcpAgents.copyLoginCommand', "Copy Login Command"), 'secondary', () => this.copyRegistryLoginCommand(entry, loginCommand), disposables);
		}
		if (entry.loginHelpUrl) {
			this.addAction(actions, localize('externalAcpAgents.openLoginHelp', "Open Login Help"), 'secondary', () => this.openRegistryLoginHelp(entry), disposables);
		}
	}

	private renderAgents(parent: HTMLElement, agents: readonly ExternalAcpAgentConfig[], generation: number): void {
		this.agentsRenderDisposables.clear();
		DOM.clearNode(parent);

		const section = this.createPanel(parent, localize('externalAcpAgents.manualAgents', "Manual Agents"));
		const list = DOM.append(section, $('.eaa-settings-list'));
		if (!agents.length) {
			DOM.append(list, $('.eaa-empty-state')).textContent = localize('externalAcpAgents.empty', "No external ACP agents configured yet.");
			return;
		}

		for (const agent of agents) {
			if (generation !== this.renderGeneration) {
				return;
			}
			this.renderAgentRow(list, agent, this.agentsRenderDisposables);
		}
	}

	private renderAgentRow(parent: HTMLElement, agent: ExternalAcpAgentConfig, disposables: DisposableStore): void {
		const validation = validateExternalAcpAgentConfig(agent);
		const row = DOM.append(parent, $('.eaa-agent-row'));
		row.classList.toggle('eaa-agent-disabled', !agent.enabled || !agent.trusted);

		const main = DOM.append(row, $('.eaa-agent-main'));
		const identity = DOM.append(main, $('.eaa-agent-identity'));
		DOM.append(identity, $('.eaa-agent-icon')).textContent = agent.displayName.slice(0, 1).toUpperCase();
		const text = DOM.append(identity, $('.eaa-agent-text'));
		DOM.append(text, $('.eaa-agent-name')).textContent = agent.displayName;
		DOM.append(text, $('.eaa-agent-desc')).textContent = agent.vendorLabel || localize('externalAcpAgents.externalOwnership', "Uses the external agent's own account and subscription.");

		const tags = DOM.append(main, $('.eaa-tag-row'));
		this.createTag(tags, agent.enabled ? localize('externalAcpAgents.enabled', "Enabled") : localize('externalAcpAgents.disabled', "Disabled"), agent.enabled ? 'success' : 'muted');
		this.createTag(tags, agent.trusted ? localize('externalAcpAgents.trusted', "Trusted") : localize('externalAcpAgents.untrusted', "Trust Required"), agent.trusted ? 'success' : 'danger');
		if (agent.registryDraft) {
			this.createTag(tags, localize('externalAcpAgents.registryDraft', "Disabled Draft"), 'warning');
		}
		this.createTag(tags, this.cwdPolicyLabel(agent.cwdPolicy), 'neutral');
		this.createTag(tags, agent.applyState === 'pendingRestart' ? localize('externalAcpAgents.pendingRestartTag', "Pending Restart") : localize('externalAcpAgents.applyStateCleanTag', "Snapshot Written"), agent.applyState === 'pendingRestart' ? 'accent' : 'neutral');
		this.createTag(tags, this.connectionStatusLabel(agent.connectionStatus), this.connectionStatusTone(agent.connectionStatus));
		for (const capability of agent.capabilities) {
			this.createTag(tags, this.capabilityLabel(capability), this.isSideEffectCapability(capability) ? 'warning' : 'neutral');
		}
		if (!validation.valid) {
			this.createTag(tags, validation.message ?? localize('externalAcpAgents.invalid', "Invalid"), 'danger');
		}

		const details = DOM.append(main, $('.eaa-agent-details'));
		this.appendDetail(details, localize('externalAcpAgents.detailId', "ID"), agent.id);
		this.appendDetail(details, localize('externalAcpAgents.detailCommand', "Command"), [agent.command, ...agent.args].join(' '));
		this.appendDetail(details, localize('externalAcpAgents.detailCwd', "CWD"), agent.cwdPolicy === ExternalAcpAgentCwdPolicy.Fixed ? agent.cwd ?? '-' : this.cwdPolicyLabel(agent.cwdPolicy));
		if (agent.envVariableNames?.length) {
			this.appendDetail(details, localize('externalAcpAgents.detailEnv', "Env Names"), agent.envVariableNames.join(', '));
		}
		if (agent.secretRefs?.length) {
			this.appendDetail(details, localize('externalAcpAgents.detailSecrets', "Secret Refs"), agent.secretRefs.join(', '));
		}
		if (agent.loginHint) {
			this.appendDetail(details, localize('externalAcpAgents.detailLogin', "Login Hint"), agent.loginHint);
		}
		if (agent.loginCommand) {
			this.appendDetail(details, localize('externalAcpAgents.detailLoginCommand', "Login Command"), agent.loginCommand);
		}
		if (agent.loginHelpUrl) {
			this.appendDetail(details, localize('externalAcpAgents.detailLoginHelp', "Login Help"), agent.loginHelpUrl);
		}
		if (agent.registryId) {
			this.appendDetail(details, localize('externalAcpAgents.detailRegistry', "Registry"), agent.registryVersion ? `${agent.registryId}@${agent.registryVersion}` : agent.registryId);
		}
		if (agent.connectionStatus) {
			this.appendDetail(details, localize('externalAcpAgents.detailConnectionStatus', "Connection Status"), this.connectionStatusDetail(agent.connectionStatus));
		}

		const actions = DOM.append(row, $('.eaa-agent-actions'));
		this.addAction(actions, this.connectionActionLabel(agent.connectionStatus), 'secondary', () => this.testConnection(agent), disposables);
		if (agent.loginCommand) {
			this.addAction(actions, localize('externalAcpAgents.copyLoginCommand', "Copy Login Command"), 'secondary', () => this.copyLoginCommand(agent), disposables);
		}
		if (agent.loginHelpUrl) {
			this.addAction(actions, localize('externalAcpAgents.openLoginHelp', "Open Login Help"), 'secondary', () => this.openLoginHelp(agent), disposables);
		}
		if (agent.connectionStatus) {
			this.addAction(actions, localize('externalAcpAgents.clearLoginStatus', "Clear Login Status"), 'secondary', () => this.clearLoginStatus(agent), disposables);
		}
		this.addAction(actions, agent.registryDraft ? localize('externalAcpAgents.reviewManualConfig', "Review Manual Config") : localize('externalAcpAgents.edit', "Edit"), 'secondary', () => this.showAgentDialog({ kind: 'edit', agent, reviewRegistryDraft: agent.registryDraft === true }), disposables);
		this.addAction(actions, agent.enabled ? localize('externalAcpAgents.disable', "Disable") : localize('externalAcpAgents.enable', "Enable"), 'secondary', () => this.toggleEnabled(agent), disposables);
		this.addAction(actions, agent.trusted ? localize('externalAcpAgents.untrust', "Untrust") : localize('externalAcpAgents.trust', "Trust"), 'secondary', () => this.toggleTrusted(agent), disposables);
		this.addAction(actions, localize('externalAcpAgents.remove', "Remove"), 'danger', () => this.removeAgent(agent), disposables);
	}

	private async toggleEnabled(agent: ExternalAcpAgentConfig): Promise<void> {
		await this.registryService.setEnabled(agent.id, !agent.enabled);
		await this.snapshotService.writeSnapshot();
	}

	private async toggleTrusted(agent: ExternalAcpAgentConfig): Promise<void> {
		await this.registryService.setTrusted(agent.id, !agent.trusted);
		await this.snapshotService.writeSnapshot();
	}

	private async removeAgent(agent: ExternalAcpAgentConfig): Promise<void> {
		await this.registryService.removeAgent(agent.id);
		await this.snapshotService.writeSnapshot();
		this.notificationService.info(localize('externalAcpAgents.removed', "External ACP agent '{0}' removed.", agent.displayName));
	}

	private async addRegistryDraft(entry: AcpRegistryAgent): Promise<void> {
		const draft = await this.registryService.createRegistryDraft(entry);
		await this.snapshotService.writeSnapshot();
		this.notificationService.info(localize('externalAcpAgents.registryDraftAdded', "Disabled draft '{0}' added for manual review.", draft.displayName));
		await this.refresh({ preserveScroll: true });
	}

	private async reviewRegistryDraft(entry: AcpRegistryAgent, existing: ExternalAcpAgentConfig | undefined): Promise<void> {
		const draft = existing ?? await this.registryService.createRegistryDraft(entry);
		if (!existing) {
			await this.snapshotService.writeSnapshot();
		}
		this.showAgentDialog({ kind: 'edit', agent: draft, reviewRegistryDraft: true });
	}

	private async copyRegistryInstallCommand(entry: AcpRegistryAgent, installCommand: string): Promise<void> {
		await this.clipboardService.writeText(installCommand);
		this.notificationService.info(localize('externalAcpAgents.installCommandCopied', "Install command for '{0}' copied. Run it outside VS Code if you choose to install this external agent.", entry.name));
	}

	private async copyRegistryLoginCommand(entry: AcpRegistryAgent, loginCommand: string): Promise<void> {
		await this.clipboardService.writeText(loginCommand);
		this.notificationService.info(localize('externalAcpAgents.registryLoginCommandCopied', "Login command for '{0}' copied. Run it outside VS Code after installing the vendor agent.", entry.name));
	}

	private async openRegistryLoginHelp(entry: AcpRegistryAgent): Promise<void> {
		if (!entry.loginHelpUrl || !isExternalAcpLoginHelpUrlAllowed(entry.loginHelpUrl)) {
			this.notificationService.error(localize('externalAcpAgents.loginHelpUrlBlocked', "Login help URL was blocked. Only http and https login help URLs are allowed."));
			return;
		}
		await this.openerService.open(URI.parse(entry.loginHelpUrl), { openExternal: true, fromUserGesture: true });
	}

	private async refreshSnapshot(): Promise<void> {
		await this.snapshotService.writeSnapshot();
		this.notificationService.info(localize('externalAcpAgents.snapshotRefreshed', "External ACP Agents snapshot refreshed."));
		await this.refresh({ preserveScroll: true });
	}

	private async testConnection(agent: ExternalAcpAgentConfig): Promise<void> {
		const status = await this.connectionTestService.testConnection(agent.id);
		this.notificationService.info(status.message ?? this.connectionStatusLabel(status));
		await this.refresh({ preserveScroll: true });
	}

	private async copyLoginCommand(agent: ExternalAcpAgentConfig): Promise<void> {
		if (!agent.loginCommand) {
			return;
		}
		await this.clipboardService.writeText(agent.loginCommand);
		await this.registryService.updateConnectionStatus(agent.id, {
			kind: 'loginHelpShown',
			source: 'userAction',
			updatedAt: Date.now(),
			message: localize('externalAcpAgents.loginCommandCopied', "Vendor login command copied. Run it outside VS Code, then retry the ACP connection."),
			authMethods: agent.connectionStatus?.authMethods,
		});
		this.notificationService.info(localize('externalAcpAgents.loginCommandCopiedNotification', "Login command copied."));
		await this.refresh({ preserveScroll: true });
	}

	private async openLoginHelp(agent: ExternalAcpAgentConfig): Promise<void> {
		if (!agent.loginHelpUrl) {
			return;
		}
		if (!isExternalAcpLoginHelpUrlAllowed(agent.loginHelpUrl)) {
			this.notificationService.error(localize('externalAcpAgents.loginHelpUrlBlocked', "Login help URL was blocked. Only http and https login help URLs are allowed."));
			return;
		}
		await this.openerService.open(URI.parse(agent.loginHelpUrl), { openExternal: true, fromUserGesture: true });
		await this.registryService.updateConnectionStatus(agent.id, {
			kind: 'loginHelpShown',
			source: 'userAction',
			updatedAt: Date.now(),
			message: localize('externalAcpAgents.loginHelpOpened', "Vendor login help opened. Complete the vendor-owned login flow, then retry the ACP connection."),
			authMethods: agent.connectionStatus?.authMethods,
		});
		await this.refresh({ preserveScroll: true });
	}

	private async clearLoginStatus(agent: ExternalAcpAgentConfig): Promise<void> {
		await this.connectionTestService.clearConnectionStatus(agent.id);
		this.notificationService.info(localize('externalAcpAgents.loginStatusCleared', "External ACP agent login status cleared."));
		await this.refresh({ preserveScroll: true });
	}

	private async showSnapshotLocation(): Promise<void> {
		this.notificationService.info(await this.snapshotService.getSnapshotResource());
	}

	private showAgentDialog(mode: AgentDialogMode): void {
		const existing = mode.kind === 'edit' ? mode.agent : undefined;
		const title = mode.kind === 'edit' && mode.reviewRegistryDraft
			? localize('externalAcpAgents.reviewAgent', "Review External ACP Agent")
			: mode.kind === 'edit' ? localize('externalAcpAgents.editAgent', "Edit External ACP Agent") : localize('externalAcpAgents.addManualAgent', "Add External ACP Agent");
		this.showDialog(title, (body, footer, close) => {
			const form = DOM.append(body, $('.eaa-dialog-form'));
			const idInput = this.createInputRow(form, localize('externalAcpAgents.formId', "ID"), 'cursor-agent');
			const nameInput = this.createInputRow(form, localize('externalAcpAgents.formName', "Display Name"), localize('externalAcpAgents.formNamePlaceholder', "Cursor Agent"));
			const commandInput = this.createInputRow(form, localize('externalAcpAgents.formCommand', "Command"), 'cursor-agent');
			const argsInput = this.createTextAreaRow(form, localize('externalAcpAgents.formArgs', "Args"), localize('externalAcpAgents.formArgsPlaceholder', "One argument per line"), 3);
			const cwdPolicySelect = this.createSelectRow(form, localize('externalAcpAgents.formCwdPolicy', "CWD Policy"), [
				{ value: ExternalAcpAgentCwdPolicy.Workspace, label: this.cwdPolicyLabel(ExternalAcpAgentCwdPolicy.Workspace) },
				{ value: ExternalAcpAgentCwdPolicy.Fixed, label: this.cwdPolicyLabel(ExternalAcpAgentCwdPolicy.Fixed) },
				{ value: ExternalAcpAgentCwdPolicy.None, label: this.cwdPolicyLabel(ExternalAcpAgentCwdPolicy.None) },
			]);
			const cwdInput = this.createInputRow(form, localize('externalAcpAgents.formCwd', "Fixed CWD"), 'C:\\path\\to\\workspace');
			const vendorInput = this.createInputRow(form, localize('externalAcpAgents.formVendorLabel', "Subscription Label"), localize('externalAcpAgents.formVendorPlaceholder', "uses your Cursor subscription"));
			const loginHintInput = this.createTextAreaRow(form, localize('externalAcpAgents.formLoginHint', "Login Hint"), localize('externalAcpAgents.formLoginPlaceholder', "Run the vendor CLI login command outside VS Code."), 2);
			const loginCommandInput = this.createInputRow(form, localize('externalAcpAgents.formLoginCommand', "Login Command"), 'cursor-agent login');
			const loginHelpUrlInput = this.createInputRow(form, localize('externalAcpAgents.formLoginHelpUrl', "Login Help URL"), 'https://example.com/login-help');
			const envInput = this.createTextAreaRow(form, localize('externalAcpAgents.formEnvNames', "Env Variable Names"), localize('externalAcpAgents.formEnvPlaceholder', "HTTPS_PROXY\nNO_PROXY"), 2);
			const secretRefsInput = this.createTextAreaRow(form, localize('externalAcpAgents.formSecretRefs', "Secret References"), localize('externalAcpAgents.formSecretPlaceholder', "secret://vendor/account"), 2);
			const enabledInput = this.createCheckboxRow(form, localize('externalAcpAgents.formEnabled', "Enabled"));
			const trustedInput = this.createCheckboxRow(form, localize('externalAcpAgents.formTrusted', "Trusted"));
			const capabilityInputs = this.createCapabilities(form, existing?.capabilities ?? [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning]);
			const status = DOM.append(form, $('.eaa-dialog-status'));

			idInput.value = existing?.id ?? '';
			nameInput.value = existing?.displayName ?? '';
			commandInput.value = existing?.command ?? '';
			argsInput.value = existing?.args.join('\n') ?? '';
			cwdPolicySelect.value = existing?.cwdPolicy ?? ExternalAcpAgentCwdPolicy.Workspace;
			cwdInput.value = existing?.cwd ?? '';
			vendorInput.value = existing?.vendorLabel ?? '';
			loginHintInput.value = existing?.loginHint ?? '';
			loginCommandInput.value = existing?.loginCommand ?? '';
			loginHelpUrlInput.value = existing?.loginHelpUrl ?? '';
			envInput.value = existing?.envVariableNames?.join('\n') ?? '';
			secretRefsInput.value = existing?.secretRefs?.join('\n') ?? '';
			enabledInput.checked = existing?.enabled ?? false;
			trustedInput.checked = existing?.trusted ?? false;

			this.addModalAction(footer, localize('externalAcpAgents.cancel', "Cancel"), 'secondary', close);
			this.addModalAction(footer, mode.kind === 'edit' ? localize('externalAcpAgents.save', "Save") : localize('externalAcpAgents.add', "Add"), 'primary', async () => {
				const id = sanitizeExternalAcpAgentId(idInput.value || nameInput.value);
				const duplicate = (await this.registryService.getAgent(id)) !== undefined;
				if (duplicate && (mode.kind === 'new' || existing?.id !== id)) {
					this.setStatus(status, localize('externalAcpAgents.duplicateId', "An external ACP agent with this id already exists."), 'error');
					return;
				}
				const agent = createExternalAcpAgentConfig({
					id,
					displayName: nameInput.value,
					command: commandInput.value,
					args: this.parseLines(argsInput.value),
					cwdPolicy: cwdPolicySelect.value as ExternalAcpAgentCwdPolicy,
					cwd: cwdInput.value,
					vendorLabel: vendorInput.value,
					loginHint: loginHintInput.value,
					loginCommand: loginCommandInput.value,
					loginHelpUrl: loginHelpUrlInput.value,
					enabled: mode.kind === 'edit' && mode.reviewRegistryDraft ? false : enabledInput.checked,
					trusted: mode.kind === 'edit' && mode.reviewRegistryDraft ? false : trustedInput.checked,
					capabilities: capabilityInputs.filter(input => input.input.checked).map(input => input.capability),
					envVariableNames: this.parseLines(envInput.value),
					secretRefs: this.parseLines(secretRefsInput.value),
					registryId: existing?.registryId,
					registryVersion: existing?.registryVersion,
				});
				const validation = validateExternalAcpAgentConfig(agent);
				if (!validation.valid) {
					this.setStatus(status, validation.message ?? localize('externalAcpAgents.invalidConfig', "Invalid external ACP agent config."), 'error');
					return;
				}
				if (mode.kind === 'edit' && mode.reviewRegistryDraft) {
					await this.registryService.saveRegistryDraft({
						...agent,
						registryDraft: true,
					});
					await this.registryService.markRegistryDraftReviewed(agent.id);
				} else {
					await this.registryService.saveAgent(agent);
				}
				await this.snapshotService.writeSnapshot();
				close();
				await this.refresh({ preserveScroll: true });
			});
		});
	}

	private createCapabilities(parent: HTMLElement, selected: readonly ExternalAcpAgentCapability[]): readonly { readonly capability: ExternalAcpAgentCapability; readonly input: HTMLInputElement }[] {
		const group = DOM.append(parent, $('.eaa-form-row'));
		DOM.append(group, $<HTMLLabelElement>('label.eaa-form-label')).textContent = localize('externalAcpAgents.formCapabilities', "Capability Flags");
		const list = DOM.append(group, $('.eaa-checkbox-grid'));
		const selectedSet = new Set(selected);
		return capabilityOptions.map(option => {
			const label = DOM.append(list, $<HTMLLabelElement>('label.eaa-checkbox-label'));
			const input = DOM.append(label, $<HTMLInputElement>('input.eaa-checkbox'));
			input.type = 'checkbox';
			input.checked = selectedSet.has(option.capability);
			DOM.append(label, $('span')).textContent = option.label;
			return { capability: option.capability, input };
		});
	}

	private createPanel(parent: HTMLElement, title: string): HTMLElement {
		const section = DOM.append(parent, $('.eaa-settings-panel'));
		const header = DOM.append(section, $('.eaa-settings-panel-header'));
		DOM.append(header, $('.eaa-settings-panel-title')).textContent = title;
		return section;
	}

	private createTag(parent: HTMLElement, label: string, tone: 'neutral' | 'accent' | 'success' | 'danger' | 'muted' | 'warning'): HTMLElement {
		const tag = DOM.append(parent, $(`.eaa-tag.eaa-tag-${tone}`));
		tag.textContent = label;
		return tag;
	}

	private appendStatusBarItem(parent: HTMLElement, label: string, value: string): void {
		const item = DOM.append(parent, $('.eaa-status-bar-item'));
		DOM.append(item, $('.eaa-status-bar-label')).textContent = label;
		DOM.append(item, $('.eaa-status-bar-value')).textContent = value;
	}

	private appendDetail(parent: HTMLElement, label: string, value: string): void {
		const item = DOM.append(parent, $('.eaa-detail'));
		DOM.append(item, $('.eaa-detail-label')).textContent = label;
		DOM.append(item, $('.eaa-detail-value')).textContent = value;
	}

	private createInputRow(parent: HTMLElement, labelText: string, placeholder: string): HTMLInputElement {
		const row = DOM.append(parent, $('.eaa-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.eaa-form-label')).textContent = labelText;
		const input = DOM.append(row, $<HTMLInputElement>('input.eaa-form-input'));
		input.type = 'text';
		input.placeholder = placeholder;
		input.autocomplete = 'off';
		return input;
	}

	private createTextAreaRow(parent: HTMLElement, labelText: string, placeholder: string, rows: number): HTMLTextAreaElement {
		const row = DOM.append(parent, $('.eaa-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.eaa-form-label')).textContent = labelText;
		const textArea = DOM.append(row, $<HTMLTextAreaElement>('textarea.eaa-form-input'));
		textArea.rows = rows;
		textArea.placeholder = placeholder;
		return textArea;
	}

	private createSelectRow(parent: HTMLElement, labelText: string, options: readonly { readonly value: string; readonly label: string }[]): HTMLSelectElement {
		const row = DOM.append(parent, $('.eaa-form-row'));
		DOM.append(row, $<HTMLLabelElement>('label.eaa-form-label')).textContent = labelText;
		const select = DOM.append(row, $<HTMLSelectElement>('select.eaa-form-input'));
		for (const option of options) {
			const element = document.createElement('option');
			element.value = option.value;
			element.textContent = option.label;
			select.appendChild(element);
		}
		return select;
	}

	private createCheckboxRow(parent: HTMLElement, labelText: string): HTMLInputElement {
		const label = DOM.append(parent, $<HTMLLabelElement>('label.eaa-checkbox-label'));
		const input = DOM.append(label, $<HTMLInputElement>('input.eaa-checkbox'));
		input.type = 'checkbox';
		DOM.append(label, $('span')).textContent = labelText;
		return input;
	}

	private createButton(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'danger'): HTMLButtonElement {
		const button = DOM.append(parent, $<HTMLButtonElement>(`button.eaa-btn.eaa-btn-${variant}`));
		button.type = 'button';
		button.textContent = label;
		return button;
	}

	private addAction(parent: HTMLElement, label: string, variant: 'primary' | 'secondary' | 'danger', run: () => Promise<void> | void, disposables: DisposableStore, disabled = false): HTMLButtonElement {
		const button = this.createButton(parent, label, variant);
		button.disabled = disabled;
		if (disabled) {
			return button;
		}
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

	private setStatus(element: HTMLElement, message: string, kind: StatusKind): void {
		element.textContent = message;
		element.classList.toggle('eaa-test-success', kind === 'success');
		element.classList.toggle('eaa-test-error', kind === 'error');
	}

	private showDialog(title: string, render: (body: HTMLElement, footer: HTMLElement, close: () => void) => void): void {
		this.modalDisposables.clear();
		const targetWindow = DOM.getWindow(this.container);
		const targetDocument = targetWindow.document;
		const overlay = targetDocument.createElement('div');
		overlay.className = 'eaa-modal-backdrop';
		const dialog = DOM.append(overlay, $('.eaa-modal'));
		const header = DOM.append(dialog, $('.eaa-modal-header'));
		DOM.append(header, $('.eaa-modal-title')).textContent = title;
		const closeButton = DOM.append(header, $<HTMLButtonElement>('button.eaa-icon-button'));
		closeButton.type = 'button';
		closeButton.textContent = 'x';
		closeButton.title = localize('externalAcpAgents.close', "Close");
		const body = DOM.append(dialog, $('.eaa-modal-body'));
		const footer = DOM.append(dialog, $('.eaa-modal-footer'));

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

	private parseLines(value: string): readonly string[] {
		return Array.from(new Set(value.split(/\r?\n/g).map(line => line.trim()).filter(line => line.length > 0)));
	}

	private cwdPolicyLabel(policy: ExternalAcpAgentCwdPolicy): string {
		switch (policy) {
			case ExternalAcpAgentCwdPolicy.None:
				return localize('externalAcpAgents.cwd.none', "No CWD");
			case ExternalAcpAgentCwdPolicy.Fixed:
				return localize('externalAcpAgents.cwd.fixed', "Fixed CWD");
			case ExternalAcpAgentCwdPolicy.Workspace:
				return localize('externalAcpAgents.cwd.workspace', "Workspace CWD");
		}
	}

	private capabilityLabel(capability: ExternalAcpAgentCapability): string {
		return capabilityOptions.find(option => option.capability === capability)?.label ?? capability;
	}

	private registryDistributionLabel(entry: AcpRegistryAgent): string {
		switch (entry.distribution.kind) {
			case 'npx':
				return localize('externalAcpAgents.registryDistributionNpx', "NPX");
			case 'uvx':
				return localize('externalAcpAgents.registryDistributionUvx', "UVX");
			case 'binary':
				return localize('externalAcpAgents.registryDistributionBinary', "Binary");
		}
	}

	private isSideEffectCapability(capability: ExternalAcpAgentCapability): boolean {
		return capability === ExternalAcpAgentCapability.Tools || capability === ExternalAcpAgentCapability.Files || capability === ExternalAcpAgentCapability.Terminal;
	}

	private connectionActionLabel(status: ExternalAcpAgentConnectionStatus | undefined): string {
		if (status?.kind === 'authRequired' || status?.kind === 'testFailed' || status?.kind === 'timeout') {
			return localize('externalAcpAgents.retryConnection', "Retry Connection");
		}
		return localize('externalAcpAgents.testConnection', "Test Connection");
	}

	private connectionStatusLabel(status: ExternalAcpAgentConnectionStatus | undefined): string {
		switch (status?.kind) {
			case 'disabled':
				return localize('externalAcpAgents.status.disabled', "Disabled by Policy");
			case 'authRequired':
				return localize('externalAcpAgents.status.authRequired', "Auth Required");
			case 'loginHelpShown':
				return localize('externalAcpAgents.status.loginHelpShown', "Login Help Shown");
			case 'testSucceeded':
				return localize('externalAcpAgents.status.testSucceeded', "Test Succeeded");
			case 'testFailed':
				return localize('externalAcpAgents.status.testFailed', "Test Failed");
			case 'processNotFound':
				return localize('externalAcpAgents.status.processNotFound', "Process Not Found");
			case 'missingRuntimeEnv':
				return localize('externalAcpAgents.status.missingRuntimeEnv', "Missing Runtime Env");
			case 'timeout':
				return localize('externalAcpAgents.status.timeout', "Timeout");
			case 'unknown':
			default:
				return localize('externalAcpAgents.status.unknown', "Status Unknown");
		}
	}

	private connectionStatusDetail(status: ExternalAcpAgentConnectionStatus): string {
		const parts = [
			this.connectionStatusLabel(status),
			status.message,
			status.authMethods?.length ? localize('externalAcpAgents.status.authMethods', "Auth Methods: {0}", status.authMethods.map(method => method.label ?? method.id).join(', ')) : undefined,
		].filter((part): part is string => !!part);
		return parts.join(' - ');
	}

	private connectionStatusTone(status: ExternalAcpAgentConnectionStatus | undefined): 'neutral' | 'accent' | 'success' | 'danger' | 'muted' | 'warning' {
		switch (status?.kind) {
			case 'testSucceeded':
				return 'success';
			case 'authRequired':
			case 'disabled':
			case 'loginHelpShown':
			case 'missingRuntimeEnv':
			case 'timeout':
				return 'warning';
			case 'testFailed':
			case 'processNotFound':
				return 'danger';
			default:
				return 'muted';
		}
	}
}
