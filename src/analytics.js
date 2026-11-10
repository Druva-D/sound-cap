// Google Tag Manager / Google Analytics 4, loaded only when an ID is set in config.js.
// Called after the OAuth ?code= has been stripped from the URL, so it never reaches Google.
// The app itself pushes no listening data, names or Spotify IDs to the dataLayer.
import { GTM_CONTAINER_ID, GA_MEASUREMENT_ID } from './config.js';

function load(src) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.append(s);
}

export function initAnalytics() {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  const gtm = GTM_CONTAINER_ID.trim();
  const ga = GA_MEASUREMENT_ID.trim();
  const useGtm = /^GTM-[A-Z0-9]+$/i.test(gtm);
  const useGa = /^G-[A-Z0-9]+$/i.test(ga);
  if (!useGtm && !useGa) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());

  if (useGtm) {
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    load(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtm)}`);
  }
  if (useGa) {
    window.gtag('config', ga, {
      page_location: location.origin + location.pathname,
      page_referrer: '',
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    load(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga)}`);
  }
}
