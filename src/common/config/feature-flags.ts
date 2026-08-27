/**
 * Env-driven beta feature flags — keep not-fully-functional capabilities behind a flag,
 * default OFF. Getters (not consts) so the value is read at call time, not import time.
 */
export const featureFlags = {
  /**
   * Real transactional email — OFF until a provider is wired into `EmailService`
   * (in-app notifications unaffected). Set `EMAIL_NOTIFICATIONS_ENABLED=true` to flip on.
   */
  get emailNotifications(): boolean {
    return process.env.EMAIL_NOTIFICATIONS_ENABLED === 'true';
  },
};
