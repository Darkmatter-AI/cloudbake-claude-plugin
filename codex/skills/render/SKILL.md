---
name: render
description: Render a Blender scene (.blend) on CloudBake's cloud GPUs and save the frames into the project, make an MP4 of a render, or convert a scene to .glb, .fbx or .usdz. Use when someone asks to render a .blend, render frames or an animation in the cloud, use CloudBake, or turn a Blender file into a .glb or .usdz.
---

# Render with CloudBake

CloudBake renders .blend files on cloud GPUs. The `cloudbake` tools do the work: `upload` sends a .blend, `render` and `convert` start a job, `status` follows it, `download` gets what it made, `video` makes an MP4 of a finished render, `cancel` stops it, `uploads` lists files sent before, `whoami` checks the account. A render is paid for with the person's CloudBake credit, by GPU time. A convert and an MP4 are free.

Files never pass through the tools: `upload`, `download` and `video` answer `curl` lines, and you run them in the project folder. They reach CloudBake's storage over the network: if the sandbox blocks the network, ask to run that `curl` line with network access.

## 1. Find the scene and the frames

- The scene is a .blend in the project. If the person did not say which one and there are several, ask.
- The frames: a number (`1`), a range (`1-24`) or a list (`1,5,9-12`). If the person did not say, ask. "A still" means one frame: the scene's current frame, or `1`.
- Without a file, `sample: true` renders the sample scene CloudBake hosts, to try the service. A .blend online can be rendered from its link with `url`, without uploading.

## 2. Check the scene can render

The job checks the scene on a CPU before any GPU starts, free, and fails with a sentence that says what to change. Catching it first saves a round trip:

- **Blender 5.2 or older.** CloudBake runs Blender 5.2. A file saved by a newer Blender fails.
- **A camera** set as the scene's camera.
- **Textures packed in the file.** Images that are only linked from the disk are not sent. In Blender: File › External Data › Pack Resources, then save. If Blender is installed, you can check: `blender -b scene.blend --python-expr "import bpy; print([i.filepath for i in bpy.data.images if not i.packed_file and i.source == 'FILE'])"` lists the images that are not packed.
- 4 GiB at most, 2,000 frames a job at most, 7680 x 4320 pixels at most.
- **One job for many frames.** An account runs 3 jobs at once, and a job beyond that is refused (`too_many_jobs`), not queued. Put the frames of an animation in one job (`frames: "1-240"`) rather than a job a frame or a job a shot. `whoami` says the account's exact limits, its balance and the jobs running now: call it before starting several jobs.

## 3. Send the file

1. Call `upload` with the file's `name`, its size in `bytes` (`wc -c < scene.blend`) and its `path` relative to the project.
2. Run the `curl -T` line it answers, from the project folder. Nothing else sends the file: the job fails if it was not run.
3. Pass the upload id (`up_…`) as `upload` to `render` or `convert`. An upload is kept for 14 days: to render more frames of the same file, or convert it, pass the same `upload` again rather than sending it twice. `uploads` lists the ones sent before, from here or from cloudbake.ai.

## 4. Render one frame first

GPU time costs credit. For more than a few frames:

1. Render one frame (the first, or one the person cares about).
2. Save it (step 5) and look at the PNG with your image viewer. Show the person: say if it is black, blown out, or missing textures.
3. Say how many frames the full job is and what it would cost, and start it only when they say so. `status` gives what the test frame cost and how many seconds of GPU it took: the full job costs about that times its frames, at the same size and samples.

The scene's own resolution, samples and engine are used unless `width`, `height`, `samples` or `engine` say otherwise. To try quicker, lower `samples` or the size for the test frame. Say so, because it will not look like the final frames.

## 5. Follow it and bring the frames back

1. `render` answers at once with the job (`rq_…`).
2. `status` with `wait: true` waits until the job ends, up to 90 seconds a call. Call it again while it is still going. A first frame takes about a minute, because a GPU has to start.
3. `download` answers a link for each file, good for an hour, and the `curl` lines that save them into `renders/<job id>/` (or `folder`). Run them from the project folder. A render saves one PNG a frame (`frame_00001.png` …), or frames.zip with `zip: true`. Tell the person where the files are.
4. A finished render can become an MP4 with `video` (`wait: true`; `leave_out` cuts frames, like `25-30`). It is made from the frames already rendered, free in the beta. Run the `curl` line it answers to save `renders/<job id>/<vid>.mp4`.

## When something goes wrong

- **The job failed.** `error.message` says why. If `you_can_fix_it` is true, the scene or the request needs changing: say what to change. If it is false, the fault was CloudBake's, and it is not charged: start it again once.
- **Not signed in.** If the tools are missing or say to sign in: the person runs `codex mcp login cloudbake` in a terminal, signs in to CloudBake in the browser and clicks **Allow**. CloudBake is invite-only for now: an account is requested at https://cloudbake.ai. Never ask for a password or a key in the chat.
- **Out of credit** (`out_of_credit`). Credit is added on cloudbake.ai, under Credits.
- **Too many jobs** (`too_many_jobs`). The account already has 3 jobs running; nothing was started or charged. The error lists the jobs running (`running`) and the limit (`limit`). Wait for one with `status` (`wait: true`), or cancel one, then start the job again. Do not retry at once: it is refused again until a job ends.
- **Rate limit** (`rate_limited`). 10 new jobs a minute, 120 calls a minute. Wait the seconds it says, then try again.
- **A link expired.** Links last an hour: call `download` or `video` (with `video: "vid_…"`) again for new ones.

Every job is also on https://cloudbake.ai/app/requests, with its frames, and what it cost is on https://cloudbake.ai/app/credits.
