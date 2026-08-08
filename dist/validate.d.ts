import { type RestoreOperation, type RestorePointManifest } from './types.js';
/** Validate a restore-point id before using it in a filesystem path. */
export declare function validateRestorePointId(value: string): string;
/** Validate a restore-operation id before using it in a filesystem path. */
export declare function validateOperationId(value: string): string;
/** Parse an untrusted durable restore-point manifest. */
export declare function parseManifest(value: unknown): RestorePointManifest;
/** Parse an untrusted durable restore-operation journal. */
export declare function parseOperation(value: unknown): RestoreOperation;
/** Validate one SHA-256 blob name. */
export declare function validateBlobHash(value: string): string;
//# sourceMappingURL=validate.d.ts.map