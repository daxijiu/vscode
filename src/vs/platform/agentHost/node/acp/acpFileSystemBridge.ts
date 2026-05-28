/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { isEqualOrParent as isEqualOrParentPath } from '../../../../base/common/extpath.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../files/common/files.js';
import { toAgentClientUri } from '../../common/agentClientUri.js';
import { AcpJsonRpcError, AcpJsonRpcErrorCode, AcpReadTextFileParams, AcpReadTextFileResult, AcpWriteTextFileParams } from './acpProtocol.js';

export interface AcpFileSystemBridgeOptions {
	readonly workspaceRoot: URI;
	readonly activeClientId?: string;
}

export class AcpFileSystemBridge {

	constructor(
		private readonly fileService: IFileService,
		private readonly options: AcpFileSystemBridgeOptions,
	) { }

	async readTextFile(params: AcpReadTextFileParams): Promise<AcpReadTextFileResult> {
		const resource = this.resolveContainedFile(params?.path);
		const content = (await this.readFile(resource)).toString();
		return {
			content: sliceLines(content, params.line, params.limit),
		};
	}

	async writeTextFile(params: AcpWriteTextFileParams): Promise<null> {
		if (typeof params?.content !== 'string') {
			throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'fs/write_text_file requires string content.');
		}
		const resource = this.resolveContainedFile(params.path);
		await this.writeFile(resource, params.content);
		return null;
	}

	toJsonRpcError(err: unknown): AcpJsonRpcError {
		if (err instanceof AcpFileSystemBridgeError) {
			return {
				code: err.code,
				message: err.message,
			};
		}
		const code = err instanceof Error ? toFileSystemProviderErrorCode(err) : FileSystemProviderErrorCode.Unknown;
		if (code === FileSystemProviderErrorCode.FileNotFound) {
			return {
				code: AcpJsonRpcErrorCode.ResourceNotFound,
				message: 'File not found.',
			};
		}
		if (code === FileSystemProviderErrorCode.NoPermissions) {
			return {
				code: AcpJsonRpcErrorCode.InvalidParams,
				message: 'File access is not permitted.',
			};
		}
		return {
			code: AcpJsonRpcErrorCode.InternalError,
			message: err instanceof Error && err.message ? err.message : 'ACP filesystem bridge request failed.',
		};
	}

	private resolveContainedFile(pathValue: unknown): URI {
		if (typeof pathValue !== 'string' || !pathValue.trim()) {
			throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem requests require an absolute path.');
		}
		if (!isAbsolute(pathValue)) {
			throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem requests require an absolute path.');
		}
		if (this.options.workspaceRoot.scheme !== Schemas.file || this.options.workspaceRoot.authority) {
			throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem bridge is only available for local file workspaces.');
		}
		const resource = URI.file(pathValue);
		if (!isEqualOrParentPath(resource.fsPath, this.options.workspaceRoot.fsPath, isWindows)) {
			throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem path is outside the active workspace.');
		}
		return resource;
	}

	private async readFile(resource: URI): Promise<VSBuffer> {
		const clientResource = this.options.activeClientId ? toAgentClientUri(resource, this.options.activeClientId) : undefined;
		if (clientResource) {
			try {
				return (await this.fileService.readFile(clientResource)).value;
			} catch (err) {
				if (toFileSystemProviderErrorCode(err as Error) !== FileSystemProviderErrorCode.Unavailable) {
					throw err;
				}
				// If the client reverse channel is not connected, fall back to the
				// local disk provider. The workspace containment check still applies.
			}
		}
		return (await this.fileService.readFile(resource)).value;
	}

	private async writeFile(resource: URI, content: string): Promise<void> {
		const clientResource = this.options.activeClientId ? toAgentClientUri(resource, this.options.activeClientId) : undefined;
		if (clientResource) {
			try {
				await this.fileService.writeFile(clientResource, VSBuffer.fromString(content));
				return;
			} catch (err) {
				if (toFileSystemProviderErrorCode(err as Error) !== FileSystemProviderErrorCode.Unavailable) {
					throw err;
				}
				// See readFile fallback above. Direct local writes are only used when
				// there is no live client-side filesystem authority.
			}
		}

		await this.fileService.createFolder(dirname(resource));
		await this.fileService.writeFile(resource, VSBuffer.fromString(content));
	}
}

export class AcpFileSystemBridgeError extends Error {
	constructor(
		readonly code: AcpJsonRpcErrorCode,
		message: string,
	) {
		super(message);
	}
}

function sliceLines(content: string, line: number | undefined, limit: number | undefined): string {
	const startLine = normalizeLine(line);
	const maxLines = normalizeLimit(limit);
	if (maxLines === 0) {
		return '';
	}

	const lineStarts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			lineStarts.push(i + 1);
		}
	}

	const startOffset = lineStarts[startLine - 1];
	if (startOffset === undefined) {
		throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, `Attempting to read beyond the end of the file at line ${startLine}.`);
	}
	if (maxLines === undefined) {
		return content.slice(startOffset);
	}

	const endOffset = lineStarts[startLine - 1 + maxLines] ?? content.length;
	return content.slice(startOffset, endOffset);
}

function normalizeLine(value: number | undefined): number {
	if (value === undefined) {
		return 1;
	}
	if (!Number.isFinite(value) || value < 1) {
		throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem line must be a positive number.');
	}
	return Math.floor(value);
}

function normalizeLimit(value: number | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isFinite(value) || value < 0) {
		throw new AcpFileSystemBridgeError(AcpJsonRpcErrorCode.InvalidParams, 'ACP filesystem limit must be a non-negative number.');
	}
	return Math.floor(value);
}
