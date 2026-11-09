// Synthetic stand-ins for the core's portal contract and Finance's portal invoices (ADR 0045 §6),
// for portal-web's browser tests only. They check what the real units check of portal-web — its
// own token per receiver, the forwarded portal session, the browser request it forwards — and
// every answer is validated against the shared contract schemas before it is sent.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  portalChallengeStepSchema,
  portalHotelProfileRequestSchema,
  portalHotelProfileSchema,
  portalHotelSchema,
  portalInvoicePageSchema,
  portalInvoiceSchema,
  portalMfaResultSchema,
  portalSessionViewSchema,
} from '@ayvo/types';

export const STUB = {
  portalOrigin: 'http://localhost:3300',
  coreToken: 'c'.repeat(43),
  financeToken: 'f'.repeat(43),
  activationToken: 'A'.repeat(43),
  email: 'recepce@hotel-e2e.test',
  password: 'Dlouhe portalove heslo 2026',
  code: '123456',
};
const user = { id: randomUUID(), email: STUB.email, displayName: 'Recepce E2E' };
const hotel = {
  id: randomUUID(),
  code: 'H-000901',
  name: 'Hotel Portál E2E',
  addressLine1: 'Portálová 1',
  addressLine2: null,
  postalCode: '779 00',
  city: 'Olomouc',
  countryCode: 'CZ',
};
/** A hotel of another account: never reachable from this session. */
export const FOREIGN_HOTEL_ID = randomUUID();
const freshProfile = () => ({
  addressLine1: hotel.addressLine1,
  addressLine2: null,
  postalCode: hotel.postalCode,
  city: hotel.city,
  contactName: 'Marie Recepční',
  contactPhone: '+420 585 000 111',
  contactEmail: 'recepce@hotel-e2e.test',
  receivingContactName: null,
  receivingContactPhone: null,
  receivingContactEmail: null,
  deliveryNote: null,
});
const fingerprint = (fields) =>
  createHash('sha256')
    .update(JSON.stringify([hotel.id, ...Object.values(fields)]))
    .digest('hex');
const profileView = (fields) => ({
  id: hotel.id,
  name: hotel.name,
  countryCode: hotel.countryCode,
  address: {
    addressLine1: fields.addressLine1,
    addressLine2: fields.addressLine2,
    postalCode: fields.postalCode,
    city: fields.city,
  },
  contact: { name: fields.contactName, phone: fields.contactPhone, email: fields.contactEmail },
  receiving: {
    contactName: fields.receivingContactName,
    contactPhone: fields.receivingContactPhone,
    contactEmail: fields.receivingContactEmail,
    deliveryNote: fields.deliveryNote,
  },
  fingerprint: fingerprint(fields),
});
const invoice = (n, over = {}) => ({
  id: randomUUID(),
  number: `T2026-0000${n}`,
  kind: 'TEST',
  issuedOn: '2026-10-01',
  dueOn: '2026-10-15',
  periodMonth: '2026-09',
  total: '12500.00',
  currency: 'CZK',
  hotels: [{ id: hotel.id, code: hotel.code, name: hotel.name }],
  paymentState: 'UNPAID',
  paid: '0.00',
  remaining: '12500.00',
  cancelled: false,
  ...over,
});
const invoices = [
  invoice(1, { paymentState: 'PAID', paid: '12500.00', remaining: '0.00' }),
  invoice(2),
];
const pdf = Buffer.from('%PDF-1.4\n% synthetic portal e2e invoice\n%%EOF\n');

const state = {
  financeDown: false,
  /** 'ok' | 'down' (503) | 'lost' (the session is ended, then the answer is lost). */
  logoutMode: 'ok',
  /** 'ok' | 'oversize' (Content-Length over 10 MB) | 'disposition' (an unexpected header). */
  pdfMode: 'ok',
  lastClient: null,
  coreCalls: 0,
  sessions: new Set(),
  pending: new Map(),
  /** The hotel's stored profile; `profileGrant: false` = the grant on it was revoked. */
  profile: freshProfile(),
  profileGrant: true,
  profileSaves: 0,
  lastProfileBody: null,
};

const send = (res, status, body, schema) => {
  const value = schema ? schema.parse(body) : body;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const refuse = (res, status, code) =>
  send(res, status, { statusCode: status, code, message: code });
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
const authorized = (req, token) => req.headers.authorization === `Bearer ${token}`;
const session = (req) => {
  const s = req.headers['x-ayvo-portal-session'];
  return typeof s === 'string' && state.sessions.has(s) ? s : null;
};

async function core(req, res, path) {
  state.coreCalls++;
  if (!authorized(req, STUB.coreToken)) return refuse(res, 401, 'SERVICE_UNAUTHENTICATED');
  if (req.method === 'POST' && path.startsWith('auth/')) {
    const body = await readBody(req);
    state.lastClient = body.client ?? null;
    // The core's own CSRF check of the forwarded browser request.
    if (body.client?.origin !== STUB.portalOrigin) return refuse(res, 403, 'CSRF_REJECTED');
    const step = path.slice('auth/'.length);
    if (step === 'password') {
      if (body.email !== STUB.email || body.password !== STUB.password)
        return refuse(res, 401, 'INVALID_LOGIN');
      const challenge = randomUUID();
      state.pending.set(challenge, 'LOGIN');
      return send(
        res,
        200,
        { step: 'MFA', challenge, maxAgeSeconds: 300 },
        portalChallengeStepSchema,
      );
    }
    if (step === 'activate') {
      if (body.token !== STUB.activationToken) return refuse(res, 400, 'INVALID_LINK');
      const challenge = randomUUID();
      state.pending.set(challenge, 'ENROLL');
      return send(
        res,
        200,
        {
          step: 'ENROLL_MFA',
          challenge,
          maxAgeSeconds: 900,
          qrDataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          setupKey: 'JBSWY3DPEHPK3PXP',
        },
        portalChallengeStepSchema,
      );
    }
    if (step === 'mfa') {
      const kind = state.pending.get(body.challenge);
      if (!kind || body.code !== STUB.code) return refuse(res, 401, 'INVALID_MFA');
      state.pending.delete(body.challenge);
      // A replaced app ends every earlier session of the account (as the core does).
      if (kind === 'REPLACE') state.sessions.clear();
      const token = randomUUID();
      state.sessions.add(token);
      return send(
        res,
        200,
        {
          step: 'DONE',
          session: token,
          maxAgeSeconds: 3600,
          ...(kind === 'ENROLL' ? { recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'] } : {}),
          ...(kind === 'REPLACE' ? { recoveryCodes: ['nnnn-oooo-pppp', 'qqqq-rrrr-ssss'] } : {}),
        },
        portalMfaResultSchema,
      );
    }
    if (step === 'logout') {
      if (state.logoutMode === 'down') return refuse(res, 503, 'PORTAL_BUSY');
      const s = session(req);
      if (s) state.sessions.delete(s);
      if (state.logoutMode === 'lost') {
        req.socket.destroy();
        return;
      }
      res.writeHead(204).end();
      return;
    }
    return refuse(res, 404, 'NOT_FOUND');
  }
  const s = session(req);
  if (!s) return refuse(res, 401, 'UNAUTHENTICATED');
  if (req.method === 'POST' && path === 'account/logout-all') {
    const body = await readBody(req);
    if (body.client?.origin !== STUB.portalOrigin) return refuse(res, 403, 'CSRF_REJECTED');
    if (state.logoutMode === 'down') return refuse(res, 503, 'PORTAL_BUSY');
    state.sessions.clear();
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && path === 'account/replace-mfa') {
    // "Zabezpečení účtu": the core's checks — the browser's origin, the password and a current code.
    const body = await readBody(req);
    state.lastClient = body.client ?? null;
    if (body.client?.origin !== STUB.portalOrigin) return refuse(res, 403, 'CSRF_REJECTED');
    if (body.password !== STUB.password || body.code !== STUB.code)
      return refuse(res, 401, 'INVALID_CREDENTIALS');
    const challenge = randomUUID();
    state.pending.set(challenge, 'REPLACE');
    return send(
      res,
      200,
      {
        step: 'ENROLL_MFA',
        challenge,
        maxAgeSeconds: 900,
        qrDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        setupKey: 'KRSXG5CTMVRXEZLU',
      },
      portalChallengeStepSchema,
    );
  }
  if (path === 'session')
    return send(
      res,
      200,
      {
        user,
        idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        grants: [{ id: randomUUID(), payerCustomerId: randomUUID(), hotelIds: [hotel.id] }],
      },
      portalSessionViewSchema,
    );
  if (path === 'hotels')
    return send(
      res,
      200,
      [hotel].map((h) => portalHotelSchema.parse(h)),
    );
  if (path === `hotels/${hotel.id}`) return send(res, 200, hotel, portalHotelSchema);
  const profileMatch = path.match(/^hotels\/([^/]+)\/profile$/);
  if (profileMatch) {
    const granted = profileMatch[1] === hotel.id && state.profileGrant;
    if (req.method === 'GET') {
      if (!granted) return refuse(res, 404, 'HOTEL_NOT_FOUND');
      return send(res, 200, profileView(state.profile), portalHotelProfileSchema);
    }
    const raw = await readBody(req);
    state.lastProfileBody = raw;
    const parsed = portalHotelProfileRequestSchema.safeParse(raw);
    if (!parsed.success) return refuse(res, 400, 'VALIDATION');
    // The core's own CSRF check of the forwarded browser request.
    if (parsed.data.client.origin !== STUB.portalOrigin) return refuse(res, 403, 'CSRF_REJECTED');
    if (!granted) return refuse(res, 404, 'HOTEL_NOT_FOUND');
    if (parsed.data.expected !== fingerprint(state.profile))
      return refuse(res, 409, 'PROFILE_STALE');
    state.profile = { ...parsed.data.profile };
    state.profileSaves++;
    return send(res, 200, profileView(state.profile), portalHotelProfileSchema);
  }
  if (path.startsWith('hotels/')) return refuse(res, 404, 'HOTEL_NOT_FOUND');
  return refuse(res, 404, 'NOT_FOUND');
}

function finance(req, res, path) {
  if (state.financeDown) {
    req.socket.destroy();
    return;
  }
  if (!authorized(req, STUB.financeToken)) return refuse(res, 401, 'SERVICE_UNAUTHENTICATED');
  if (!session(req)) return refuse(res, 401, 'UNAUTHENTICATED');
  const [base, id, pdfPart] = path.split('?')[0].split('/');
  if (base !== 'invoices') return refuse(res, 404, 'NOT_FOUND');
  if (!id)
    return send(
      res,
      200,
      { items: invoices, total: invoices.length, page: 1, pageSize: 20 },
      portalInvoicePageSchema,
    );
  const found = invoices.find((i) => i.id === id);
  if (!found) return refuse(res, 404, 'INVOICE_NOT_FOUND');
  if (pdfPart === 'pdf') {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length':
        state.pdfMode === 'oversize' ? String(11 * 1024 * 1024) : String(pdf.length),
      'content-disposition':
        state.pdfMode === 'disposition'
          ? 'inline; filename="../../evil.html"'
          : `attachment; filename="${found.number}.pdf"`,
      'cache-control': 'private, no-store',
    });
    res.end(pdf);
    return;
  }
  return send(res, 200, found, portalInvoiceSchema);
}

const CORE = '/api/internal/v1/portal/';
export function startStubs(corePort = 4301, financePort = 4311) {
  const control = async (req, res) => {
    if (req.url === '/__state')
      return send(res, 200, {
        lastClient: state.lastClient,
        coreCalls: state.coreCalls,
        sessions: state.sessions.size,
        profile: state.profile,
        profileSaves: state.profileSaves,
        lastProfileBody: state.lastProfileBody,
        foreignHotelId: FOREIGN_HOTEL_ID,
        hotelId: hotel.id,
        invoices,
      });
    if (req.url === '/__control') {
      const body = await readBody(req);
      if (body.resetProfile) {
        state.profile = freshProfile();
        state.profileGrant = true;
        delete body.resetProfile;
      }
      if (body.touchProfile) {
        // Another account saved meanwhile.
        state.profile = { ...state.profile, city: `${state.profile.city}-jinde` };
        delete body.touchProfile;
      }
      Object.assign(state, body);
      return send(res, 200, { ok: true });
    }
    return false;
  };
  const coreServer = createServer(async (req, res) => {
    if ((await control(req, res)) !== false) return;
    if (!req.url?.startsWith(CORE)) return refuse(res, 404, 'NOT_FOUND');
    await core(req, res, req.url.slice(CORE.length));
  }).listen(corePort, '127.0.0.1');
  const financeServer = createServer((req, res) => {
    if (!req.url?.startsWith(CORE)) return refuse(res, 404, 'NOT_FOUND');
    finance(req, res, req.url.slice(CORE.length));
  }).listen(financePort, '127.0.0.1');
  return { coreServer, financeServer };
}

if (import.meta.url === `file://${process.argv[1]}`) startStubs();
