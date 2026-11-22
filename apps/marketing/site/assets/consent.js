// AYVO marketing site — opt-in website analytics (Google Analytics 4), ADR 0040 amendment 2026-11-22.
// Basic consent mode: before the visitor allows analytics nothing is requested from Google and no
// analytics cookie is written; after "Decline" nothing ever is. Only on the public hostnames
// (never on the DEV preview or a test host). The choice is versioned, kept in this browser for
// 180 days, shared by all language versions and all open tabs, and changed in the footer. A
// withdrawal stops measuring at once (ga-disable), removes the _ga cookies the page can reach,
// and reloads every open page so no Google tag stays loaded. Advertising stays denied; no user ID.
(() => {
  const MEASUREMENT_ID = 'G-W8X01GWW5Z';
  const PUBLIC_HOSTS = ['ayvo.co', 'www.ayvo.co'];
  const KEY = 'ayvo.consent';
  const VERSION = 1;
  const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
  const DISABLE = `ga-disable-${MEASUREMENT_ID}`;

  const banner = document.querySelector('[data-consent-banner]');
  if (!banner) return;
  const status = banner.querySelector('[data-consent-status]');
  const openers = Array.from(document.querySelectorAll('[data-consent-open]'));
  const root = document.documentElement;

  /** The stored choice ('granted' | 'denied') if it is of this version and not expired. */
  const read = () => {
    let raw = null;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw);
      const at = Date.parse(v.at);
      const fresh = at <= Date.now() + 60_000 && Date.now() - at < MAX_AGE_MS;
      if (v.v === VERSION && (v.analytics === 'granted' || v.analytics === 'denied') && fresh) {
        return v.analytics;
      }
    } catch {
      // unreadable: treated as no choice
    }
    try {
      window.localStorage.removeItem(KEY); // an old version or an expired choice is not kept
    } catch {
      // storage unavailable
    }
    return null;
  };

  const write = (analytics) => {
    try {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({ v: VERSION, analytics, at: new Date().toISOString() }),
      );
    } catch {
      // storage unavailable: the choice holds for this page only
    }
  };

  /** Removes every _ga / _ga_<id> cookie on this host and on each parent domain. */
  const removeAnalyticsCookies = () => {
    const names = document.cookie
      .split(';')
      .map((c) => c.split('=')[0].trim())
      .filter((n) => /^_ga($|_)/.test(n));
    const parts = window.location.hostname.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts.slice(i).join('.');
      domains.push(`; domain=${d}`, `; domain=.${d}`);
    }
    for (const name of names) {
      for (const domain of domains) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
      }
    }
  };

  let tagLoaded = false;

  /** Loads the Google tag once, after consent, only on a public hostname. */
  const startAnalytics = () => {
    if (tagLoaded || !PUBLIC_HOSTS.includes(window.location.hostname)) return;
    tagLoaded = true;
    window[DISABLE] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments); // eslint-disable-line prefer-rest-params
    };
    const gtag = window.gtag;
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('set', 'ads_data_redaction', true);
    gtag('set', { allow_google_signals: false, allow_ad_personalization_signals: false });
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
    document.head.appendChild(script);
  };

  /** Stops measuring at once and removes the reachable analytics cookies. */
  const stopAnalytics = () => {
    window[DISABLE] = true;
    removeAnalyticsCookies();
  };

  const showStatus = (choice) => {
    if (!status) return;
    status.textContent = choice ? status.getAttribute(`data-text-${choice}`) || '' : '';
    status.hidden = !choice;
  };

  let opener = null;
  const showBanner = (focus) => {
    showStatus(read());
    banner.hidden = false;
    root.classList.add('ayvo-consent-shown');
    root.style.setProperty('--ayvo-consent-h', `${banner.offsetHeight}px`);
    if (focus) banner.querySelector('[data-consent]')?.focus();
  };
  const hideBanner = () => {
    banner.hidden = true;
    root.classList.remove('ayvo-consent-shown');
    if (opener) opener.focus();
    opener = null;
  };

  const choose = (choice) => {
    write(choice);
    hideBanner();
    if (choice === 'granted') {
      startAnalytics();
    } else {
      stopAnalytics();
      if (tagLoaded) window.location.reload(); // no Google tag stays loaded after a withdrawal
    }
  };

  for (const button of banner.querySelectorAll('[data-consent]')) {
    button.addEventListener('click', () => choose(button.getAttribute('data-consent')));
  }
  for (const button of openers) {
    button.hidden = false;
    button.addEventListener('click', () => {
      opener = button;
      showBanner(true);
    });
  }

  // Another tab (or another language version) changed the choice.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    const choice = read();
    if (choice === 'granted') {
      hideBanner();
      startAnalytics();
      return;
    }
    stopAnalytics();
    if (tagLoaded) {
      window.location.reload();
      return;
    }
    if (choice === 'denied') hideBanner();
    else showBanner(false);
  });

  window.addEventListener('resize', () => {
    if (!banner.hidden) root.style.setProperty('--ayvo-consent-h', `${banner.offsetHeight}px`);
  });

  const choice = read();
  if (choice === 'granted') startAnalytics();
  else {
    stopAnalytics();
    if (choice === null) showBanner(false);
  }
})();
