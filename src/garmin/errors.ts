/**
 * Shared error types for the Garmin layers.
 *
 * Kept in their own module so both the auth layer and the client layer can throw
 * and classify them without a circular import (client imports auth, not vice versa).
 */

/** Generic auth failure during login / token exchange. */
export class GarminAuthError extends Error {}
/** Wrong credentials — aborts the login cascade (no fallback attempt). */
export class InvalidCredentialsError extends GarminAuthError {}
/** No/expired token — the user must (re-)run `npm run login`. */
export class GarminAuthRequiredError extends Error {}
/** Garmin throttled us with a 429. */
export class GarminRateLimitError extends Error {}
