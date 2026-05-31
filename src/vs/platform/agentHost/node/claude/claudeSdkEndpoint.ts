/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';

export interface IClaudeSdkEndpointHandle extends IDisposable {
	readonly baseUrl: string;
	readonly nonce: string;
}
