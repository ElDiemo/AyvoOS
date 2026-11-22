// The static site as files (ADR 0040): languages and their metadata, every local link and asset
// resolves, anchors exist, the same section ids in every language (the language switch keeps the
// section), nothing loads from elsewhere (no external fonts, no WordPress leftovers; Google
// Analytics 4 only from the one opt-in script, ADR 0040 amendment), nothing the strict CSP would
// block, and the Caddy redirect targets exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const site = join(root, 'site');
const read = (rel) => readFileSync(join(site, rel), 'utf8');

const PAGES = [
  { file: 'index.html', path: '/', lang: 'en' },
  { file: 'cz/index.html', path: '/cz/', lang: 'cs' },
  { file: 'de/index.html', path: '/de/', lang: 'de' },
];
const ORIGIN = 'https://ayvo.co';
/** The hero's one sentence, exactly as the owner approved it. */
const HERO_LEAD = {
  en: 'We supply hotel amenities in reusable bottles and take care of replenishment, collection and washing.',
  cs: 'Dodáváme hotelovou kosmetiku ve vratných lahvích a zajišťujeme zásobování, svoz i mytí.',
  de: 'Wir liefern Hotelkosmetik in Mehrwegflaschen und kümmern uns um Nachschub, Abholung und Reinigung.',
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const attrs = (html, name) =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const ids = (html) => attrs(html, 'id');
/** Width and height of a WebP file (VP8X, VP8 or VP8L). */
function webpSize(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  if (chunk === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}
/** A site path ("/", "/cz/", "/assets/x.css") → the file it serves. */
const fileOf = (path) => join(site, path.endsWith('/') ? `${path}index.html` : path);

describe('pages', () => {
  for (const page of PAGES) {
    const html = read(page.file);
    it(`${page.path}: language, title, description, canonical, hreflang`, () => {
      assert.match(html, new RegExp(`^<!doctype html>\\n<html lang="${page.lang}">`));
      assert.match(html, /<title>[^<]{10,}<\/title>/);
      assert.match(html, /<meta\s+name="description"\s+content="[^"]{50,}"/);
      assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${page.path}" />`));
      for (const p of PAGES)
        assert.ok(
          html.includes(`<link rel="alternate" hreflang="${p.lang}" href="${ORIGIN}${p.path}" />`),
          `hreflang ${p.lang}`,
        );
      assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`));
      assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'exactly one h1');
    });

    it(`${page.path}: the language switch marks this page and links all three`, () => {
      const current = [...html.matchAll(/<a href="([^"]+)"[^>]*aria-current="page"/g)].map(
        (m) => m[1],
      );
      assert.deepEqual([...new Set(current)], [page.path]);
      for (const p of PAGES) assert.ok(html.includes(`<a href="${p.path}" hreflang="${p.lang}"`));
    });

    it(`${page.path}: slogan, hero CTAs to the pilot and the steps, no unbacked claims`, () => {
      // The compact header: the logo links home, no slogan there (the hero has it).
      const header = html.match(/<header class="ayvo-header">[\s\S]*?<\/header>/)[0];
      assert.ok(header.includes(`<a class="ayvo-brand" href="${page.path}">`));
      assert.doesNotMatch(header, /Refill|ayvo-tagline/);
      const hero = html.match(/<section id="top"[\s\S]*?<\/section>/)[0];
      const targets = [...hero.matchAll(/class="ayvo-btn[^"]*"|href="(#[a-z]+)"/g)]
        .map((m) => m[1])
        .filter(Boolean);
      assert.deepEqual(targets, ['#pilot']);
      // The black-and-gold hero: only the slogan, the h1, one sentence and the CTA (the single
      // wordmark is the header's); the product layer loaded first (LCP), never lazily.
      assert.ok(hero.includes('<p class="ayvo-hero-slogan">Refill. Redefined.</p>'));
      assert.ok(
        hero
          .replace(/\s+/g, ' ')
          .replace(/> /g, '>')
          .replace(/ </g, '<')
          .includes(`<p class="ayvo-hero-lead">${HERO_LEAD[page.lang]}</p>`),
      );
      assert.doesNotMatch(hero, /ayvo-wordmark|<ul|<li/);
      // The h1 in two parts, the second in gold; the CTA arrow is decorative only.
      assert.equal(hero.match(/<span class="ayvo-h1-part[^"]*">/g)?.length, 2);
      assert.match(hero, /<span class="ayvo-h1-part ayvo-h1-gold">[^<]+<\/span>\s*<\/h1>/);
      assert.match(hero, /<span class="ayvo-arrow" aria-hidden="true">→<\/span><\/a\s*>/);
      const visual = hero.match(/<img\s[^>]*class="ayvo-hero-visual"[^>]*>/)?.[0];
      assert.ok(visual, 'hero product image');
      assert.match(visual, /src="\/assets\/img\/ayvo-hero-products\.webp"/);
      // The scene is a separate CSS layer, preloaded with high priority for its width.
      for (const [file, media] of [
        ['ayvo-hero-scene.webp', '(min-width: 861px)'],
        ['ayvo-hero-scene-mobile.webp', '(max-width: 860px)'],
      ])
        assert.ok(
          html
            .replace(/\s+/g, ' ')
            .includes(
              `<link rel="preload" as="image" href="/assets/img/${file}" type="image/webp" media="${media}" fetchpriority="high" />`,
            ),
          file,
        );
      assert.ok(hero.includes('<div class="ayvo-hero-stage">'));
      assert.match(visual, /fetchpriority="high"/);
      assert.doesNotMatch(visual, /loading="lazy"/);
      // No CO2 figures, savings percentages or regulatory compliance promises on the site.
      const text = html.replace(/\shref="[^"]*"/g, '');
      assert.doesNotMatch(text, /CO2|CO₂|\d+\s?%|regulat|regulac|Regulier/i);
    });

    it(`${page.path}: contact by mailto, no portal sign-in yet`, () => {
      assert.match(html, /href="mailto:hello@ayvo\.co\?subject=[^"]+"/);
      assert.doesNotMatch(html, /portal\.ayvo\.co/);
    });
  }

  it('every language has the same section ids, in the same order', () => {
    const sections = PAGES.map((p) =>
      [...read(p.file).matchAll(/<section\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]),
    );
    assert.deepEqual(sections[0], ['top', 'value', 'includes', 'how', 'why', 'pilot', 'standard']);
    for (const s of sections) assert.deepEqual(s, sections[0]);
  });

  it('ids are unique per page', () => {
    for (const p of [...PAGES.map((x) => x.file), '404.html']) {
      const list = ids(read(p));
      assert.equal(new Set(list).size, list.length, p);
    }
  });
});

describe('links and assets', () => {
  const htmlFiles = files(site).filter((f) => f.endsWith('.html'));

  it('every local href/src resolves to a file; every #anchor exists on its page', () => {
    for (const f of htmlFiles) {
      const html = readFileSync(f, 'utf8');
      const own = new Set(ids(html));
      for (const ref of [...attrs(html, 'href'), ...attrs(html, 'src')]) {
        if (/^(https:\/\/ayvo\.co\/|mailto:)/.test(ref)) continue;
        assert.ok(!/^[a-z]+:/i.test(ref) && !ref.startsWith('//'), `${f}: external ${ref}`);
        if (ref.startsWith('#')) {
          assert.ok(own.has(ref.slice(1)), `${f}: missing anchor ${ref}`);
          continue;
        }
        assert.ok(ref.startsWith('/'), `${f}: relative ${ref}`);
        const [path, hash] = ref.split('#');
        assert.ok(existsSync(fileOf(path)), `${f}: ${ref} does not exist`);
        if (hash) assert.ok(ids(readFileSync(fileOf(path), 'utf8')).includes(hash), ref);
      }
    }
  });

  it('absolute URLs point only to the canonical site and to files that exist', () => {
    for (const f of htmlFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/https:\/\/ayvo\.co(\/[^"\s]*)/g))
        assert.ok(existsSync(fileOf(m[1])), `${f}: ${m[0]}`);
    }
  });

  it('SVG files are well-formed: an XML comment never contains "--" (the image would not load)', () => {
    for (const f of files(site).filter((x) => x.endsWith('.svg'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<!--([\s\S]*?)-->/g))
        assert.ok(!m[1].includes('--'), f);
    }
  });

  it('images have alt text and their real dimensions', () => {
    for (const f of htmlFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<img\s[^>]*>/g)) {
        assert.match(m[0], /\salt="[^"]+"/, `${f}: ${m[0]}`);
        const [, w] = m[0].match(/\swidth="(\d+)"/) ?? [];
        const [, h] = m[0].match(/\sheight="(\d+)"/) ?? [];
        const [, src] = m[0].match(/\ssrc="([^"]+)"/);
        const file = readFileSync(fileOf(src));
        if (src.endsWith('.svg')) {
          const svg = file.toString('utf8');
          assert.equal(svg.match(/<svg[^>]*\swidth="(\d+)"/)?.[1], w, src);
          assert.equal(svg.match(/<svg[^>]*\sheight="(\d+)"/)?.[1], h, src);
        } else if (src.endsWith('.webp')) {
          assert.deepEqual(webpSize(file), [Number(w), Number(h)], src);
        } else {
          assert.equal(file.readUInt32BE(16), Number(w), src);
          assert.equal(file.readUInt32BE(20), Number(h), src);
        }
      }
    }
  });
});

describe('no third parties except the opt-in analytics script, strict CSP', () => {
  const CONSENT = join(site, 'assets', 'consent.js');
  const all = files(site).filter((f) => /\.(html|css|js|txt|xml)$/.test(f) && f !== CONSENT);
  const FORBIDDEN = [
    /googletagmanager|google-analytics|gtag\(|dataLayer/i,
    /cookieyes|cookie-law-info|cky-/i,
    /fonts\.googleapis|fonts\.gstatic|@import|@font-face/i,
    /wp-content|wp-json|wp-includes|xmlrpc|elementor|jquery/i,
    /portal\.ayvo\.co/i,
  ];

  it('no tracking, external fonts or WordPress leftovers', () => {
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      for (const re of FORBIDDEN) assert.doesNotMatch(text, re, f);
    }
  });

  it('Google Analytics 4 only in consent.js: one ID, advertising denied, no user data', () => {
    const js = readFileSync(CONSENT, 'utf8');
    assert.deepEqual([...new Set(js.match(/G-[A-Z0-9]{6,}/g))], ['G-W8X01GWW5Z']);
    assert.deepEqual(js.match(/https:\/\/[^\s'`"]+/g), [
      'https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}',
    ]);
    assert.match(js, /PUBLIC_HOSTS = \['ayvo\.co', 'www\.ayvo\.co'\]/);
    for (const ad of ['ad_storage', 'ad_user_data', 'ad_personalization']) {
      assert.match(js, new RegExp(`${ad}: 'denied'`));
      assert.doesNotMatch(js, new RegExp(`${ad}: 'granted'`));
    }
    assert.match(js, /allow_google_signals: false/);
    assert.match(
      js,
      /page_location: `\$\{window\.location\.origin\}\$\{window\.location\.pathname\}`/,
    );
    assert.match(js, /cookie_expires: COOKIE_EXPIRES_S/);
    assert.match(js, /COOKIE_EXPIRES_S = 180 \* 24 \* 60 \* 60;/);
    assert.match(js, /cookie_update: false/);
    assert.match(js, /allow_ad_personalization_signals: false/);
    assert.doesNotMatch(js, /user_id|(?<!ad_)user_data|email|gtag\('event'/i);
    assert.doesNotMatch(js, /\beval\(|new Function|innerHTML|document\.write/);
    // Every page with the banner loads the script and offers the choice again in the footer.
    for (const page of PAGES) {
      const html = read(page.file);
      assert.match(html, /<script src="\/assets\/consent\.js" defer><\/script>/, page.file);
      const banner = html.match(/<section\s+class="ayvo-consent"[\s\S]*?<\/section>/)[0];
      assert.match(banner, /\shidden\s*>/, `${page.file}: hidden until the script decides`);
      const choices = [
        ...banner.matchAll(
          /<button type="button" class="ayvo-consent-btn" data-consent="(granted|denied)">/g,
        ),
      ].map((m) => m[1]);
      assert.deepEqual(choices, ['granted', 'denied'], page.file);
      assert.doesNotMatch(banner, /autofocus|aria-pressed|checked|selected/, page.file);
      assert.match(banner, /Google Analytics 4/, page.file);
      assert.match(banner, /_ga/, page.file);
      assert.match(
        html,
        /<button type="button" class="ayvo-consent-open" data-consent-open hidden>/,
      );
    }
  });

  it('nothing the CSP blocks: no inline style, no inline script, no event handlers', () => {
    for (const f of all.filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(f, 'utf8');
      assert.doesNotMatch(html, /\sstyle="/, `${f}: inline style`);
      assert.doesNotMatch(html, /<style[\s>]/, `${f}: style element`);
      assert.doesNotMatch(html, /\son[a-z]+="/, `${f}: event handler`);
      for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /\ssrc="\//, f);
    }
  });
});

describe('robots, sitemap, Caddy', () => {
  it('robots points to the sitemap; the sitemap lists the three languages with alternates', () => {
    assert.match(read('robots.txt'), /^Sitemap: https:\/\/ayvo\.co\/sitemap\.xml$/m);
    const xml = read('sitemap.xml');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(
      locs,
      PAGES.map((p) => `${ORIGIN}${p.path}`),
    );
    assert.equal(xml.match(/<xhtml:link /g).length, PAGES.length * (PAGES.length + 1));
  });

  it('every redirect of the Caddyfile leads to a page or file that exists', () => {
    const caddy = readFileSync(join(root, 'Caddyfile'), 'utf8');
    const redirects = [...caddy.matchAll(/^\s*redir (\S+) (\S+) 301$/gm)];
    assert.ok(redirects.length >= 10);
    for (const [, from, to] of redirects) {
      const shadowed = existsSync(fileOf(from)) && statSync(fileOf(from)).isFile();
      assert.ok(!shadowed, `${from} shadows a file`);
      assert.ok(existsSync(fileOf(to)), `${from} → ${to}`);
    }
  });

  it('relative links of the README resolve (from apps/marketing/)', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const links = [...readme.matchAll(/\]\((\.{1,2}\/[^)#]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length > 0);
    for (const l of links) assert.ok(existsSync(resolve(root, l)), l);
  });

  it('the 404 page links back to every language', () => {
    const html = read('404.html');
    for (const p of PAGES) assert.ok(html.includes(`href="${p.path}"`));
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.doesNotMatch(html.match(/<header[\s\S]*?<\/header>/)[0], /Refill|ayvo-tagline/);
  });
});
