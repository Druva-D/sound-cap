// The Spotify app this site logs in with. A Client ID is a public identifier, not a secret:
// it's visible in every Spotify login URL anyway. Soundcap uses PKCE, so there is no client
// secret anywhere. Users can still switch to their own Spotify app from the welcome screen.
export const DEFAULT_CLIENT_ID = '968ece45e79a4ac58b85c49f39e04ae1';

export const SCOPES = 'user-read-recently-played user-top-read';

// Analytics. Set either (or neither) — leave empty to disable tracking.
// Note: scripts loaded this way run with full access to the page, including the user's
// Spotify session, so only use a container whose publishers you trust.
// Google Tag Manager container ID, e.g. "GTM-XXXXXXX". Tags are configured in tagmanager.google.com.
export const GTM_CONTAINER_ID = 'GTM-KXNCS7HC';
// Google Analytics 4 Measurement ID, e.g. "G-XXXXXXXXXX", if you'd rather skip Tag Manager.
export const GA_MEASUREMENT_ID = '';
