// The marketing image as it runs (ADR 0040): built from this directory, started with NO network
// at all (so it cannot depend on the OS API, its database, Redis or identity), read-only, as an
// unprivileged user, without capabilities and with small limits. Requests come from a curl
// container sharing only its loopback. Containers run in CI only, or with AYVO_DOCKER_TESTS=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const CURL = 'curlimages/curl:8.11.1';
const root = resolve(import.meta.dirname, '..');
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
const ok = (res) => {
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
};

describe(
  'marketing container',
  { skip: !WANT_DOCKER && 'docker tests need CI or AYVO_DOCKER_TESTS=1' },
  () => {
    const id = randomBytes(4).toString('hex');
    const image = `ayvo-marketing-test:${id}`;
    const names = { site: `ayvo-mkt-${id}`, noindex: `ayvo-mkt-noindex-${id}` };

    const start = (name, env = []) =>
      ok(
        docker([
          'run',
          '-d',
          '--name',
          name,
          '--network',
          'none',
          '--read-only',
          '--tmpfs',
          '/tmp:size=8m,mode=1777',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '64m',
          '--cpus',
          '0.25',
          '--pids-limit',
          '64',
          ...env.flatMap((e) => ['-e', e]),
          image,
        ]),
      );

    /** One request from inside the container's own network namespace (loopback only). */
    const ask = (name, path, extra = []) => {
      const out = ok(
        docker([
          'run',
          '--rm',
          '--network',
          `container:${name}`,
          CURL,
          '-sS',
          '-D',
          '-',
          '-o',
          '/dev/null',
          '-w',
          '\n%{http_code}',
          ...extra,
          `http://127.0.0.1:8080${path}`,
        ]),
      );
      const lines = out.split(/\r?\n/);
      const status = Number(lines.at(-1));
      const headers = {};
      for (const l of lines) {
        const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (m) headers[m[1].toLowerCase()] = m[2];
      }
      return { status, headers };
    };
    const body = (name, path) =>
      ok(
        docker([
          'run',
          '--rm',
          '--network',
          `container:${name}`,
          CURL,
          '-sS',
          `http://127.0.0.1:8080${path}`,
        ]),
      );

    const waitHealthy = (name) => {
      for (let i = 0; i < 60; i++) {
        const s = ok(docker(['inspect', '-f', '{{.State.Health.Status}}', name]));
        if (s === 'healthy') return;
        if (s === 'unhealthy') assert.fail(`${name} unhealthy: ${docker(['logs', name]).stderr}`);
        spawnSync('sleep', ['1']);
      }
      assert.fail(`${name} not healthy in time`);
    };

    before(() => {
      ok(docker(['build', '-q', '-t', image, root]));
      start(names.site);
      start(names.noindex, ['AYVO_MARKETING_ROBOTS=noindex, nofollow']);
      waitHealthy(names.site);
      waitHealthy(names.noindex);
    });
    after(() => {
      docker(['rm', '-f', names.site, names.noindex]);
      docker(['image', 'rm', image]);
    });

    it('runs isolated: no network, read-only, unprivileged, limited', () => {
      const cfg = JSON.parse(ok(docker(['inspect', names.site])))[0];
      assert.equal(cfg.HostConfig.NetworkMode, 'none');
      assert.deepEqual(Object.keys(cfg.NetworkSettings.Networks), ['none']);
      assert.equal(cfg.HostConfig.ReadonlyRootfs, true);
      assert.equal(cfg.Config.User, '65534:65534');
      assert.equal(cfg.HostConfig.Privileged, false);
      assert.deepEqual(cfg.HostConfig.CapDrop, ['ALL']);
      assert.equal(cfg.HostConfig.Mounts?.length ?? 0, 0);
      assert.equal(cfg.HostConfig.Binds, null);
    });

    it('serves the three languages, assets and the health check — with nothing else reachable', () => {
      for (const [path, lang] of [
        ['/', 'en'],
        ['/cz/', 'cs'],
        ['/de/', 'de'],
      ]) {
        const r = ask(names.site, path);
        assert.equal(r.status, 200, path);
        assert.match(r.headers['content-type'], /^text\/html/);
        assert.match(body(names.site, path), new RegExp(`<html lang="${lang}">`));
      }
      assert.match(ask(names.site, '/assets/site.css').headers['content-type'], /^text\/css/);
      assert.match(
        ask(names.site, '/assets/img/ayvo-bottles.png').headers['content-type'],
        /^image\/png/,
      );
      assert.equal(ask(names.site, '/healthz').status, 200);
      assert.equal(ask(names.site, '/sitemap.xml').status, 200);
      assert.equal(ask(names.site, '/robots.txt').status, 200);
    });

    it('old addresses redirect exactly (301); WordPress paths and unknown pages are a real 404', () => {
      const redirects = {
        '/en': '/',
        '/en/': '/',
        '/cz': '/cz/',
        '/de': '/de/',
        '/sitemap.html': '/',
        '/wp-content/uploads/2026/02/Navrh-bez-nazvu-6.png': '/assets/img/ayvo-bottles.png',
        '/wp-content/uploads/2026/01/logoy.png': '/assets/img/ayvo-logo-light.png',
        '/wp-content/uploads/2025/10/cropped-ayvo_circle_dot_topright-32x32.png':
          '/assets/icons/ayvo-32.png',
      };
      for (const [from, to] of Object.entries(redirects)) {
        const r = ask(names.site, from);
        assert.equal(r.status, 301, from);
        assert.equal(r.headers.location, to, from);
      }
      for (const path of [
        '/wp-admin/',
        '/wp-login.php',
        '/xmlrpc.php',
        '/feed/',
        '/no-such-page',
        '/.env',
      ]) {
        assert.equal(ask(names.site, path).status, 404, path);
      }
      assert.match(body(names.site, '/no-such-page'), /Page not found/);
    });

    it('only GET and HEAD', () => {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = ask(names.site, '/', ['-X', method]);
        assert.equal(r.status, 405, method);
        assert.equal(r.headers.allow, 'GET, HEAD');
      }
      assert.equal(ask(names.site, '/', ['-I']).status, 200);
    });

    it('security headers on pages and errors; no Server header', () => {
      for (const path of ['/', '/cz/', '/no-such-page']) {
        const h = ask(names.site, path).headers;
        assert.equal(
          h['content-security-policy'],
          "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          path,
        );
        assert.equal(h['x-content-type-options'], 'nosniff');
        assert.equal(h['x-frame-options'], 'DENY');
        assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(h.server, undefined);
        assert.equal(h['x-robots-tag'], 'all');
      }
    });

    it('a DEV preview is not indexed (AYVO_MARKETING_ROBOTS)', () => {
      assert.equal(ask(names.noindex, '/').headers['x-robots-tag'], 'noindex, nofollow');
    });
  },
);
