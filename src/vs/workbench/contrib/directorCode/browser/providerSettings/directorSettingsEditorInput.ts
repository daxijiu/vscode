/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const directorSettingsEditorIcon = registerIcon('director-settings-editor-label-icon', Codicon.settingsGear, localize('directorSettingsEditorLabelIcon', 'Icon of the Director Settings editor label.'));

export class DirectorSettingsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.directorSettings';

	static readonly RESOURCE = URI.from({
		scheme: Schemas.vscode,
		authority: 'director',
		path: '/settings'
	});

	private static instance: DirectorSettingsEditorInput | undefined;

	static getInstance(): DirectorSettingsEditorInput {
		if (!DirectorSettingsEditorInput.instance || DirectorSettingsEditorInput.instance.isDisposed()) {
			DirectorSettingsEditorInput.instance = new DirectorSettingsEditorInput();
		}
		return DirectorSettingsEditorInput.instance;
	}

	override get typeId(): string {
		return DirectorSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return DirectorSettingsEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	readonly resource = DirectorSettingsEditorInput.RESOURCE;

	override getName(): string {
		return localize('directorSettingsInputName', "Director Settings");
	}

	override getIcon(): ThemeIcon {
		return directorSettingsEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof DirectorSettingsEditorInput;
	}
}

export class DirectorSettingsEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '';
	}

	deserialize(_instantiationService: IInstantiationService): EditorInput {
		return DirectorSettingsEditorInput.getInstance();
	}
}
