/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentConfig, ExternalAcpAgentCwdPolicy, createExternalAcpAgentConfig, sanitizeExternalAcpAgentId, toExternalAcpAgentSnapshot, validateExternalAcpAgentConfig } from '../../../../../platform/agentHost/common/acpAgentConfig.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IExternalAcpAgentRegistryService, IExternalAcpAgentSnapshotService } from '../../common/externalAcpAgentProviderService.js';

const $ = DOM.$;

interface ExternalAcpAgentsShell {
	readonly root: HTMLElement;
	readonly status: HTMLElement;
	readonly agents: HTMLElement;
	readonly diagnostics: HTMLElement;
}

type AgentDialogMode =
	| { readonly kind: 'new' }
	| { readonly kind: 'edit'; readonly agent: ExternalAcpAgentConfig };

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
	private readonly agentsRenderDisposables = this._register(new DisposableStore());
	private readonly modalDisposables = this._register(new DisposableStore());
	private renderGeneration = 0;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IExternalAcpAgentRegistryService private readonly registryService: IExternalAcpAgentRegistryService,
		@IExternalAcpAgentSnapshotService private readonly snapshotService: IExternalAcpAgentSnapshotService,
	) {
		super();
		this._register(this.registryService.onDidChangeAgents(() => { void this.refresh({ preserveScroll: true }); }));
	}

	render(container: HTMLElement): void {
		if (this.container !== container) {
			this.renderDisposables.clear();
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
		const agents = DOM.append(root, $('.eaa-agents-host'));
		const diagnostics = DOM.append(root, $('.eaa-diagnostics-host'));
		this.shell = { root, status, agents, diagnostics };
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
		if (agents.some(agent => !validateExternalAcpAgentConfig(agent).valid)) {
			DOM.append(list, $('.eaa-note.eaa-note-error')).textContent = localize('externalAcpAgents.invalidConfigNote', "One or more manual configs are invalid and will not be emitted to the AgentHost snapshot.");
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
		this.createTag(tags, this.cwdPolicyLabel(agent.cwdPolicy), 'neutral');
		this.createTag(tags, agent.applyState === 'pendingRestart' ? localize('externalAcpAgents.pendingRestartTag', "Pending Restart") : localize('externalAcpAgents.applyStateCleanTag', "Snapshot Written"), agent.applyState === 'pendingRestart' ? 'accent' : 'neutral');
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

		const actions = DOM.append(row, $('.eaa-agent-actions'));
		this.addAction(actions, localize('externalAcpAgents.edit', "Edit"), 'secondary', () => this.showAgentDialog({ kind: 'edit', agent }), disposables);
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

	private async refreshSnapshot(): Promise<void> {
		await this.snapshotService.writeSnapshot();
		this.notificationService.info(localize('externalAcpAgents.snapshotRefreshed', "External ACP Agents snapshot refreshed."));
		await this.refresh({ preserveScroll: true });
	}

	private async showSnapshotLocation(): Promise<void> {
		this.notificationService.info(await this.snapshotService.getSnapshotResource());
	}

	private showAgentDialog(mode: AgentDialogMode): void {
		const existing = mode.kind === 'edit' ? mode.agent : undefined;
		this.showDialog(mode.kind === 'edit' ? localize('externalAcpAgents.editAgent', "Edit External ACP Agent") : localize('externalAcpAgents.addManualAgent', "Add External ACP Agent"), (body, footer, close) => {
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
					enabled: enabledInput.checked,
					trusted: trustedInput.checked,
					capabilities: capabilityInputs.filter(input => input.input.checked).map(input => input.capability),
					envVariableNames: this.parseLines(envInput.value),
					secretRefs: this.parseLines(secretRefsInput.value),
				});
				const validation = validateExternalAcpAgentConfig(agent);
				if (!validation.valid) {
					this.setStatus(status, validation.message ?? localize('externalAcpAgents.invalidConfig', "Invalid external ACP agent config."), 'error');
					return;
				}
				await this.registryService.saveAgent(agent);
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

	private isSideEffectCapability(capability: ExternalAcpAgentCapability): boolean {
		return capability === ExternalAcpAgentCapability.Tools || capability === ExternalAcpAgentCapability.Files || capability === ExternalAcpAgentCapability.Terminal;
	}
}
