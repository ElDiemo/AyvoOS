import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A SIMULATED PPL CPL API for automated tests only (doc 029 §5): the documented behaviour —
 * OAuth token (client credentials, expires_in), POST /shipment/batch → 201 + Location, batch status
 * progressing Accepted → Complete with `relatedItems` for set parcels (answered in shuffled order),
 * GET /shipment with each number's `externalNumbers`, label files on /data/{guid}, asynchronous
 * cancellation (202, then `Canceled`), the product code list. Tests steer faults through `mode`.
 * No real PPL host is ever contacted. Also started by scripts/start-e2e-server.mjs for the browser
 * tests of the site's PPL settings (verification against this simulation).
 */
export const BASE_PATH = '/ecs/ppl/myapi2';

type Mode = {
  /** 201 without a Location header. */
  noLocation: boolean;
  /**
   * The header's spelling on the wire: PPL writes every header in lower case since 2026-02-09
   * (developer.ppl.cz, "změny v HTTP hlavičkách") — `location`, the default; `Location` as before.
   */
  locationHeader: 'location' | 'Location';
  /** POST /shipment/batch answers 500. */
  batchError: boolean;
  /** 400 problem+json validation refusal. */
  reject: boolean;
  /** Polls answering InProcess before Complete. */
  processingPolls: number;
  /** The last set parcel fails (Error) while the others are created. */
  partial: boolean;
  /** GET /shipment omits the parcel's own externalNumbers (no proof). */
  hideExternals: boolean;
  /** labelUrl points to another host / the /data endpoint redirects / is too large. */
  labelForeignHost: boolean;
  labelRedirect: boolean;
  labelHuge: boolean;
  /** Everything answers 503 (PPL unavailable). */
  down: boolean;
  /** Only the token endpoint answers 503. */
  tokenDown: boolean;
  /** One more created number than parcels, claiming parcel 1's CUST reference. */
  extraNumber: boolean;
  /** Label URLs relative to the API host. */
  labelRelative: boolean;
  /** The next cancel requests answer 500 (lost / unusable answer), then normally. */
  cancelFailures: number;
  /** Cancel answers 400 for these numbers (e.g. already picked up). */
  cancelRefuse: string[];
  /** Numbers already picked up from the sender. */
  pickedUp: string[];
  /**
   * Tracking events per number (`trackAndTrace.events`), shaped as the PPL TEST environment
   * answered on 2026-10-20 (statusId, code, phase, group, eventDate, name).
   */
  events: Record<string, object[]>;
  /**
   * GET /shipment returns no item's own CUST for a set, only the shipment's referenceId (positions
   * in the set without a documented relation to the items sent).
   */
  setCustFromShipment: boolean;
  /** GET /shipment answers at most this many items per page (null: as many as Limit asks). */
  pageCap: number | null;
  /** The next PUT shipment/batch/{id} answer 503 / 400. */
  putFailures: number;
  putRefuse: boolean;
  /** After a PUT, the new labels appear only after this many batch status reads. */
  variantDelayReads: number;
  /** The ZPL of the LAST set parcel prints "1/1" (as seen in the TEST environment, 2026-10-20). */
  zplWrongPosition: boolean;
};

/** The shipment-level CUST of a set, if one was sent (PPL then returns it for every parcel). */
function shipmentCust(b: Batch): string | null {
  const s = b.body.shipments[0] as {
    shipmentSet?: unknown;
    externalNumbers?: { code?: string; externalNumber?: string }[];
  };
  if (!s.shipmentSet) return null;
  return s.externalNumbers?.find((e) => e.code === 'CUST')?.externalNumber ?? null;
}

interface Batch {
  id: string;
  body: { shipments: Record<string, unknown>[]; labelSettings?: { format?: string } };
  polls: number;
  numbers: { number: string; ref: string; master: boolean }[];
  /**
   * The label output versions of the batch (documented PUT shipment/batch/{id}): every change makes
   * a new version whose data GUIDs differ (`<number>-v<version>`); old GUIDs keep their content.
   */
  versions: { format: 'Pdf' | 'Zpl'; dpi: number | null }[];
  /** Status reads before the latest version becomes visible (simulates PPL's processing). */
  hiddenReads: number;
}

export class FakePpl {
  private server!: Server;
  base = '';
  tokens = 0;
  /** PUT shipment/batch/{id} calls (format changes). */
  puts = 0;
  validToken = '';
  readonly mode: Mode = FakePpl.fresh();
  readonly batches = new Map<string, Batch>();
  readonly cancelled = new Set<string>();
  /** Every request seen: method + path (+ whether a Bearer token was present). */
  readonly seen: {
    method: string;
    path: string;
    bearer: boolean;
    /** The account (client id) whose token was used, if any. */
    client: string | null;
    host: string;
    /** The query string of the request (paging and lookups are asserted on it). */
    query: URLSearchParams;
    /** The Accept-Language header, if any. */
    lang: string | null;
  }[] = [];
  private serial = 4_000_000_000;

  readonly clientId: string;
  readonly clientSecret: string;
  /** Further accounts PPL knows (client id → secret), e.g. after credentials were replaced. */
  readonly clients = new Map<string, string>();
  /** The client id each issued token belongs to. */
  readonly tokenClient = new Map<string, string>();

  // No parameter properties: the Playwright API server loads this file with Node's type stripping.
  constructor(clientId = 'fake-client-id', clientSecret = 'fake-client-secret') {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private static fresh(): Mode {
    return {
      noLocation: false,
      locationHeader: 'location',
      batchError: false,
      reject: false,
      processingPolls: 0,
      partial: false,
      hideExternals: false,
      labelForeignHost: false,
      labelRedirect: false,
      labelHuge: false,
      down: false,
      tokenDown: false,
      extraNumber: false,
      labelRelative: false,
      cancelFailures: 0,
      cancelRefuse: [],
      pickedUp: [],
      events: {},
      setCustFromShipment: false,
      pageCap: null,
      putFailures: 0,
      putRefuse: false,
      variantDelayReads: 0,
      zplWrongPosition: false,
    };
  }

  reset(): void {
    Object.assign(this.mode, FakePpl.fresh());
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${BASE_PATH}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.slice(BASE_PATH.length);
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const client = this.tokenClient.get(token) ?? null;
    const bearer = client !== null;
    this.seen.push({
      method: req.method ?? '',
      path,
      bearer,
      client,
      host: req.headers.host ?? '',
      query: url.searchParams,
      lang:
        typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : null,
    });
    if (this.mode.down) return this.json(res, 503, { title: 'Service unavailable' });

    if (req.method === 'POST' && path === '/login/getAccessToken') {
      if (this.mode.tokenDown) return this.json(res, 503, { title: 'Service unavailable' });
      const form = new URLSearchParams(await this.body(req));
      const id = form.get('client_id') ?? '';
      const known = id === this.clientId ? this.clientSecret : this.clients.get(id);
      if (
        known === undefined ||
        form.get('client_secret') !== known ||
        form.get('grant_type') !== 'client_credentials' ||
        form.get('scope') !== 'myapi2'
      ) {
        return this.json(res, 401, { error: 'invalid_client' });
      }
      this.tokens += 1;
      this.validToken = `tok-${randomUUID()}`;
      this.tokenClient.set(this.validToken, id);
      return this.json(res, 200, {
        access_token: this.validToken,
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'myapi2',
      });
    }
    if (!bearer) return this.json(res, 401, { title: 'Unauthorized' });

    if (req.method === 'GET' && path === '/codelist/product') {
      // Obviously simulated codes: real PPL products are read from PPL, never copied from examples.
      return this.json(res, 200, [
        { code: 'SIM-A', name: 'Simulovaná služba A (není služba PPL)' },
        { code: 'SIM-B', name: 'Simulovaná služba B (není služba PPL)' },
      ]);
    }
    if (req.method === 'POST' && path === '/shipment/batch') {
      const body = JSON.parse(await this.body(req)) as Batch['body'];
      if (this.mode.reject) {
        return this.json(res, 400, {
          title: 'One or more validation errors occurred.',
          status: 400,
          errors: { 'shipments[0].ProductType': ['Invalid value'] },
        });
      }
      if (this.mode.batchError) return this.json(res, 500, { title: 'Internal error' });
      const count = (body.shipments[0]!.shipmentSet as { numberOfShipments?: number } | undefined)
        ?.numberOfShipments;
      if (count !== undefined && count > 50) {
        // Documented: "Počet balíků na adresu - Max 50".
        return this.json(res, 400, {
          title: 'One or more validation errors occurred.',
          status: 400,
          errors: { 'shipments[0].ShipmentSet.NumberOfShipments': ['Max 50'] },
        });
      }
      const id = randomUUID();
      const s = body.shipments[0]!;
      const set = s.shipmentSet as
        { shipmentSetItems: { externalNumbers: { externalNumber: string }[] }[] } | undefined;
      const refs = set
        ? set.shipmentSetItems.map((i) => i.externalNumbers[0]!.externalNumber)
        : [`${String(s.referenceId)}-1`];
      const numbers = refs.map((ref, i) => ({
        number: String(this.serial++),
        ref,
        master: i === 0,
      }));
      if (this.mode.extraNumber)
        numbers.push({ number: String(this.serial++), ref: refs[0]!, master: false });
      const settings = body.labelSettings as { format?: string; dpi?: number } | undefined;
      this.batches.set(id, {
        id,
        body,
        polls: 0,
        numbers,
        versions: [
          settings?.format === 'Zpl'
            ? { format: 'Zpl', dpi: settings.dpi ?? 203 }
            : { format: 'Pdf', dpi: null },
        ],
        hiddenReads: 0,
      });
      return this.json(
        res,
        201,
        {},
        this.mode.noLocation
          ? {}
          : { [this.mode.locationHeader]: `${this.base}/shipment/batch/${id}` },
      );
    }
    const batchMatch = /^\/shipment\/batch\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === 'PUT' && batchMatch) {
      // Documented: changes the label output of an existing batch (204); nothing is created.
      const b = this.batches.get(batchMatch[1]!);
      if (!b) return this.json(res, 404, { title: 'Not found' });
      this.puts += 1;
      if (this.mode.putFailures > 0) {
        this.mode.putFailures -= 1;
        return this.json(res, 503, { title: 'Service unavailable' });
      }
      const ls = (
        JSON.parse(await this.body(req)) as { labelSettings?: { format?: string; dpi?: number } }
      ).labelSettings;
      if (
        this.mode.putRefuse ||
        !ls ||
        (ls.format !== 'Zpl' && ls.format !== 'Pdf') ||
        (ls.format === 'Zpl' && (!ls.dpi || ls.dpi < 203 || ls.dpi > 1200))
      ) {
        return this.json(res, 400, {
          title: 'One or more validation errors occurred.',
          status: 400,
        });
      }
      b.versions.push(
        ls.format === 'Zpl' ? { format: 'Zpl', dpi: ls.dpi! } : { format: 'Pdf', dpi: null },
      );
      b.hiddenReads = this.mode.variantDelayReads;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && batchMatch) {
      const b = this.batches.get(batchMatch[1]!);
      if (!b) return this.json(res, 404, { title: 'Not found' });
      b.polls += 1;
      // The latest version once visible (a PUT may still be processing).
      let version = b.versions.length - 1;
      if (b.hiddenReads > 0) {
        b.hiddenReads -= 1;
        version -= 1;
      }
      const processing = b.polls <= this.mode.processingPolls;
      const state = (last: boolean) =>
        processing ? 'InProcess' : this.mode.partial && last ? 'Error' : 'Complete';
      const label = (number: string) => {
        const n = `${number}-v${version}`;
        return this.mode.labelForeignHost
          ? `http://evil.example/data/${n}`
          : this.mode.labelRelative
            ? `${BASE_PATH}/data/${n}`
            : `${this.base}/data/${n}`;
      };
      const [master, ...rest] = b.numbers;
      const related = rest
        .map((x, i) => ({
          shipmentNumber: state(i === rest.length - 1) === 'Error' ? null : x.number,
          importState: state(i === rest.length - 1),
          errorCode: state(i === rest.length - 1) === 'Error' ? 'SetItemError' : null,
          errorMessage:
            state(i === rest.length - 1) === 'Error' ? 'Parcel could not be created' : null,
          labelUrl: label(x.number),
          relationType: 'ShipmentSet',
        }))
        .reverse(); // never in the order sent
      return this.json(res, 200, {
        items: [
          {
            referenceId: b.body.shipments[0]!.referenceId,
            shipmentNumber: processing ? null : master!.number,
            importState: processing ? 'InProcess' : 'Complete',
            labelUrl: label(master!.number),
            relatedItems: processing ? [] : related,
          },
        ],
        // As documented: the complete document comes from GET shipment/batch/{batchId}/label.
        completeLabel: {
          labelUrls: [
            this.mode.labelForeignHost
              ? `http://evil.example/shipment/batch/${b.id}/label?pageSize=A4`
              : `${this.base}/shipment/batch/${b.id}/label?pageSize=A4&position=1&limit=200&offset=0`,
          ],
        },
      });
    }
    if (req.method === 'GET' && path === '/shipment') {
      const wanted = url.searchParams.getAll('ShipmentNumbers');
      // As documented: ShipmentNumbers maxItems 50; Limit (1–1000) and Offset (≥ 0) required.
      const limit = Number(url.searchParams.get('Limit'));
      const offset = Number(url.searchParams.get('Offset'));
      if (
        wanted.length > 50 ||
        !url.searchParams.has('Limit') ||
        !url.searchParams.has('Offset') ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !Number.isInteger(offset) ||
        offset < 0
      ) {
        return this.json(res, 400, {
          title: 'One or more validation errors occurred.',
          status: 400,
        });
      }
      const all = [...this.batches.values()].flatMap((b) =>
        b.numbers.map((n, i) => ({
          ...n,
          ref:
            this.mode.setCustFromShipment && b.numbers.length > 1
              ? String(b.body.shipments[0]!.referenceId)
              : // As the real TEST environment (live runs 2026-10-19 and -20): a shipment-level
                // CUST overrides every set item's own.
                (shipmentCust(b) ?? n.ref),
          set:
            b.numbers.length > 1
              ? {
                  masterShipmentNumber: b.numbers[0]!.number,
                  shipmentsInSet: b.numbers.length,
                  shipmentInSetNumber: i + 1,
                }
              : { shipmentsInSet: 0, shipmentInSetNumber: 0 },
        })),
      );
      const matching = all.filter((x) => wanted.includes(x.number));
      // One page: at most Limit items (and at most pageCap, as a server may answer less).
      const size = Math.min(limit, this.mode.pageCap ?? limit);
      return this.json(
        res,
        200,
        matching.slice(offset, offset + size).map((x) => ({
          shipmentNumber: x.number,
          // Flags, comma-separated — as the real TEST environment answers.
          shipmentState: this.cancelled.has(x.number)
            ? 'Undelivered, DataShipment, Canceled'
            : this.mode.pickedUp.includes(x.number)
              ? 'PickedUpFromSender, Active'
              : 'Undelivered, DataShipment, Active',
          externalNumbers: this.mode.hideExternals ? [] : [{ code: 'CUST', externalNumber: x.ref }],
          shipmentSet: x.set,
          trackAndTrace: { events: this.mode.events[x.number] ?? [] },
        })),
        {
          'X-Paging-Total-Items-Count': String(matching.length),
          'X-Paging-Offset': String(offset),
          'X-Paging-Limit': String(size),
        },
      );
    }
    const dataMatch = /^\/data\/(.+)$/.exec(path);
    if (req.method === 'GET' && dataMatch) {
      if (this.mode.labelRedirect) {
        res.writeHead(302, { location: 'http://evil.example/steal' });
        res.end();
        return;
      }
      // The label of this number in the output version its GUID names.
      const m = /^(\d+)-v(\d+)$/.exec(dataMatch[1]!);
      const batch = m
        ? [...this.batches.values()].find((b) => b.numbers.some((n) => n.number === m[1]))
        : undefined;
      const v = batch?.versions[Number(m?.[2])];
      if (!m || !batch || !v) return this.json(res, 404, { title: 'Not found' });
      if (this.mode.labelHuge) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6 * 1024 * 1024, 32)]));
        return;
      }
      const number = m[1]!;
      const index = batch.numbers.findIndex((n) => n.number === number);
      const count = batch.numbers.length;
      // As PPL prints it: the number, "Ref.:" = the CUST in force, the position in the set.
      const ref = shipmentCust(batch) ?? batch.numbers[index]!.ref;
      const position =
        this.mode.zplWrongPosition && v.format === 'Zpl' && count > 1 && index === count - 1
          ? '1/1'
          : `${index + 1}/${count}`;
      if (v.format === 'Zpl') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(
          `^XA^PW807^LH0,0^FO20,20^FDSIMULATED PPL - NOT A REAL LABEL^FS^FO20,60^FD${number}^FS` +
            `^FO20,100^FDRef.: ${ref}^FS^FO20,140^FD${position}^FS^PQ1,0,0,^XZ`,
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(`%PDF-1.4\n% fake PPL label ${number} Ref.: ${ref} ${position}\n%%EOF\n`);
      return;
    }
    const completeMatch = /^\/shipment\/batch\/([0-9a-f-]{36})\/label$/.exec(path);
    if (req.method === 'GET' && completeMatch) {
      const b = this.batches.get(completeMatch[1]!);
      if (!b) return this.json(res, 404, { title: 'Not found' });
      if (!url.searchParams.has('limit') || !url.searchParams.has('offset')) {
        return this.json(res, 400, { title: 'limit and offset are required' });
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(`%PDF-1.4\n% fake PPL complete A4 document of batch ${b.id}\n%%EOF\n`);
      return;
    }
    const cancelMatch = /^\/shipment\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      const n = decodeURIComponent(cancelMatch[1]!);
      if (this.mode.cancelFailures > 0) {
        this.mode.cancelFailures -= 1;
        return this.json(res, 500, { title: 'Internal error' });
      }
      if (this.mode.cancelRefuse.includes(n) || this.mode.pickedUp.includes(n)) {
        return this.json(res, 400, { title: 'Shipment cannot be cancelled', status: 400 });
      }
      this.cancelled.add(n);
      return this.json(res, 202, {});
    }
    return this.json(res, 404, { title: 'Not found' });
  }
}
