// Single source of truth for the frontend origins this Worker trusts for
// credentialed CORS. Split into its own module so index.js and
// chatGeneration.js can both import it without a circular dependency
// (index.js is what imports ChatGeneration from chatGeneration.js).
//
// NEW_WEB_ORIGIN (sennoric.com) is not live yet as of this change --
// DNS/GitHub Pages cutover pending. Accepted here ahead of time so CORS
// doesn't need another deploy the moment it goes live.
export const WEB_ORIGIN = 'https://axion.amplifiedsmp.org'
export const NEW_WEB_ORIGIN = 'https://sennoric.com'
export const ALLOWED_WEB_ORIGINS = [WEB_ORIGIN, NEW_WEB_ORIGIN]
