#!/usr/bin/env node
// CloudBake's MCP server for Claude Code. It renders a .blend from this computer on CloudBake's
// cloud GPUs and saves what the job made back into the project folder, and makes an MP4 of a render's frames.
//
// It speaks MCP over stdio (one JSON-RPC 2.0 message a line) and calls the public API, the same one
// https://cloudbake.ai/docs/api describes, with the user's API key. A file goes from the disk straight to
// storage through the upload's link, and frames come back the same way: the API never carries a file.
//
// Plain Node (20 or later), no packages, so a plugin install needs nothing but this file.
//
// Settings, from the environment:
//   CLOUDBAKE_PLUGIN_KEY   the key the plugin asked for at install (.mcp.json passes ${user_config.api_key})
//   CLOUDBAKE_API_KEY      used when the plugin has none: the quickstart's variable
//   CLOUDBAKE_PROJECT_DIR  what relative paths are relative to (.mcp.json passes ${CLAUDE_PROJECT_DIR})
//   CLOUDBAKE_URL          the API's address, https://cloudbake.ai unless set (for tests)
//   CLOUDBAKE_POLL_MS, CLOUDBAKE_WAIT_SECONDS   how often, and how long at most, `status` and `video` ask while they wait

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VERSION = '0.3.0';
// MCP versions this server speaks, newest first. Nothing it uses changed between them.
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILE = 4 * 1024 ** 3; // the API's limit: 4 GiB
const ENDED = new Set(['done', 'failed', 'cancelled']);
const JOB_ID = /^rq_[0-9a-f]{8,32}$/;
const UPLOAD_ID = /^up_[0-9a-f]{16}$/;
const VIDEO_ID = /^vid_[0-9a-f]{16}$/;
const KEY = /^cb_live_[0-9a-f]{40}$/;
const CONNECTIONS = 'https://cloudbake.ai/app/connections';
// The limits as the tools' descriptions say them. whoami reads the account's own from GET /v1/me.
const AT_ONCE = 3;
const FRAMES_A_JOB = '2,000';

// A value .mcp.json passes through, unless Claude Code left the placeholder in (no value was set).
function setting(name) {
  const value = (process.env[name] ?? '').trim();
  return value && !value.includes('${') ? value : '';
}

const config = {
  key: setting('CLOUDBAKE_PLUGIN_KEY') || setting('CLOUDBAKE_API_KEY'),
  origin: (setting('CLOUDBAKE_URL') || 'https://cloudbake.ai').replace(/\/+$/, ''),
  projectDir: setting('CLOUDBAKE_PROJECT_DIR') || process.cwd(),
  pollMs: Number(setting('CLOUDBAKE_POLL_MS')) || 4000,
  waitMs: (Number(setting('CLOUDBAKE_WAIT_SECONDS')) || 300) * 1000,
};

// A mistake the person or Claude can fix: said as is, as a tool error. `details` is the API's error, with the
// fields it adds (too_many_jobs: `running` and `limit`), kept for Claude to act on.
class Refusal extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const sleep = (ms, signal) =>
  new Promise((done, fail) => {
    if (signal?.aborted) return fail(signal.reason);
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), fail(signal.reason)), { once: true });
  });

const pathOf = (path) => resolve(isAbsolute(path) ? path : join(config.projectDir, path));

// ---------------------------------------------------------------------------------------------------------
// The API

// One call to /v1. A GET, a POST that carries an Idempotency-Key, or one that is safe twice (`retry`) is
// tried again when the network fails, the service is briefly away, or the rate limit says to wait: none of
// those can start a second job. too_many_jobs is a 429 too, but it is not a rate limit: a job ends in
// minutes, not seconds, so it is said at once, with the jobs to wait on.
async function api(method, path, { body, idempotencyKey, retry = false, signal, withStatus = false } = {}) {
  if (!config.key) {
    throw new Refusal(
      `No CloudBake API key is set. Make one at ${CONNECTIONS}, then give it to the plugin with /plugin configure cloudbake@cloudbake in Claude Code, and restart Claude Code (or set CLOUDBAKE_API_KEY in the shell that starts it). Never paste the key into the chat.`,
    );
  }
  if (!KEY.test(config.key)) {
    throw new Refusal(`The CloudBake API key set for the plugin does not look like one (cb_live_ and 40 hex digits). Make a new one at ${CONNECTIONS} and set it again.`);
  }
  const headers = { authorization: `Bearer ${config.key}`, accept: 'application/json', 'user-agent': `cloudbake-claude-plugin/${VERSION}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const again = method === 'GET' || Boolean(idempotencyKey) || retry;

  for (let attempt = 1; ; attempt += 1) {
    const last = !again || attempt >= 3;
    let answer;
    try {
      answer = await fetch(config.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (last) throw new Refusal(`Could not reach ${config.origin} (${error.cause?.code ?? error.message}). Check the connection and try again.`);
      await sleep(1000 * attempt, signal);
      continue;
    }
    const text = await answer.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!last && [429, 502, 503, 504].includes(answer.status) && data?.error?.code !== 'too_many_jobs') {
      const wait = Math.min(Number(answer.headers.get('retry-after')) || attempt * 2, 30);
      await sleep(wait * 1000, signal);
      continue;
    }
    if (answer.ok) return withStatus ? { status: answer.status, data } : data;
    const { code = `http_${answer.status}`, message = `CloudBake answered ${answer.status}.`, field, ...more } = data?.error ?? {};
    // What the API adds to its sentence (the jobs running, the limit) comes after it, as the answers' data does.
    // The field a refusal is about is said in the sentence, as the hosted server says it.
    const about = typeof field === 'string' ? `, in \`${field}\`` : '';
    const extra = Object.keys(more).length ? `\n\n${JSON.stringify(more, null, 2)}` : '';
    throw new Refusal(`${message} (${code}${about})${extra}`, { code, message, ...(about ? { field } : {}), ...more });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Files

// The first bytes of a .blend: "BLENDER", or the zstd or gzip header of a compressed one.
async function looksLikeBlend(path) {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(7), 0, 7, 0);
    const head = buffer.subarray(0, bytesRead);
    return head.toString('latin1') === 'BLENDER' || head.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) || head.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]));
  } finally {
    await file.close();
  }
}

async function checkBlend(path) {
  const full = pathOf(path);
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new Refusal(`There is no file at ${full}.`);
  }
  if (!info.isFile()) throw new Refusal(`${full} is a folder, not a .blend file.`);
  if (info.size === 0) throw new Refusal(`${full} is empty.`);
  if (info.size > MAX_FILE) throw new Refusal(`${full} is ${(info.size / 1024 ** 3).toFixed(1)} GiB; CloudBake takes 4 GiB at most.`);
  if (!(await looksLikeBlend(full))) throw new Refusal(`${full} is not a .blend file: it does not start the way Blender saves one.`);
  return { full, bytes: info.size };
}

// PUT a file to an upload link with its length (storage refuses a PUT without one), telling progress.
function putFile(url, path, bytes, { signal, progress }) {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(target, { method: 'PUT', headers: { 'content-length': bytes }, signal }, (answer) => {
      let text = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk) => (text += chunk));
      answer.on('end', () => {
        if (answer.statusCode >= 200 && answer.statusCode < 300) done();
        else fail(new Refusal(`Storage did not take the file (${answer.statusCode}${text ? `: ${text.slice(0, 200)}` : ''}). Try again.`));
      });
    });
    request.on('error', (error) => fail(signal?.aborted ? error : new Refusal(`The upload broke off (${error.code ?? error.message}). Try again.`)));
    const file = createReadStream(path);
    let sent = 0;
    let told = 0;
    file.on('data', (chunk) => {
      sent += chunk.length;
      if (Date.now() - told > 1000) {
        told = Date.now();
        progress(sent, bytes, `Uploading ${basename(path)}: ${Math.round((sent / bytes) * 100)}%`);
      }
    });
    file.on('error', (error) => (request.destroy(), fail(error)));
    file.pipe(request);
  });
}

async function upload(path, context) {
  const { full, bytes } = await checkBlend(path);
  const made = await api('POST', '/v1/uploads', { body: { name: basename(full).slice(0, 200), bytes }, signal: context.signal });
  await putFile(made.upload_url, full, bytes, context);
  return made.id;
}

// Save one link's file at `to`, through a temporary name, so a broken download leaves no half file.
async function saveFile(url, to, signal, again = 'try download again') {
  const answer = await fetch(url, { signal });
  if (!answer.ok || !answer.body) throw new Refusal(`Could not download ${basename(to)} (${answer.status}). The links last an hour: ${again}.`);
  const part = `${to}.part-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(answer.body), createWriteStream(part));
    await rename(part, to);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return (await stat(to)).size;
}

// ---------------------------------------------------------------------------------------------------------
// What a job says, in a sentence

function frames(job) {
  return job.kind === 'convert' ? `to ${(job.formats ?? []).join(', ')}` : `${job.frames.done} of ${job.frames.total} frames`;
}

// "39 s", "1 min 57 s", "2 min".
function gpuTime(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 60)} min`;
}

// "It cost $0.05: 39 s of GPU time, about 39 s a frame." What a test frame says about the whole job. The API
// gives `usage` for a job that has ended; an older API gives none, and nothing is said.
const usageText = ({ usage }) =>
  usage && usage.cost !== undefined && Number.isFinite(usage.gpu_seconds)
    ? ` It cost ${usage.cost}: ${gpuTime(usage.gpu_seconds)} of GPU time${usage.frames > 1 && Number.isFinite(usage.per_frame_seconds) ? `, about ${gpuTime(usage.per_frame_seconds)} a frame` : ''}.`
    : '';

function sayJob(job, { waited = false } = {}) {
  const what = `${job.id} (${job.kind} of ${job.scene})`;
  if (job.status === 'done') return `${what} is done: ${job.kind === 'convert' ? `converted ${frames(job)}` : frames(job)}.${usageText(job)} Call download to save the files.`;
  if (job.status === 'cancelled') return `${what} was cancelled: ${frames(job)} were made.${usageText(job)} download saves them.`;
  if (job.status === 'failed') {
    const fix = job.error?.you_can_fix_it === false ? 'The fault was on CloudBake\'s side, so it is not charged: start it again.' : 'Change the scene or the request, then start a new job.';
    const kept = job.kind === 'render' && job.frames.done > 0 ? ` ${frames(job)} were kept: download saves them.${usageText(job)}` : '';
    return `${what} failed: ${job.error?.message ?? 'no reason given.'} ${fix}${kept}`;
  }
  const still = waited ? ` Still ${job.status} after ${Math.round(config.waitMs / 60000)} minutes: call status with wait again.` : ' Call status with wait to follow it.';
  return `${what} is ${job.status}: ${frames(job)}.${still}`;
}

// What an MP4 says, in a sentence: as the hosted server's video tool says it, with the file saved here.

// "24", "23.976".
const fpsText = (fps) => String(Math.round(fps * 1000) / 1000);

// "2.75 s", "1 min 23.33 s".
function durationText(seconds) {
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const rest = String((hundredths - minutes * 6000) / 100);
  return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
}

// "820 KB", "312 MB", "1.2 GB", counted in 1,024s.
function sizeText(bytes) {
  if (bytes <= 0) return '0 KB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString('en-GB')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function sayVideo(video, { waited = false, saved } = {}) {
  const what = `${video.id} (an MP4 of ${video.job})`;
  const follow = `video with video: "${video.id}" and wait: true`;
  if (video.status === 'done') {
    const size = [video.width && video.height ? `${video.width}x${video.height}` : null, video.bytes !== null ? sizeText(video.bytes) : null].filter(Boolean).join(', ');
    return `${what} is ready: ${video.frames.total} frames (${video.frames.list}) at ${fpsText(video.fps)} FPS, ${durationText(video.duration_s)}${size ? `, ${size}` : ''}. Saved it as ${saved}. CloudBake keeps the MP4 14 days: call video with video: "${video.id}" to save it again.`;
  }
  if (video.status === 'failed') return `${what} failed: ${video.error?.message ?? 'no reason given.'}`;
  const doing = video.phase === 'gathering' ? 'gathering its frames' : video.status === 'queued' || video.phase === 'starting' ? 'starting' : 'encoding';
  const still = waited ? ` Still not ready after ${Math.round(config.waitMs / 60000)} minutes: call ${follow} again.` : ` Call ${follow} to follow it.`;
  return `${what} is ${doing}: ${video.frames.done} of ${video.frames.total} frames.${still}`;
}

// "Balance $5.00. No jobs running; 3 can run at once. A job renders up to 2,000 frames: put many frames in one
// job rather than many jobs." Where the account stands, from GET /v1/me, in the hosted server's words
// (lib/account.ts in the cloudbake repo). An older API leaves these fields out: what is missing is not said.
function accountSentence({ balance, running_jobs: running, limits } = {}) {
  const parts = [];
  if (typeof balance?.text === 'string') parts.push(`Balance ${balance.text}.`);
  const atOnce = limits?.jobs_at_once;
  if (Array.isArray(running)) {
    if (running.length) parts.push(`${running.length}${atOnce ? ` of ${atOnce}` : ''} job${running.length === 1 && !atOnce ? '' : 's'} running (${running.join(', ')}).`);
    else parts.push(`No jobs running${atOnce ? `; ${atOnce} can run at once` : ''}.`);
  } else if (atOnce) parts.push(`${atOnce} jobs can run at once.`);
  if (limits?.frames_per_job) parts.push(`A job renders up to ${limits.frames_per_job.toLocaleString('en-US')} frames: put many frames in one job rather than many jobs.`);
  return parts.join(' ');
}

// The sentence, then the data as JSON (for a client that reads only the text) and as structuredContent.
const result = (text, data) => ({
  content: [{ type: 'text', text: data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}` }],
  ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
});

// ---------------------------------------------------------------------------------------------------------
// The tools

const sceneFields = {
  file: { type: 'string', description: 'A .blend on this computer: a path, absolute or relative to the project folder. It is uploaded (4 GiB at most), and kept 14 days for more jobs.' },
  upload: { type: 'string', pattern: UPLOAD_ID.source, description: 'An upload id (up_…) an earlier render or convert answered: the same file again, without sending it again.' },
};

const tools = [
  {
    name: 'render',
    title: 'Render a Blender scene',
    description:
      `Render frames of a .blend on CloudBake's cloud GPUs. Give exactly one of \`file\`, \`upload\` or \`sample\`. The file is uploaded first, then the job starts and this answers at once with the job: follow it with status (wait: true), then save the frames with download. GPU time is charged to the CloudBake credit; the scene is checked on a CPU first, free, and a scene that cannot render fails there. An account runs ${AT_ONCE} jobs at once (whoami says how many are running): a job beyond that is refused at once with too_many_jobs and the ids to wait on. Put many frames in one job rather than starting many jobs.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...sceneFields,
        sample: { type: 'boolean', description: 'Render the sample scene CloudBake hosts instead (240 frames, 24 a job at most; frames 1-4 when none are named), to try it without a file.' },
        frames: { type: ['string', 'integer'], description: 'Which frames: a number ("1"), a range ("1-24") or a list ("1,5,9-12"). Needed for a file or an upload; 2,000 a job at most.' },
        samples: { type: 'integer', minimum: 1, maximum: 16384, description: 'Samples per pixel, instead of the scene\'s own.' },
        width: { type: 'integer', minimum: 1, maximum: 8192, description: 'Pixels across, instead of the scene\'s own.' },
        height: { type: 'integer', minimum: 1, maximum: 8192, description: 'Pixels down, instead of the scene\'s own. Width times height is 7680 x 4320 at most.' },
        engine: { type: 'string', enum: ['cycles', 'eevee', 'workbench'], description: 'The render engine, instead of the scene\'s own.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: render,
  },
  {
    name: 'convert',
    title: 'Convert a Blender scene',
    description: 'Convert a .blend to .glb, .fbx or .usdz on CloudBake. Runs on a CPU and is not charged. Give exactly one of `file` or `upload`. Answers at once with the job: follow it with status (wait: true), then save the files with download.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['formats'],
      properties: {
        ...sceneFields,
        formats: { type: 'array', minItems: 1, items: { type: 'string', enum: ['glb', 'fbx', 'usdz'] }, description: 'What to convert to.' },
        draco: { type: 'boolean', description: 'Compress the meshes of the .glb (Draco).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: convert,
  },
  {
    name: 'status',
    title: 'How a CloudBake job is going',
    description: `A job's status and frames done. With wait: true it waits, telling progress, until the job ends (done, failed or cancelled) or ${Math.round(config.waitMs / 60000)} minutes pass; call it again to keep waiting. A job that has ended says what it cost: its GPU time, the price, and the time a frame took, to work out what a longer job would cost.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['job'],
      properties: { job: { type: 'string', pattern: JOB_ID.source, description: 'The job id, rq_…' }, wait: { type: 'boolean', description: 'Wait for the job to end.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: status,
  },
  {
    name: 'download',
    title: 'Save what a CloudBake job made',
    description:
      'Save the files of a job that has ended into a folder: one PNG a frame for a render (or frames.zip with zip: true), the converted files for a convert. A failed or cancelled render keeps the frames it made. Files of the same name are replaced. Files are kept 14 days on CloudBake.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['job'],
      properties: {
        job: { type: 'string', pattern: JOB_ID.source, description: 'The job id, rq_…' },
        folder: { type: 'string', description: 'Where to save: a path, absolute or relative to the project folder; made if missing. Default: renders/<job id>.' },
        zip: { type: 'boolean', description: 'Render: save frames.zip, with every frame, instead of one file a frame.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: download,
  },
  {
    name: 'cancel',
    title: 'Cancel a CloudBake job',
    description: 'Stop a job. Frames already made are kept, and only the GPU time used is charged.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job'], properties: { job: { type: 'string', pattern: JOB_ID.source, description: 'The job id, rq_…' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: cancel,
  },
  {
    name: 'whoami',
    title: 'Check the CloudBake key',
    description:
      'Which CloudBake account and key the plugin uses, with where it stands: its balance, the jobs running now, and the limits (jobs at once, frames a job, file size). Call it before starting several jobs, and when something says the key does not work.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: whoami,
  },
  {
    name: 'video',
    title: 'Make an MP4 of a CloudBake render',
    description: [
      "Make an MP4 (H.264) of a finished render's frames, on CloudBake's side: nothing renders again, and it is free while CloudBake is in beta. The render has ended with at least 2 frames, in the last 14 days.",
      'Every frame by default; `frames` picks some ("1-24, 31-72") and `leave_out` cuts some ("25-30"), with nothing in their place. Only frames the render made may be named. The frame rate is the scene\'s unless `fps` is given.',
      `With wait: true it waits until the MP4 is ready (usually within a minute, ${Math.round(config.waitMs / 60000)} minutes a call at most); once it is ready, it is saved as renders/<job id>/<vid>.mp4, or in \`folder\`. Give \`video\` (vid_…) instead of the frames to follow one already started, or to save it again. One MP4 of a render at a time, three of an account at once.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['job'],
      properties: {
        job: { type: 'string', pattern: JOB_ID.source, description: 'The render, rq_…' },
        frames: { type: ['string', 'integer'], description: 'The frames to use: a list like "1-24, 31-72", or a frame number. Left out: every frame the render made.' },
        leave_out: { type: ['string', 'integer'], description: 'Frames to cut from those, like "25-30": cut, with no pause in their place.' },
        fps: { type: ['number', 'string'], description: "Frames a second, 1 to 120, like 24 or 23.976. Left out: the scene's own, or 24 when the job does not say." },
        video: { type: 'string', pattern: VIDEO_ID.source, description: 'An MP4 already started (vid_…), to follow it or save it again, instead of making another.' },
        wait: { type: 'boolean', description: 'Wait for the MP4 to be ready.' },
        folder: { type: 'string', description: 'Where to save the MP4: a path, absolute or relative to the project folder; made if missing. Default: renders/<job id>.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: video,
  },
];

// The scene of a job: an upload of this computer's file, an earlier upload, or the sample.
async function sceneOf(args, context, { sampleAllowed }) {
  const given = ['file', 'upload', ...(sampleAllowed ? ['sample'] : [])].filter((name) => args[name] !== undefined && args[name] !== false && args[name] !== '');
  if (given.length !== 1) throw new Refusal(`Give exactly one of ${sampleAllowed ? '`file`, `upload` or `sample`' : '`file` or `upload`'}.`);
  if (args.sample) return { scene: 'sample' };
  if (args.upload) {
    if (!UPLOAD_ID.test(args.upload)) throw new Refusal('`upload` is an upload id like up_0123456789abcdef.');
    return { upload: args.upload };
  }
  return { upload: await upload(args.file, context) };
}

async function render(args, context) {
  // Checked before the file is sent.
  if (!args.sample && args.frames === undefined) throw new Refusal('Say which frames to render: "1", "1-24" or "1,5,9-12".');
  const body = await sceneOf(args, context, { sampleAllowed: true });
  for (const name of ['frames', 'samples', 'width', 'height', 'engine']) if (args[name] !== undefined) body[name] = args[name];
  const job = await api('POST', '/v1/jobs', { body, idempotencyKey: randomUUID(), signal: context.signal });
  return result(`Started ${job.id}: ${job.frames.total} frame${job.frames.total === 1 ? '' : 's'} of ${job.scene}${body.upload ? ` (upload ${body.upload}; pass it as \`upload\` to use the same file again)` : ''}. Follow it with status (wait: true).`, job);
}

async function convert(args, context) {
  const body = { ...(await sceneOf(args, context, { sampleAllowed: false })), kind: 'convert', formats: args.formats };
  if (args.draco !== undefined) body.draco = args.draco;
  const job = await api('POST', '/v1/jobs', { body, idempotencyKey: randomUUID(), signal: context.signal });
  return result(`Started ${job.id}: converting ${job.scene} to ${(job.formats ?? args.formats).join(', ')} (upload ${body.upload}). Follow it with status (wait: true).`, job);
}

async function status({ job: id, wait = false }, context) {
  if (!JOB_ID.test(id ?? '')) throw new Refusal('`job` is a job id like rq_0123456789abcdef.');
  let job = await api('GET', `/v1/jobs/${id}`, { signal: context.signal });
  if (wait) {
    const until = Date.now() + config.waitMs;
    while (!ENDED.has(job.status) && Date.now() < until) {
      context.progress(job.frames.done, job.frames.total || undefined, `${job.status}: ${frames(job)}`);
      await sleep(config.pollMs, context.signal);
      job = await api('GET', `/v1/jobs/${id}`, { signal: context.signal });
    }
  }
  return result(sayJob(job, { waited: wait }), job);
}

async function download({ job: id, folder, zip = false }, context) {
  if (!JOB_ID.test(id ?? '')) throw new Refusal('`job` is a job id like rq_0123456789abcdef.');
  const answer = await api('GET', `/v1/jobs/${id}/files`, { signal: context.signal });
  if (!ENDED.has(answer.job.status)) return result(`${id} has not ended yet (${answer.job.status}, ${frames(answer.job)}): its files are listed once it has. Call status with wait first.`);
  let files = answer.files;
  if (answer.job.kind === 'render') files = files.filter((file) => (file.name === 'frames.zip') === zip);
  if (files.length === 0) return result(`${id} ended (${answer.job.status}) with no files to save.`);
  const into = pathOf(folder || join('renders', id));
  await mkdir(into, { recursive: true });
  const saved = [];
  for (const [index, file] of files.entries()) {
    const name = basename(file.name);
    if (!name || name === '.' || name === '..') continue;
    context.progress(index, files.length, `Downloading ${name}`);
    const to = join(into, name);
    saved.push({ path: to, frame: file.frame, bytes: await saveFile(file.url, to, context.signal) });
  }
  const list = saved.map((file) => `- ${file.path}`).join('\n');
  return result(`Saved ${saved.length} file${saved.length === 1 ? '' : 's'} of ${id} (${answer.job.status}) in ${into}:\n${list}`);
}

async function cancel({ job: id }, context) {
  if (!JOB_ID.test(id ?? '')) throw new Refusal('`job` is a job id like rq_0123456789abcdef.');
  // 202: the cancel was asked for. 200: the job had ended already.
  const { status: asked, data: job } = await api('POST', `/v1/jobs/${id}/cancel`, { retry: true, signal: context.signal, withStatus: true });
  return result(asked === 200 ? `${id} had ended already (${job.status}): nothing changed.` : `Asked CloudBake to cancel ${id}. Frames already made are kept; status says cancelled once no frame of it is on a GPU.`, job);
}

const VIDEO_FIELDS = ['frames', 'leave_out', 'fps'];
const VIDEO_ACTIVE = new Set(['queued', 'encoding']);
// job id → the MP4 of it this server started last. The API's refusal of a second start does not name the one
// being made, so this is how the refusal points at it.
const videosStarted = new Map();

// The refusal of a second MP4 of a job, pointing at the one being made when this server started it.
async function videoRunning(error, id, signal) {
  const started = videosStarted.get(id);
  let running = null;
  if (started) {
    try {
      const made = await api('GET', `/v1/jobs/${id}/videos/${started}`, { signal });
      if (VIDEO_ACTIVE.has(made.status)) running = made.id;
    } catch {}
  }
  const more = running ? `It is ${running}: call video with video: "${running}" and wait: true to follow it.` : `Its card on ${config.origin}/app/requests shows how it goes.`;
  return new Refusal(`${error.details.message} ${more} (${error.details.code})`, error.details);
}

async function video(args, context) {
  const id = args.job;
  if (!JOB_ID.test(id ?? '')) throw new Refusal('`job` is a job id like rq_0123456789abcdef.');
  let made;
  if (args.video !== undefined) {
    if (typeof args.video !== 'string' || !VIDEO_ID.test(args.video)) throw new Refusal('`video` is an MP4 id like vid_0123456789abcdef, as an earlier call of video answered it.');
    if (VIDEO_FIELDS.some((name) => args[name] !== undefined)) throw new Refusal('Give `video` to follow an MP4 already started, or `frames`, `leave_out` and `fps` to make a new one: not both.');
    made = await api('GET', `/v1/jobs/${id}/videos/${args.video}`, { signal: context.signal });
  } else {
    const body = Object.fromEntries(VIDEO_FIELDS.filter((name) => args[name] !== undefined).map((name) => [name, args[name]]));
    try {
      // Not tried again when the network fails: a second start would be refused as running, with no id.
      made = await api('POST', `/v1/jobs/${id}/videos`, { body, signal: context.signal });
    } catch (error) {
      throw error instanceof Refusal && error.details?.code === 'video_running' ? await videoRunning(error, id, context.signal) : error;
    }
    videosStarted.set(id, made.id);
  }
  if (args.wait === true) {
    const until = Date.now() + config.waitMs;
    while (VIDEO_ACTIVE.has(made.status) && Date.now() < until) {
      context.progress(made.frames.done, made.frames.total || undefined, `${made.phase ?? made.status}: ${made.frames.done} of ${made.frames.total} frames`);
      await sleep(config.pollMs, context.signal);
      made = await api('GET', `/v1/jobs/${id}/videos/${made.id}`, { signal: context.signal });
    }
  }
  if (made.status !== 'done') return result(sayVideo(made, { waited: args.wait === true }), made);
  const again = `call video with video: "${made.id}" to save it again`;
  if (!made.url) return result(`${made.id} (an MP4 of ${made.job}) is ready, but CloudBake answered no link to it: ${again} in a moment.`, made);

  const into = pathOf(args.folder || join('renders', id));
  await mkdir(into, { recursive: true });
  const to = join(into, `${made.id}.mp4`);
  context.progress(made.frames.done, made.frames.total || undefined, `Downloading ${made.id}.mp4`);
  const bytes = await saveFile(made.url, to, context.signal, again);
  if (typeof made.bytes === 'number' && bytes !== made.bytes) {
    await rm(to, { force: true });
    throw new Refusal(`${made.id}.mp4 arrived with ${bytes} of its ${made.bytes} bytes, so it was not kept: ${again}.`);
  }
  return result(sayVideo(made, { saved: to }), { ...made, file: to });
}

async function whoami(_args, context) {
  const me = await api('GET', '/v1/me', { signal: context.signal });
  const now = accountSentence(me);
  return result(`The plugin uses the key "${me.key.name}" (ending ${me.key.last_four}) of ${me.email}'s CloudBake account at ${config.origin}.${now ? `\n${now}` : ''}`, me);
}

// ---------------------------------------------------------------------------------------------------------
// MCP over stdio

const INSTRUCTIONS = [
  'CloudBake renders Blender scenes on cloud GPUs and converts them to .glb, .fbx or .usdz.',
  'A render: render (file and frames) answers at once with a job id; status with wait: true follows it until it ends; download saves the frames into the project, and video (wait: true) makes an MP4 of them, free.',
  "GPU time is charged to the person's CloudBake credit: before rendering more than a few frames, render one test frame, show it, and say how many frames the full job is and what it would cost (status gives the test frame's cost and seconds).",
  `An account runs ${AT_ONCE} jobs at once; whoami gives the exact limits, the balance and the jobs running now. Render many frames as one job (up to ${FRAMES_A_JOB} frames), not as many jobs: a job beyond the limit is refused, not queued.`,
].join(' ');

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const running = new Map(); // request id → AbortController, for notifications/cancelled

async function call(params, id) {
  const tool = tools.find((candidate) => candidate.name === params?.name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
  const controller = new AbortController();
  running.set(id, controller);
  const token = params._meta?.progressToken;
  const context = {
    signal: controller.signal,
    progress: (progress, total, message) => {
      if (token !== undefined) write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, ...(total ? { total } : {}), message } });
    },
  };
  try {
    return { result: await tool.run(params.arguments ?? {}, context) };
  } catch (error) {
    if (controller.signal.aborted) return null;
    const text = error instanceof Refusal ? error.message : `Something went wrong in the CloudBake plugin: ${error.message}`;
    if (!(error instanceof Refusal)) console.error(error);
    return { result: { content: [{ type: 'text', text }], ...(error.details ? { structuredContent: { error: error.details } } : {}), isError: true } };
  } finally {
    running.delete(id);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) {
    if (method === 'notifications/cancelled') running.get(params?.requestId)?.abort('cancelled');
    return;
  }
  let answer;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    answer = {
      result: {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cloudbake', title: 'CloudBake', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    };
  } else if (method === 'ping') answer = { result: {} };
  else if (method === 'tools/list') answer = { result: { tools: tools.map(({ run, ...tool }) => tool) } };
  else if (method === 'tools/call') answer = await call(params, id);
  else answer = { error: { code: -32601, message: `Method not found: ${method}` } };
  if (answer) write({ jsonrpc: '2.0', id, ...answer });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(message).catch((error) => console.error(error));
});
process.stdin.on('end', () => process.exit(0));
