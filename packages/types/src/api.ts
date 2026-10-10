/**
 * Path prefix under which the API serves every route. The browser reaches the API on the same
 * origin as the web app (`https://dev.ayvo.co/api/*`, no CORS); the reverse proxy forwards the
 * path unchanged, so this prefix is the single place where it is defined.
 */
export const API_BASE_PATH = '/api';
