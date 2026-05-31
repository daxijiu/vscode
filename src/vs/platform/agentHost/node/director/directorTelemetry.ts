/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ITelemetryService } from '../../../telemetry/common/telemetry.js';
import type { DirectorResolvedProviderBackend, DirectorBackendResolution } from '../../common/directorProviderBackend.js';

type DirectorSessionOperation = 'create' | 'list' | 'metadata' | 'restore' | 'send' | 'changeModel' | 'dispose' | 'truncate';
type DirectorTelemetryOutcome = 'success' | 'failure' | 'notFound' | 'cancelled';

interface IDirectorSessionTelemetryEvent {
	operation: DirectorSessionOperation;
	outcome: DirectorTelemetryOutcome;
	persisted: boolean;
	sessionCount?: number;
	turnCount?: number;
}

type IDirectorSessionTelemetryClassification = {
	operation: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Director session operation.' };
	outcome: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Director session operation outcome.' };
	persisted: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether persistent session data was used.' };
	sessionCount?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of sessions involved in the operation.' };
	turnCount?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of completed turns involved in the operation.' };
	owner: 'roblourens';
	comment: 'Tracks low-cardinality Director AgentHost session operations without prompts, responses, file paths, or credentials.';
};

interface IDirectorProviderResolutionTelemetryEvent {
	status: DirectorBackendResolution['status'];
	providerKind?: string;
	apiType?: string;
	authKind?: string;
}

type IDirectorProviderResolutionTelemetryClassification = {
	status: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The backend resolution status.' };
	providerKind?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality Director provider kind.' };
	apiType?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality provider API type.' };
	authKind?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality provider auth kind.' };
	owner: 'roblourens';
	comment: 'Tracks Director provider/backend resolution outcomes without provider ids, model ids, prompts, or credentials.';
};

interface IDirectorModelCallTelemetryEvent {
	outcome: 'success' | 'error' | 'cancelled';
	result?: 'success' | 'error_max_turns';
	providerKind: string;
	apiType: string;
	authKind: string;
	errorKind?: string;
	historyTurnCount: number;
	toolCount: number;
}

type IDirectorModelCallTelemetryClassification = {
	outcome: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Director model call outcome.' };
	result?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Director AgentEngine terminal result subtype.' };
	providerKind: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality Director provider kind.' };
	apiType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality provider API type.' };
	authKind: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality provider auth kind.' };
	errorKind?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The low-cardinality model call error kind.' };
	historyTurnCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of prior turns supplied to the provider adapter.' };
	toolCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of AgentHost client tools advertised to the provider.' };
	owner: 'roblourens';
	comment: 'Tracks Director model call outcomes without prompts, responses, file paths, provider ids, model ids, or credentials.';
};

export class DirectorTelemetryReporter {

	constructor(private readonly _telemetryService: ITelemetryService) { }

	session(operation: DirectorSessionOperation, outcome: DirectorTelemetryOutcome, data: { readonly persisted?: boolean; readonly sessionCount?: number; readonly turnCount?: number } = {}): void {
		this._telemetryService.publicLog2<IDirectorSessionTelemetryEvent, IDirectorSessionTelemetryClassification>('director.session', {
			operation,
			outcome,
			persisted: data.persisted === true,
			...(data.sessionCount !== undefined ? { sessionCount: data.sessionCount } : {}),
			...(data.turnCount !== undefined ? { turnCount: data.turnCount } : {}),
		});
	}

	providerResolution(resolution: DirectorBackendResolution): void {
		if (resolution.status === 'ok') {
			this._telemetryService.publicLog2<IDirectorProviderResolutionTelemetryEvent, IDirectorProviderResolutionTelemetryClassification>('director.providerResolution', {
				status: 'ok',
				providerKind: resolution.backend.providerKind,
				apiType: resolution.backend.apiType,
				authKind: resolution.backend.authKind,
			});
			return;
		}
		this._telemetryService.publicLog2<IDirectorProviderResolutionTelemetryEvent, IDirectorProviderResolutionTelemetryClassification>('director.providerResolution', {
			status: resolution.status,
		});
	}

	modelCall(backend: DirectorResolvedProviderBackend, outcome: IDirectorModelCallTelemetryEvent['outcome'], data: {
		readonly result?: IDirectorModelCallTelemetryEvent['result'];
		readonly errorKind?: string;
		readonly historyTurnCount: number;
		readonly toolCount: number;
	}): void {
		this._telemetryService.publicLog2<IDirectorModelCallTelemetryEvent, IDirectorModelCallTelemetryClassification>('director.modelCall', {
			outcome,
			...(data.result ? { result: data.result } : {}),
			providerKind: backend.providerKind,
			apiType: backend.apiType,
			authKind: backend.authKind,
			...(data.errorKind ? { errorKind: data.errorKind } : {}),
			historyTurnCount: data.historyTurnCount,
			toolCount: data.toolCount,
		});
	}
}
