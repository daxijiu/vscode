/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import {
	DirectorFileSearchTool,
	DirectorFileSearchToolData,
	DirectorGetChangedFilesTool,
	DirectorGetChangedFilesToolData,
	DirectorGetErrorsTool,
	DirectorGetErrorsToolData,
	DirectorGithubRepoTool,
	DirectorGithubRepoToolData,
	DirectorGrepSearchTool,
	DirectorGrepSearchToolData,
	DirectorListDirectoryTool,
	DirectorListDirectoryToolData,
	DirectorReadFileTool,
	DirectorReadFileToolData,
	DirectorViewImageTool,
	DirectorViewImageToolData,
} from '../../../directorCode/common/agentEngine/directorReadOnlyTools.js';
import { ILanguageModelToolsService, IToolData, IToolImpl } from '../../common/tools/languageModelToolsService.js';

class DirectorReadOnlyToolsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.directorReadOnlyTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this.registerReadTool(toolsService, DirectorReadFileToolData, instantiationService.createInstance(DirectorReadFileTool));
		this.registerReadTool(toolsService, DirectorListDirectoryToolData, instantiationService.createInstance(DirectorListDirectoryTool));
		this.registerReadTool(toolsService, DirectorFileSearchToolData, instantiationService.createInstance(DirectorFileSearchTool));
		this.registerReadTool(toolsService, DirectorGrepSearchToolData, instantiationService.createInstance(DirectorGrepSearchTool));
		this.registerReadTool(toolsService, DirectorGetErrorsToolData, instantiationService.createInstance(DirectorGetErrorsTool));
		this.registerReadTool(toolsService, DirectorGetChangedFilesToolData, instantiationService.createInstance(DirectorGetChangedFilesTool));
		this.registerReadTool(toolsService, DirectorViewImageToolData, instantiationService.createInstance(DirectorViewImageTool));
		this.registerReadTool(toolsService, DirectorGithubRepoToolData, instantiationService.createInstance(DirectorGithubRepoTool));
	}

	private registerReadTool(toolsService: ILanguageModelToolsService, toolData: IToolData, tool: IToolImpl): void {
		this._register(toolsService.registerTool(toolData, tool));
		this._register(toolsService.readToolSet.addTool(toolData));
	}
}

registerWorkbenchContribution2(
	DirectorReadOnlyToolsContribution.ID,
	DirectorReadOnlyToolsContribution,
	WorkbenchPhase.AfterRestored,
);
