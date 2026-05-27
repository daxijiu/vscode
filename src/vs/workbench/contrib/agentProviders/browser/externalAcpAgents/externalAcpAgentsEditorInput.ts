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

const externalAcpAgentsEditorIcon = registerIcon('external-acp-agents-editor-label-icon', Codicon.remote, localize('externalAcpAgentsEditorLabelIcon', 'Icon of the External ACP Agents editor label.'));

export class ExternalAcpAgentsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.externalAcpAgents';

	static readonly RESOURCE = URI.from({
		scheme: Schemas.vscode,
		authority: 'external-acp-agents',
		path: '/settings'
	});

	private static instance: ExternalAcpAgentsEditorInput | undefined;

	static getInstance(): ExternalAcpAgentsEditorInput {
		if (!ExternalAcpAgentsEditorInput.instance || ExternalAcpAgentsEditorInput.instance.isDisposed()) {
			ExternalAcpAgentsEditorInput.instance = new ExternalAcpAgentsEditorInput();
		}
		return ExternalAcpAgentsEditorInput.instance;
	}

	override get typeId(): string {
		return ExternalAcpAgentsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return ExternalAcpAgentsEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	readonly resource = ExternalAcpAgentsEditorInput.RESOURCE;

	override getName(): string {
		return localize('externalAcpAgentsInputName', "External ACP Agents");
	}

	override getIcon(): ThemeIcon {
		return externalAcpAgentsEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ExternalAcpAgentsEditorInput;
	}
}

export class ExternalAcpAgentsEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '';
	}

	deserialize(_instantiationService: IInstantiationService): EditorInput {
		return ExternalAcpAgentsEditorInput.getInstance();
	}
}
