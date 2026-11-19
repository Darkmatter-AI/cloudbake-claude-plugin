// A stand-in for CloudBake's /v1 and for storage, on localhost, for the plugin's tests: the answers have
// the shapes https://cloudbake.ai/docs/api describes. A job moves one step each time it is asked about: queued,
// checking, rendering (a frame more each time), done. Run it alone to try the plugin in Claude Code
// without spending anything: `node claude-plugin/test/fake-api.mjs --serve` prints its address. (Without
// --serve it does nothing, because `node --test` runs every file in a test folder.)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

export const FAKE_KEY = `cb_live_${'0123456789abcdef'.repeat(2)}01234567`;
// One small PNG, 2 x 2 and orange, for every frame: a real one, so Claude can open it.
function png() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]); // 2 x 2, 8 bits, RGB
  const row = Buffer.from([0, 240, 128, 40, 240, 128, 40]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
export const PNG = png();

const hex = (bytes) => randomBytes(bytes).toString('hex');

function parseFrames(value) {
  const out = [];
  for (const part of String(value).split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    for (let frame = from; frame <= to; frame += 1) out.push(frame);
  }
  return out;
}

export async function startFakeApi({ steps = 1 } = {}) {
  const state = { uploads: new Map(), jobs: new Map(), puts: [], calls: [], idempotency: new Map(), outOfCredit: false };
  let origin = '';

  const jobView = (job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    scene: job.scene,
    upload: job.upload,
    frames: { total: job.frames.length, done: job.done },
    ...(job.kind === 'convert' ? { formats: job.formats } : {}),
    options: job.options,
    error: job.error,
    created_at: '2026-11-18T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    links: { self: `${origin}/v1/jobs/${job.id}`, files: `${origin}/v1/jobs/${job.id}/files` },
  });
  const uploadView = (upload) => ({
    id: upload.id,
    status: upload.status,
    name: upload.name,
    bytes: upload.bytes,
    parts: null,
    upload_url: upload.status === 'waiting' ? `${origin}/r2/uploads/${upload.id}` : null,
    upload_url_expires_at: null,
    error: null,
    created_at: '2026-11-18T10:00:00.000Z',
    completed_at: null,
    expires_at: null,
    links: { self: `${origin}/v1/uploads/${upload.id}` },
  });
  const advance = (job) => {
    for (let step = 0; step < steps; step += 1) {
      if (job.status === 'queued') job.status = 'checking';
      else if (job.status === 'checking') job.status = job.failWith ? 'failed' : job.kind === 'convert' ? 'converting' : 'rendering';
      else if (job.status === 'converting') job.status = 'done';
      else if (job.status === 'rendering') {
        job.done += 1;
        if (job.done >= job.frames.length) job.status = 'done';
      }
      if (job.status === 'failed') job.error = job.failWith;
    }
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    const error = (status, code, message) => send(status, { error: { code, message } });

    // Storage: an upload's PUT and a job's files.
    if (url.pathname.startsWith('/r2/')) {
      if (request.method === 'PUT') {
        const id = url.pathname.split('/').pop();
        const upload = state.uploads.get(id);
        if (!request.headers['content-length']) return error(411, 'length_required', 'No Content-Length');
        state.puts.push({ id, bytes: raw.length, head: raw.subarray(0, 7).toString('latin1') });
        upload.received = raw.length;
        response.writeHead(200).end();
        return;
      }
      const name = url.pathname.split('/').pop();
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(name.endsWith('.png') ? PNG : Buffer.from(`fake ${name}`));
      return;
    }

    state.calls.push({ method: request.method, path: url.pathname, auth: request.headers.authorization, idempotencyKey: request.headers['idempotency-key'], body: raw.length ? JSON.parse(raw.toString()) : undefined });
    if (request.headers.authorization !== `Bearer ${FAKE_KEY}`) return error(401, 'api_key_invalid', 'This API key does not work. Make a new one at https://cloudbake.ai/app/connections.');
    const body = raw.length ? JSON.parse(raw.toString()) : {};
    const parts = url.pathname.split('/').filter(Boolean); // v1, jobs, rq_…, files

    if (request.method === 'GET' && url.pathname === '/v1/me') return send(200, { email: 'ana@studio.com', key: { name: 'Claude Code', last_four: FAKE_KEY.slice(-4) } });

    if (request.method === 'POST' && url.pathname === '/v1/uploads') {
      const upload = { id: `up_${hex(8)}`, status: 'waiting', name: body.name ?? 'scene.blend', bytes: body.bytes ?? null, received: null };
      state.uploads.set(upload.id, upload);
      return send(201, uploadView(upload));
    }

    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      const key = request.headers['idempotency-key'];
      if (key && state.idempotency.has(key)) return send(200, jobView(state.jobs.get(state.idempotency.get(key))));
      if (state.outOfCredit) return error(402, 'out_of_credit', 'Your balance is $0.00, so no new job can start. Add credit at https://cloudbake.ai/app/credits: jobs start again at once.');
      let scene = 'sample';
      if (body.upload) {
        const upload = state.uploads.get(body.upload);
        if (!upload) return error(404, 'upload_not_found', 'There is no upload with this id for your account.');
        if (upload.received === null) return error(409, 'upload_not_received', 'Nothing has arrived for this upload yet.');
        if (upload.bytes !== null && upload.bytes !== upload.received) return error(400, 'size_mismatch', 'The file that arrived is not the size the upload said.');
        upload.status = 'ready';
        scene = upload.name;
      }
      const convert = body.kind === 'convert';
      const job = {
        id: `rq_${hex(8)}`,
        kind: convert ? 'convert' : 'render',
        status: 'queued',
        scene,
        upload: body.upload ?? null,
        frames: convert ? [] : parseFrames(body.frames ?? '1-4'),
        formats: body.formats,
        done: 0,
        options: Object.fromEntries(Object.entries(body).filter(([name]) => ['samples', 'width', 'height', 'engine', 'draco'].includes(name))),
        error: null,
        failWith: scene === 'broken.blend' ? { code: 'no_camera', message: 'The scene has no camera. Add one and set it as the scene camera.', you_can_fix_it: true } : null,
      };
      state.jobs.set(job.id, job);
      if (key) state.idempotency.set(key, job.id);
      return send(201, jobView(job), { location: `${origin}/v1/jobs/${job.id}` });
    }

    if (parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) {
      const job = state.jobs.get(parts[2]);
      if (!job) return error(404, 'job_not_found', 'There is no job with this id for your account.');
      if (request.method === 'GET' && parts.length === 3) {
        advance(job);
        return send(200, jobView(job));
      }
      if (request.method === 'GET' && parts[3] === 'files') {
        const ended = ['done', 'failed', 'cancelled'].includes(job.status);
        const frames = job.frames.slice(0, job.done).map((frame) => {
          const name = `frame_${String(frame).padStart(5, '0')}.png`;
          return { name, frame, bytes: PNG.length, url: `${origin}/r2/outputs/${job.id}/${name}` };
        });
        const files = !ended ? [] : job.kind === 'convert' ? job.formats.map((format) => ({ name: `scene.${format}`, frame: null, bytes: 9, url: `${origin}/r2/outputs/${job.id}/scene.${format}` })) : frames.length ? [...frames, { name: 'frames.zip', frame: null, bytes: 100, url: `${origin}/r2/outputs/${job.id}/frames.zip` }] : [];
        return send(200, { job: jobView(job), files, ...(ended ? {} : { note: 'The files are listed once the job has ended.' }) });
      }
      if (request.method === 'POST' && parts[3] === 'cancel') {
        if (['done', 'failed', 'cancelled'].includes(job.status)) return send(200, jobView(job));
        job.status = 'cancelled';
        return send(202, jobView(job));
      }
    }
    return error(404, 'not_found', 'There is nothing at this address.');
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state, close: () => new Promise((done) => (server.close(done), server.closeAllConnections())) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv.includes('--serve')) {
  const fake = await startFakeApi();
  console.log(`Fake CloudBake API at ${fake.origin}. Start Claude Code with CLOUDBAKE_URL=${fake.origin} CLOUDBAKE_API_KEY=${FAKE_KEY}`);
}
