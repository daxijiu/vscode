/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { DirectorSettingsEditorInput } from './directorSettingsEditorInput.js';
import { ProviderSettingsWidget } from './providerSettingsWidget.js';

export class DirectorSettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.directorSettings';

	private container: HTMLElement | undefined;
	private widget: ProviderSettingsWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(DirectorSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, DOM.$('.director-settings-editor'));
		this.widget = this._register(this.instantiationService.createInstance(ProviderSettingsWidget));
		this.widget.render(this.container);
	}

	override async setInput(input: DirectorSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.widget?.refresh();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			DOM.size(this.container, dimension.width, dimension.height);
		}
	}
}
