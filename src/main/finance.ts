/**
 * Financial guard. Omnicore has no code path that spends money (ads, boosts, paid APIs, paid music).
 * Any future feature that could incur a cost must call this first. Autonomy, account connection and
 * publishing approval never count as financial authorization, so this always refuses until an explicit,
 * per-action authorization flow exists and the user has approved that specific spend.
 */
export class FinancialAuthorizationRequired extends Error {
  constructor(readonly action: string) {
    super(`"${action}" would spend money. Omnicore never does this without your explicit authorization for that specific action.`);
    this.name = 'FinancialAuthorizationRequired';
  }
}

export function requireFinancialAuthorization(action: string): never {
  throw new FinancialAuthorizationRequired(action);
}
