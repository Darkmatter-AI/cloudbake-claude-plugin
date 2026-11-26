// The plugin's MCP server, run as Claude Code runs it (a child process on stdio), against the fake API.
// Run: node --test claude-plugin/test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FAKE_KEY, MP4, PNG, startFakeApi } from './fake-api.mjs';

const SERVER = new URL('../server/cloudbake-mcp.mjs', import.meta.url).pathname;
const BLEND = Buffer.concat([Buffer.from('BLENDER-v405REND'), Buffer.alloc(4096, 7)]);

let fake;
let project;
let noConfig; // an empty config folder, so a key saved on this computer is never read by the tests

before(async () => {
  // The tests share this fake and leave jobs running, so its jobs-at-once limit is out of the way; the tests
  // of the limit start a fake of their own (limitedApi).
  fake = await startFakeApi({ jobsAtOnce: 1000 });
  project = await mkdtemp(join(tmpdir(), 'cloudbake-plugin-'));
  noConfig = await mkdtemp(join(tmpdir(), 'cloudbake-config-'));
  await writeFile(join(project, 'scene.blend'), BLEND);
  await writeFile(join(project, 'broken.blend'), BLEND);
  await writeFile(join(project, 'flaky.blend'), BLEND);
  await writeFile(join(project, 'notes.txt'), 'not a scene');
});
const children = new Set();
after(async () => {
  for (const child of children) child.kill();
  await fake.close();
  await rm(project, { recursive: true, force: true });
  await rm(noConfig, { recursive: true, force: true });
});

// Start the server with these settings; talk to it as an MCP client.
function connect(env = {}, { cwd } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: noConfig, CLOUDBAKE_URL: fake.origin, CLOUDBAKE_PROJECT_DIR: project, CLOUDBAKE_POLL_MS: '5', CLOUDBAKE_WAIT_SECONDS: '5', CLOUDBAKE_API_KEY: FAKE_KEY, ...env },
    ...(cwd ? { cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const waiting = new Map();
  const notes = [];
  const out = [];
  let err = '';
  child.stderr.on('data', (chunk) => (err += chunk));
  createInterface({ input: child.stdout }).on('line', (line) => {
    out.push(line);
    const message = JSON.parse(line);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else notes.push(message);
  });
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const ask = (method, params) => {
    const id = next++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((done) => waiting.set(id, done));
  };
  const tool = async (name, args = {}, meta) => {
    const answer = await ask('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.ok(answer.result, `tools/call ${name} answered ${JSON.stringify(answer)}`);
    return { ...answer.result, text: answer.result.content.map((part) => part.text).join('\n') };
  };
  return {
    ask,
    send,
    tool,
    notes,
    output: () => out.join('\n') + err,
    close: () => (child.stdin.end(), new Promise((done) => child.on('exit', done))),
  };
}

const jobOf = (text) => JSON.parse(text.slice(text.indexOf('\n\n') + 2));

test('initialize answers the protocol the client asked for, and lists seven tools with schemas', async () => {
  const mcp = connect();
  const init = await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'cloudbake');
  assert.match(init.result.instructions, /one test frame/);
  assert.match(init.result.instructions, /video \(wait: true\) makes an MP4 of them, free/);
  const newer = await mcp.ask('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(newer.result.protocolVersion, '2025-11-25');
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await mcp.ask('tools/list', {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['render', 'convert', 'status', 'download', 'cancel', 'whoami', 'video']);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description && tool.title && tool.annotations, tool.name);
    assert.equal(tool.run, undefined);
  }
  assert.deepEqual((await mcp.ask('ping', {})).result, {});
  assert.equal((await mcp.ask('resources/list', {})).error.code, -32601);
  assert.equal((await mcp.ask('tools/call', { name: 'bake', arguments: {} })).error.code, -32602);
  await mcp.close();
});

test('the instructions and the descriptions say the limits, one job for many frames, and the cost of a test frame', async () => {
  const mcp = connect();
  const { instructions } = (await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  assert.match(instructions, /An account runs 3 jobs at once; whoami gives the exact limits, the balance and the jobs running now\./);
  assert.match(instructions, /Render many frames as one job \(up to 2,000 frames\), not as many jobs: a job beyond the limit is refused, not queued\./);
  assert.match(instructions, /say how many frames the full job is and what it would cost \(status gives the test frame's cost and seconds\)/);
  const tools = Object.fromEntries((await mcp.ask('tools/list', {})).result.tools.map((tool) => [tool.name, tool.description]));
  assert.match(tools.render, /An account runs 3 jobs at once \(whoami says how many are running\): a job beyond that is refused at once with too_many_jobs and the ids to wait on\. Put many frames in one job/);
  assert.match(tools.whoami, /its balance, the jobs running now, and the limits \(jobs at once, frames a job, file size\)\. Call it before starting several jobs/);
  assert.match(tools.status, /says what it cost/);
  await mcp.close();
});

// A fake with the real limit (3 jobs at once), so the tests of it start from no jobs running.
async function limitedApi() {
  const api = await startFakeApi();
  return { api, mcp: connect({ CLOUDBAKE_URL: api.origin }), close: async (mcp) => (await mcp.close(), await api.close()) };
}

test('whoami names the account and the key, and says the balance, the jobs running and the limits', async () => {
  const { api, mcp, close } = await limitedApi();
  let answer = await mcp.tool('whoami');
  assert.equal(answer.isError, undefined);
  assert.match(answer.text, /"Claude Code" \(ending 4567\) of ana@studio.com/);
  assert.match(answer.text, /\nBalance \$5\.00\. No jobs running; 3 can run at once\. A job renders up to 2,000 frames: put many frames in one job rather than many jobs\./);
  assert.deepEqual(answer.structuredContent.limits, { jobs_at_once: 3, frames_per_job: 2000, upload_bytes: 4 * 1024 ** 3 });
  assert.deepEqual(answer.structuredContent.balance, { cents: 500, text: '$5.00' });
  assert.deepEqual(answer.structuredContent.running_jobs, []);
  assert.deepEqual(jobOf(answer.text), answer.structuredContent, 'the same data in the text, for a client that reads only that');

  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-4' })).text);
  answer = await mcp.tool('whoami');
  assert.match(answer.text, new RegExp(`Balance \\$5\\.00\\. 1 of 3 jobs running \\(${job.id}\\)\\. A job renders up to 2,000 frames`));
  assert.deepEqual(answer.structuredContent.running_jobs, [job.id]);
  assert.equal(api.state.calls.filter((call) => call.path === '/v1/me').length, 2);
  await close(mcp);
});

test('whoami still works with an API that does not say the balance, the jobs or the limits', async () => {
  const mcp = connect();
  fake.state.oldMe = true;
  const answer = await mcp.tool('whoami');
  fake.state.oldMe = false;
  assert.equal(answer.isError, undefined, answer.text);
  assert.match(answer.text, /^The plugin uses the key "Claude Code" \(ending 4567\) of ana@studio\.com's CloudBake account at http:\/\/127\.0\.0\.1:\d+\.\n\n\{/);
  assert.doesNotMatch(answer.text, /Balance|running|at once|undefined/);
  assert.deepEqual(answer.structuredContent, { email: 'ana@studio.com', key: { name: 'Claude Code', last_four: '4567' } });
  await mcp.close();
});

test('a job that has ended says what it cost: done, cancelled, and failed with frames kept', async () => {
  const mcp = connect();
  // Three frames: the cost, the GPU time and the time a frame took.
  let job = jobOf((await mcp.tool('render', { file: 'scene.blend', frames: '1-3' })).text);
  let answer = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(answer.text, /is done: 3 of 3 frames\. It cost \$0\.15: 1 min 57 s of GPU time, about 39 s a frame\. Call download to save the files\./);
  assert.deepEqual(answer.structuredContent.usage, { frames: 3, gpu_seconds: 117, cost_cents: 15, cost: '$0.15', per_frame_seconds: 39 });

  // One test frame: its cost and seconds, with no "a frame" to repeat.
  job = jobOf((await mcp.tool('render', { upload: job.upload, frames: 1 })).text);
  answer = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(answer.text, /is done: 1 of 1 frames\. It cost \$0\.05: 39 s of GPU time\. Call download/);

  // Cancelled after two frames: what those cost.
  job = jobOf((await mcp.tool('render', { sample: true, frames: '1-24' })).text);
  for (let ask = 0; ask < 5; ask += 1) answer = await mcp.tool('status', { job: job.id }); // checking, rendering 0, 1, 2, 3
  assert.match(answer.text, /is rendering: 3 of 24 frames\. Call status with wait/);
  assert.doesNotMatch(answer.text, /cost/, 'a job still going says no cost');
  await mcp.tool('cancel', { job: job.id });
  answer = await mcp.tool('status', { job: job.id });
  assert.match(answer.text, /was cancelled: 3 of 24 frames were made\. It cost \$0\.15: 1 min 57 s of GPU time, about 39 s a frame\. download saves them\./);

  // Failed after a frame, on CloudBake's side: the frame kept, and what it cost.
  job = jobOf((await mcp.tool('render', { file: 'flaky.blend', frames: '1-3' })).text);
  answer = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(answer.text, /failed: The GPU stopped answering\. The fault was on CloudBake's side, so it is not charged: start it again\. 1 of 3 frames were kept: download saves them\. It cost \$0\.05: 39 s of GPU time\./);

  // A failure before any frame, and a convert, have no usage: nothing is said.
  job = jobOf((await mcp.tool('render', { file: 'broken.blend', frames: 1 })).text);
  assert.doesNotMatch((await mcp.tool('status', { job: job.id, wait: true })).text, /cost/);
  job = jobOf((await mcp.tool('convert', { upload: job.upload, formats: ['glb'] })).text);
  assert.doesNotMatch((await mcp.tool('status', { job: job.id, wait: true })).text, /cost/);
  await mcp.close();
});

test('a job beyond the jobs-at-once limit is refused at once with the jobs running and the limit, and not tried again', async () => {
  const { api, mcp, close } = await limitedApi();
  const ids = [];
  for (let start = 0; start < 3; start += 1) ids.push(jobOf((await mcp.tool('render', { sample: true, frames: '1-4' })).text).id);
  const posts = () => api.state.calls.filter((call) => call.method === 'POST' && call.path === '/v1/jobs').length;
  const before = posts();
  const started = Date.now();

  const refused = await mcp.tool('render', { sample: true, frames: '1-4' });
  assert.equal(refused.isError, true);
  assert.equal(posts(), before + 1, 'asked once: too_many_jobs is not a rate limit to wait out');
  assert.ok(Date.now() - started < 900, 'answered without waiting');
  assert.match(refused.text, new RegExp(`^This account already has 3 jobs running \\(${ids.join(', ')}\\), and 3 run at once\\..* \\(too_many_jobs\\)`));
  assert.deepEqual(refused.structuredContent.error.running, ids);
  assert.equal(refused.structuredContent.error.limit, 3);
  assert.equal(refused.structuredContent.error.code, 'too_many_jobs');
  assert.deepEqual(jobOf(refused.text), { running: ids, limit: 3 }, 'and in the text, for a client that reads only that');

  // A convert is a job too. The file is sent, then the job is refused the same way.
  const convert = await mcp.tool('convert', { file: 'scene.blend', formats: ['glb'] });
  assert.equal(convert.isError, true);
  assert.deepEqual(convert.structuredContent.error.running, ids);

  // Once a job ends there is room; a real rate limit is still waited out and tried again.
  await mcp.tool('cancel', { job: ids[0] });
  api.state.rateLimitOnce = true;
  const after = posts();
  const again = await mcp.tool('render', { sample: true, frames: '1-4' });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(posts(), after + 2, 'rate_limited, then started');
  await close(mcp);
});

test('render a file: it is sent whole, the job starts on it, status follows it to done, download saves the frames', async () => {
  const mcp = connect();
  const puts = fake.state.puts.length;
  const started = await mcp.tool('render', { file: 'scene.blend', frames: '1-3', samples: 16 });
  assert.equal(started.isError, undefined, started.text);
  const job = jobOf(started.text);
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.frames, { total: 3, done: 0 });
  assert.match(started.text, /upload up_[0-9a-f]{16}/);

  const put = fake.state.puts.at(-1);
  assert.equal(fake.state.puts.length, puts + 1);
  assert.equal(put.bytes, BLEND.length);
  assert.equal(put.head, 'BLENDER');
  const created = fake.state.calls.findLast((call) => call.path === '/v1/jobs');
  assert.deepEqual(created.body, { upload: job.upload, frames: '1-3', samples: 16 });
  assert.match(created.idempotencyKey, /^[0-9a-f-]{36}$/);
  const uploaded = fake.state.calls.findLast((call) => call.path === '/v1/uploads');
  assert.deepEqual(uploaded.body, { name: 'scene.blend', bytes: BLEND.length });

  const early = await mcp.tool('download', { job: job.id });
  assert.match(early.text, /has not ended yet/);

  const followed = await mcp.tool('status', { job: job.id, wait: true }, { progressToken: 'p1' });
  assert.match(followed.text, /is done: 3 of 3 frames/);
  assert.ok(mcp.notes.some((note) => note.method === 'notifications/progress' && note.params.progressToken === 'p1'), 'progress was told');

  const saved = await mcp.tool('download', { job: job.id, folder: 'out/frames' });
  assert.match(saved.text, /Saved 3 files/);
  const names = (await readdir(join(project, 'out/frames'))).sort();
  assert.deepEqual(names, ['frame_00001.png', 'frame_00002.png', 'frame_00003.png']);
  assert.deepEqual(await readFile(join(project, 'out/frames/frame_00002.png')), PNG);

  const zipped = await mcp.tool('download', { job: job.id, zip: true });
  assert.match(zipped.text, /Saved 1 file of/);
  assert.deepEqual(await readdir(join(project, 'renders', job.id)), ['frames.zip']);

  // The same file again, by its upload, sends nothing.
  const again = await mcp.tool('render', { upload: job.upload, frames: 7 });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(fake.state.puts.length, puts + 1);
  await mcp.close();
});

test('render refuses, before sending anything, what cannot be right', async () => {
  const mcp = connect();
  const puts = fake.state.puts.length;
  const calls = fake.state.calls.length;
  const cases = [
    [{ file: 'scene.blend' }, /Say which frames/],
    [{ file: 'missing.blend', frames: 1 }, /There is no file at .*missing\.blend/],
    [{ file: 'notes.txt', frames: 1 }, /is not a \.blend file/],
    [{ file: '.', frames: 1 }, /is a folder/],
    [{ file: 'scene.blend', sample: true, frames: 1 }, /exactly one of/],
    [{ frames: 1 }, /exactly one of/],
    [{ upload: 'up_nope', frames: 1 }, /upload id like/],
  ];
  for (const [args, said] of cases) {
    const answer = await mcp.tool('render', args);
    assert.equal(answer.isError, true, JSON.stringify(args));
    assert.match(answer.text, said);
  }
  assert.equal((await mcp.tool('status', { job: 'nope' })).isError, true);
  assert.equal(fake.state.puts.length, puts);
  assert.equal(fake.state.calls.length, calls);
  await mcp.close();
});

test('the sample renders without a file', async () => {
  const mcp = connect();
  const started = await mcp.tool('render', { sample: true });
  const job = jobOf(started.text);
  assert.equal(job.scene, 'sample');
  assert.deepEqual(fake.state.calls.findLast((call) => call.path === '/v1/jobs').body, { scene: 'sample' });
  await mcp.close();
});

test('a job that fails says why and what to do; the API\'s refusals come through as they are', async () => {
  const mcp = connect();
  const started = await mcp.tool('render', { file: 'broken.blend', frames: 1 });
  const job = jobOf(started.text);
  const ended = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(ended.text, /failed: The scene has no camera\. Add one .* Change the scene or the request/);

  fake.state.outOfCredit = true;
  const refused = await mcp.tool('render', { sample: true, frames: '1-2' });
  fake.state.outOfCredit = false;
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Your balance is \$0\.00.*\(out_of_credit\)/);

  const unknown = await mcp.tool('status', { job: 'rq_00000000deadbeef' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /job_not_found/);
  await mcp.close();
});

test('convert, then download the converted files', async () => {
  const mcp = connect();
  const started = await mcp.tool('convert', { file: 'scene.blend', formats: ['glb', 'usdz'], draco: true });
  const job = jobOf(started.text);
  assert.deepEqual(fake.state.calls.findLast((call) => call.path === '/v1/jobs').body, { upload: job.upload, kind: 'convert', formats: ['glb', 'usdz'], draco: true });
  assert.match((await mcp.tool('status', { job: job.id, wait: true })).text, /is done: converted to glb, usdz/);
  const saved = await mcp.tool('download', { job: job.id, folder: join(project, 'models') });
  assert.match(saved.text, /Saved 2 files/);
  assert.deepEqual((await readdir(join(project, 'models'))).sort(), ['scene.glb', 'scene.usdz']);
  await mcp.close();
});

test('cancel stops a job, and says so when it had ended', async () => {
  const mcp = connect();
  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-24' })).text);
  assert.match((await mcp.tool('cancel', { job: job.id })).text, /Asked CloudBake to cancel/);
  assert.match((await mcp.tool('cancel', { job: job.id })).text, /had ended already \(cancelled\)/);
  await mcp.close();
});

test('a job still going after the wait says to call again', async () => {
  const mcp = connect({ CLOUDBAKE_WAIT_SECONDS: '0.05', CLOUDBAKE_POLL_MS: '20' });
  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-24' })).text);
  const answer = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(answer.text, /Still (checking|rendering) after .* call status with wait again/);
  await mcp.close();
});

test('the key: the plugin\'s comes first, the shell\'s is used when the plugin has none, and none is ever printed', async () => {
  const calls = fake.state.calls.length;
  // No key anywhere: a sentence that says where to make one, and nothing is sent.
  let mcp = connect({ CLOUDBAKE_API_KEY: '' });
  let answer = await mcp.tool('whoami');
  assert.equal(answer.isError, true);
  assert.match(answer.text, /No CloudBake API key is set\. Make one at https:\/\/cloudbake\.ai\/app\/connections.*\/plugin configure cloudbake@cloudbake/);
  await mcp.close();
  assert.equal(fake.state.calls.length, calls);

  // The placeholder Claude Code leaves when the plugin's key is unset: the shell's key is used.
  mcp = connect({ CLOUDBAKE_PLUGIN_KEY: '${user_config.api_key}' });
  assert.equal((await mcp.tool('whoami')).isError, undefined);
  await mcp.close();

  // The plugin's key wins over the shell's.
  mcp = connect({ CLOUDBAKE_PLUGIN_KEY: FAKE_KEY, CLOUDBAKE_API_KEY: `cb_live_${'f'.repeat(40)}` });
  assert.equal((await mcp.tool('whoami')).isError, undefined);
  assert.equal(fake.state.calls.at(-1).auth, `Bearer ${FAKE_KEY}`);
  await mcp.tool('render', { file: 'scene.blend', frames: 1 });
  const output = mcp.output();
  await mcp.close();
  assert.ok(!output.includes(FAKE_KEY.slice(8)), 'the key is never in what the server writes');

  // A key of the wrong shape is refused before it is sent.
  mcp = connect({ CLOUDBAKE_API_KEY: 'sk-not-ours' });
  answer = await mcp.tool('whoami');
  assert.match(answer.text, /does not look like one/);
  assert.ok(!mcp.output().includes('sk-not-ours'));
  await mcp.close();

  // A wrong key: the API's 401 sentence.
  mcp = connect({ CLOUDBAKE_API_KEY: `cb_live_${'a'.repeat(40)}` });
  answer = await mcp.tool('whoami');
  assert.match(answer.text, /This API key does not work.*\(api_key_invalid\)/);
  assert.ok(!mcp.output().includes('a'.repeat(40)));
  await mcp.close();
});

// A render of the sample's frames 1-8, followed to done: what an MP4 is made of.
async function finishedRender(mcp) {
  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-8' })).text);
  assert.match((await mcp.tool('status', { job: job.id, wait: true })).text, /is done: 8 of 8 frames/);
  return job;
}
const videoOf = (text) => JSON.parse(text.slice(text.indexOf('\n\n') + 2));

test('video makes an MP4 of a finished render, waits for it, and saves it into renders/<job id>', async () => {
  const mcp = connect();
  const going = jobOf((await mcp.tool('render', { sample: true, frames: '1-8' })).text);
  const early = await mcp.tool('video', { job: going.id });
  assert.equal(early.isError, true);
  assert.match(early.text, /An MP4 is made of a finished render with at least 2 frames\. \(no_video\)/);

  const job = await finishedRender(mcp);
  const answer = await mcp.tool('video', { job: job.id, leave_out: '3-4', wait: true }, { progressToken: 'v1' });
  assert.equal(answer.isError, undefined, answer.text);
  const made = videoOf(answer.text);
  assert.match(made.id, /^vid_[0-9a-f]{16}$/);
  const file = join(project, 'renders', job.id, `${made.id}.mp4`);
  assert.equal(
    answer.text.split('\n\n')[0],
    `${made.id} (an MP4 of ${job.id}) is ready: 6 frames (1-2, 5-8) at 24 FPS, 0.25 s, 2x2, 1 KB. Saved it as ${file}. CloudBake keeps the MP4 14 days: call video with video: "${made.id}" to save it again.`,
  );
  assert.deepEqual(made.frames, { total: 6, done: 6, list: '1-2, 5-8' });
  assert.equal(made.file, file);
  assert.deepEqual(await readFile(file), MP4);
  assert.deepEqual(fake.state.calls.findLast((call) => call.method === 'POST' && call.path.endsWith('/videos')).body, { leave_out: '3-4' });
  assert.ok(mcp.notes.some((note) => note.method === 'notifications/progress' && note.params.progressToken === 'v1' && /gathering|encoding/.test(note.params.message)), 'progress was told');
  await mcp.close();
});

test('video: a refusal of the API says its code and its field; its own refusals send nothing', async () => {
  const mcp = connect();
  const job = await finishedRender(mcp);
  const outside = await mcp.tool('video', { job: job.id, frames: '7-12' });
  assert.equal(outside.isError, true);
  assert.equal(outside.text, 'Frames 9-12 are not in this render. It has frames 1-8. (bad_frames, in `frames`)');
  const cut = await mcp.tool('video', { job: job.id, leave_out: 'twenty' });
  assert.match(cut.text, /is not a frame number .*\(bad_frames, in `leave_out`\)/);
  const fast = await mcp.tool('video', { job: job.id, fps: 500 });
  assert.match(fast.text, /from 1 to 120.*\(bad_fps, in `fps`\)/);

  const calls = fake.state.calls.length;
  const cases = [
    [{ job: 'nope' }, /`job` is a job id like/],
    [{ job: job.id, video: 'vid_nope' }, /`video` is an MP4 id like/],
    [{ job: job.id, video: 'vid_0123456789abcdef', frames: '1-2' }, /not both/],
  ];
  for (const [args, said] of cases) {
    const answer = await mcp.tool('video', args);
    assert.equal(answer.isError, true, JSON.stringify(args));
    assert.match(answer.text, said);
  }
  assert.equal(fake.state.calls.length, calls);
  await mcp.close();
});

test('video: following one already started, and a second start points at it', async () => {
  const mcp = connect();
  const job = await finishedRender(mcp);
  fake.state.holdVideos = true; // queued until let go
  const started = await mcp.tool('video', { job: job.id, fps: 12 });
  const made = videoOf(started.text);
  assert.equal(made.status, 'queued');
  assert.equal(started.text.split('\n\n')[0], `${made.id} (an MP4 of ${job.id}) is starting: 0 of 8 frames. Call video with video: "${made.id}" and wait: true to follow it.`);
  assert.deepEqual(fake.state.calls.findLast((call) => call.method === 'POST' && call.path.endsWith('/videos')).body, { fps: 12 });

  const pointed = `An MP4 of this render is being made. Make the next one when it is ready. It is ${made.id}: call video with video: "${made.id}" and wait: true to follow it. (video_running)`;
  const again = await mcp.tool('video', { job: job.id });
  assert.equal(again.isError, true);
  assert.equal(again.text, pointed);
  assert.equal(again.structuredContent.error.video, made.id);

  // The API names the one being made, so a server that did not start it (a new session) points at it too.
  const other = connect();
  assert.equal((await other.tool('video', { job: job.id })).text, pointed);
  // An answer without the name (the API before it gave one): the job's card instead.
  fake.state.oldVideoRunning = true;
  const old = await other.tool('video', { job: job.id });
  fake.state.oldVideoRunning = false;
  assert.match(old.text, /being made\. .*Its card on http:\/\/127\.0\.0\.1:\d+\/app\/requests shows how it goes\. \(video_running\)$/);
  await other.close();

  // A wait shorter than the export: it says to call again.
  const hurried = connect({ CLOUDBAKE_WAIT_SECONDS: '0.05', CLOUDBAKE_POLL_MS: '100' });
  const short = await hurried.tool('video', { job: job.id, video: made.id, wait: true });
  await hurried.close();
  assert.match(short.text, new RegExp(`is starting: 0 of 8 frames\\. Still not ready after .*: call video with video: "${made.id}" and wait: true again\\.`));
  fake.state.holdVideos = false;

  const mcp2 = connect();
  const followed = await mcp2.tool('video', { job: job.id, video: made.id, wait: true, folder: 'clips' });
  assert.equal(followed.isError, undefined, followed.text);
  assert.match(followed.text, /is ready: 8 frames \(1-8\) at 12 FPS, 0\.67 s, 2x2/);
  assert.deepEqual(await readFile(join(project, 'clips', `${made.id}.mp4`)), MP4);
  assert.ok(!fake.state.calls.slice(-3).some((call) => call.method === 'POST'), 'following starts nothing');

  // Done, it is no longer running: a new one of the same render starts.
  const next = await mcp2.tool('video', { job: job.id });
  assert.equal(next.isError, undefined, next.text);
  assert.notEqual(videoOf(next.text).id, made.id);

  const unknown = await mcp2.tool('video', { job: job.id, video: 'vid_0123456789abcdef' });
  assert.match(unknown.text, /This job has no MP4 with this id.*\(video_not_found\)/);
  await mcp2.close();
  await mcp.close();
});

// Codex starts a plugin's server in the plugin's own folder, passes no project folder and cannot ask for a key
// at install: it names the project on every call, and the key can be in ~/.config/cloudbake/api_key.
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname;
const codexMeta = (folder) => ({ 'x-codex-turn-metadata': { workspaces: { [folder]: { has_changes: false } } }, plugin_id: 'cloudbake@cloudbake' });

test('Codex: relative paths are in the project the call names, and refused when no call names one', async () => {
  const mcp = connect({ CLOUDBAKE_PROJECT_DIR: '' }, { cwd: PLUGIN_ROOT });
  await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } });

  const lost = await mcp.tool('render', { file: 'scene.blend', frames: '1' });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /scene\.blend is relative.*Give the full path/);

  const started = await mcp.tool('render', { file: 'scene.blend', frames: '1' }, codexMeta(project));
  assert.ok(!started.isError, started.text);
  const job = jobOf(started.text).job ?? jobOf(started.text);
  const id = job.id;
  await mcp.tool('status', { job: id, wait: true }, codexMeta(project));
  const saved = await mcp.tool('download', { job: id }, codexMeta(project));
  assert.ok(!saved.isError, saved.text);
  assert.ok((await readdir(join(project, 'renders', id))).some((name) => name.endsWith('.png')));
  await mcp.close();
});

test('Codex and Grok: the key can be in ~/.config/cloudbake/api_key, read on each call, and is never printed', async () => {
  const config = await mkdtemp(join(tmpdir(), 'cloudbake-config-'));
  const mcp = connect({ CLOUDBAKE_API_KEY: '', XDG_CONFIG_HOME: config });
  await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } });
  const none = await mcp.tool('whoami');
  assert.equal(none.isError, true);
  assert.match(none.text, /No CloudBake API key is set/);
  assert.match(none.text, /~\/\.config\/cloudbake\/api_key/);
  assert.doesNotMatch(none.text, /\/plugin configure/);

  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(config, 'cloudbake'), { recursive: true });
  await writeFile(join(config, 'cloudbake', 'api_key'), `${FAKE_KEY}\n`);
  const me = await mcp.tool('whoami');
  assert.ok(!me.isError, me.text);
  assert.doesNotMatch(mcp.output(), new RegExp(FAKE_KEY));
  await mcp.close();
  await rm(config, { recursive: true, force: true });
});

test('Grok Build: the missing-key sentence says how to set it there', async () => {
  const mcp = connect({ CLOUDBAKE_API_KEY: '' });
  await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1.0.70' } });
  const none = await mcp.tool('whoami');
  assert.match(none.text, /starts Grok/);
  await mcp.close();
});
