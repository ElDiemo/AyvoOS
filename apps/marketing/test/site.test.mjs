// The static site as files (ADR 0040): languages and their metadata, every local link and asset
// resolves, anchors exist, the same section ids in every language (the language switch keeps the
// section), nothing loads from elsewhere (no tracking, no external fonts, no WordPress leftovers),
// nothing the strict CSP would block, and the Caddy redirect targets exist.
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

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const attrs = (html, name) =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const ids = (html) => attrs(html, 'id');
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

  it('images have alt text and their real dimensions', () => {
    for (const f of htmlFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<img\s[^>]*>/g)) {
        assert.match(m[0], /\salt="[^"]+"/, `${f}: ${m[0]}`);
        const [, w] = m[0].match(/\swidth="(\d+)"/) ?? [];
        const [, h] = m[0].match(/\sheight="(\d+)"/) ?? [];
        const [, src] = m[0].match(/\ssrc="([^"]+)"/);
        const png = readFileSync(fileOf(src));
        assert.equal(png.readUInt32BE(16), Number(w), src);
        assert.equal(png.readUInt32BE(20), Number(h), src);
      }
    }
  });
});

describe('no tracking, no third parties, strict CSP', () => {
  const all = files(site).filter((f) => /\.(html|css|js|txt|xml)$/.test(f));
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

  it('the 404 page links back to every language', () => {
    const html = read('404.html');
    for (const p of PAGES) assert.ok(html.includes(`href="${p.path}"`));
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
  });
});
