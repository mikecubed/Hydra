/** Stub — real implementation provided by Track A (T1). */

export interface LoginResult {
  operatorId: string;
}

export interface AuthError {
  code: string;
  message: string;
}

export async function login(_identity: string, _secret: string): Promise<LoginResult> {
  throw new Error('stub — not implemented');
}
