/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { basename } from '../../../../base/common/resources.js';
import { isUriComponents, URI } from '../../../../base/common/uri.js';
import { AgentProvider, AgentSession, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import type { Turn } from '../../common/state/sessionState.js';

export interface IDirectorPersistedSession {
	readonly metadata: IAgentSessionMetadata;
	readonly turns: readonly Turn[];
}

interface IDirectorPersistedMetadata {
	readonly version: 1;
	readonly sessionId: string;
	readonly startTime: number;
	readonly modifiedTime: number;
	readonly workingDirectory?: string;
	readonly model?: ModelSelection;
	readonly summary?: string;
}

interface IDirectorSessionCatalog {
	readonly version: 1;
	readonly sessionIds: readonly string[];
	readonly updatedAt: number;
}

const DIRECTOR_SESSION_METADATA_KEY = 'director.session.metadata.v1';
const DIRECTOR_SESSION_TURNS_KEY = 'director.session.turns.v1';
const DIRECTOR_SESSION_CATALOG_KEY = 'director.session.catalog.v1';
const DIRECTOR_SESSION_CATALOG_ID = '__director-session-catalog-v1';

export class DirectorSessionStore {

	private readonly _catalogSequencer = new Sequencer();

	constructor(
		private readonly _provider: AgentProvider,
		private readonly _sessionDataService: ISessionDataService,
	) { }

	async writeSession(metadata: IAgentSessionMetadata, turns: readonly Turn[]): Promise<void> {
		const sessionId = AgentSession.id(metadata.session);
		const ref = this._sessionDataService.openDatabase(metadata.session);
		try {
			await Promise.all([
				ref.object.setMetadata(DIRECTOR_SESSION_METADATA_KEY, JSON.stringify(toPersistedMetadata(sessionId, metadata))),
				ref.object.setMetadata(DIRECTOR_SESSION_TURNS_KEY, JSON.stringify(turns)),
			]);
		} finally {
			ref.dispose();
		}
		await this._addToCatalog(sessionId);
	}

	async readSession(session: URI): Promise<IDirectorPersistedSession | undefined> {
		const ref = await this._sessionDataService.tryOpenDatabase(session);
		if (!ref) {
			return undefined;
		}
		try {
			const [metadataRaw, turnsRaw] = await Promise.all([
				ref.object.getMetadata(DIRECTOR_SESSION_METADATA_KEY),
				ref.object.getMetadata(DIRECTOR_SESSION_TURNS_KEY),
			]);
			const metadata = parsePersistedMetadata(this._provider, metadataRaw);
			if (!metadata) {
				return undefined;
			}
			return {
				metadata,
				turns: parsePersistedTurns(turnsRaw),
			};
		} finally {
			ref.dispose();
		}
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const catalog = await this._readCatalog();
		const sessions: IAgentSessionMetadata[] = [];
		for (const sessionId of catalog.sessionIds) {
			if (sessionId === DIRECTOR_SESSION_CATALOG_ID) {
				continue;
			}
			const persisted = await this.readSession(AgentSession.uri(this._provider, sessionId));
			if (persisted) {
				sessions.push(persisted.metadata);
			}
		}
		return sessions;
	}

	async deleteSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._removeFromCatalog(sessionId);
		await this._sessionDataService.deleteSessionData(session);
	}

	private _catalogSession(): URI {
		return AgentSession.uri(this._provider, DIRECTOR_SESSION_CATALOG_ID);
	}

	private async _addToCatalog(sessionId: string): Promise<void> {
		await this._catalogSequencer.queue(async () => {
			const catalog = await this._readCatalog();
			if (catalog.sessionIds.includes(sessionId)) {
				return;
			}
			await this._writeCatalog([...catalog.sessionIds, sessionId]);
		});
	}

	private async _removeFromCatalog(sessionId: string): Promise<void> {
		await this._catalogSequencer.queue(async () => {
			const catalog = await this._readCatalog();
			const sessionIds = catalog.sessionIds.filter(candidate => candidate !== sessionId);
			if (sessionIds.length === catalog.sessionIds.length) {
				return;
			}
			await this._writeCatalog(sessionIds);
		});
	}

	private async _readCatalog(): Promise<IDirectorSessionCatalog> {
		const ref = await this._sessionDataService.tryOpenDatabase(this._catalogSession());
		if (!ref) {
			return { version: 1, sessionIds: [], updatedAt: 0 };
		}
		try {
			return parseCatalog(await ref.object.getMetadata(DIRECTOR_SESSION_CATALOG_KEY));
		} finally {
			ref.dispose();
		}
	}

	private async _writeCatalog(sessionIds: readonly string[]): Promise<void> {
		const ref = this._sessionDataService.openDatabase(this._catalogSession());
		try {
			await ref.object.setMetadata(DIRECTOR_SESSION_CATALOG_KEY, JSON.stringify({
				version: 1,
				sessionIds,
				updatedAt: Date.now(),
			} satisfies IDirectorSessionCatalog));
		} finally {
			ref.dispose();
		}
	}
}

function toPersistedMetadata(sessionId: string, metadata: IAgentSessionMetadata): IDirectorPersistedMetadata {
	return {
		version: 1,
		sessionId,
		startTime: metadata.startTime,
		modifiedTime: metadata.modifiedTime,
		...(metadata.workingDirectory ? { workingDirectory: metadata.workingDirectory.toString() } : {}),
		...(metadata.model ? { model: sanitizeModelSelection(metadata.model) } : {}),
		...(metadata.summary ? { summary: metadata.summary } : {}),
	};
}

function parsePersistedMetadata(provider: AgentProvider, raw: string | undefined): IAgentSessionMetadata | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.sessionId !== 'string' || typeof parsed.startTime !== 'number' || typeof parsed.modifiedTime !== 'number') {
			return undefined;
		}
		const workingDirectory = typeof parsed.workingDirectory === 'string' ? URI.parse(parsed.workingDirectory) : undefined;
		const model = parseModelSelection(parsed.model);
		return {
			session: AgentSession.uri(provider, parsed.sessionId),
			startTime: parsed.startTime,
			modifiedTime: parsed.modifiedTime,
			...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
			...(workingDirectory ? { workingDirectory, project: projectFromWorkingDirectory(workingDirectory) } : {}),
			...(model ? { model } : {}),
		};
	} catch {
		return undefined;
	}
}

function parsePersistedTurns(raw: string | undefined): Turn[] {
	if (!raw) {
		return [];
	}
	try {
		const revived = revivePersistedValue(JSON.parse(raw) as unknown);
		if (!Array.isArray(revived)) {
			return [];
		}
		const turns: Turn[] = [];
		for (const item of revived) {
			if (isPersistedTurn(item)) {
				turns.push(item);
			}
		}
		return turns;
	} catch {
		return [];
	}
}

function parseCatalog(raw: string | undefined): IDirectorSessionCatalog {
	if (!raw) {
		return { version: 1, sessionIds: [], updatedAt: 0 };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessionIds)) {
			return { version: 1, sessionIds: [], updatedAt: 0 };
		}
		return {
			version: 1,
			sessionIds: parsed.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string'),
			updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
		};
	} catch {
		return { version: 1, sessionIds: [], updatedAt: 0 };
	}
}

function revivePersistedValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(revivePersistedValue);
	}
	if (!isRecord(value)) {
		return value;
	}
	if (isUriComponents(value)) {
		return URI.revive(value);
	}
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if ((key === 'uri' || key === 'session' || key.endsWith('Directory')) && typeof nested === 'string') {
			result[key] = URI.parse(nested);
		} else {
			result[key] = revivePersistedValue(nested);
		}
	}
	return result;
}

function isPersistedTurn(value: unknown): value is Turn {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& isRecord(value.userMessage)
		&& typeof value.userMessage.text === 'string'
		&& Array.isArray(value.responseParts)
		&& typeof value.state === 'string';
}

function sanitizeModelSelection(value: ModelSelection): ModelSelection {
	return {
		id: value.id,
		...(value.config ? { config: sanitizeStringRecord(value.config) } : {}),
	};
}

function parseModelSelection(value: unknown): ModelSelection | undefined {
	if (!isRecord(value) || typeof value.id !== 'string') {
		return undefined;
	}
	return {
		id: value.id,
		...(isRecord(value.config) ? { config: sanitizeStringRecord(value.config) } : {}),
	};
}

function sanitizeStringRecord(value: Record<string, unknown>): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (typeof nested === 'string') {
			result[key] = nested;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

function projectFromWorkingDirectory(workingDirectory: URI): IAgentSessionProjectInfo {
	return {
		uri: workingDirectory,
		displayName: basename(workingDirectory) || workingDirectory.fsPath || workingDirectory.path,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
