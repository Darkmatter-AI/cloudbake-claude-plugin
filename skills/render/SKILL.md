---
name: render
description: Render a Blender scene (.blend) on CloudBake's cloud GPUs and save the frames into the project, or convert it to .glb, .fbx or .usdz. Use when someone asks to render a .blend, render frames or an animation in the cloud, use CloudBake, or turn a Blender file into a .glb or .usdz.
argument-hint: "[scene.blend] [frames, e.g. 1-24]"
---

# Render with CloudBake

CloudBake renders .blend files on cloud GPUs. The `cloudbake` tools do the work: `render` and `convert` start a job, `status` follows it, `download` saves what it made, `cancel` stops it, `whoami` checks the key. A render is paid for with the person's CloudBake credit, by GPU time. A convert is free.

If the person gave arguments (`$ARGUMENTS`), they name the scene and the frames.

## 1. Find the scene and the frames

- The scene is a .blend in the project. If the person did not say which one and there are several, ask.
- The frames: a number (`1`), a range (`1-24`) or a list (`1,5,9-12`). If the person did not say, ask. "A still" means one frame: the scene's current frame, or `1`.
- Without a file, `sample: true` renders the sample scene CloudBake hosts, to try the service.

## 2. Check the scene can render

The job checks the scene on a CPU before any GPU starts, free, and fails with a sentence that says what to change. Catching it first saves a round trip:

- **Blender 5.2 or older.** CloudBake runs Blender 5.2. A file saved by a newer Blender fails.
- **A camera** set as the scene's camera.
- **Textures packed in the file.** Images that are only linked from the disk are not sent. In Blender: File › External Data › Pack Resources, then save. If Blender is installed, you can check: `blender -b scene.blend --python-expr "import bpy; print([i.filepath for i in bpy.data.images if not i.packed_file and i.source == 'FILE'])"` lists the images that are not packed.
- 4 GiB at most, 2,000 frames a job at most, 7680 x 4320 pixels at most.
- **One job for many frames.** An account runs 3 jobs at once, and a job beyond that is refused (`too_many_jobs`), not queued. Put the frames of an animation in one job (`frames: "1-240"`) rather than a job a frame or a job a shot. `whoami` says the account's exact limits, its balance and the jobs running now: call it before starting several jobs.

## 3. Render one frame first

GPU time costs credit. For more than a few frames:

1. Render one frame (the first, or one the person cares about).
2. Download it and look at it with the Read tool. Show the person: say if it is black, blown out, or missing textures.
3. Say how many frames the full job is and what it would cost, and start it only when they say so. `status` gives what the test frame cost and how many seconds of GPU it took: the full job costs about that times its frames, at the same size and samples.

The scene's own resolution, samples and engine are used unless `width`, `height`, `samples` or `engine` say otherwise. To try quicker, lower `samples` or the size for the test frame. Say so, because it will not look like the final frames.

## 4. Follow it and bring the frames back

1. `render` answers at once with the job (`rq_…`) and the upload (`up_…`).
2. `status` with `wait: true` waits until the job ends, up to 5 minutes a call. Call it again while it is still rendering. A first frame takes about a minute, because a GPU has to start.
3. `download` saves the files into `renders/<job id>/` in the project, or into `folder` if the person named one. A render saves one PNG a frame (`frame_00001.png` …), or frames.zip with `zip: true`. Tell the person where the files are.

To render more frames of the same file, or convert it, pass `upload` instead of `file`: it is not sent again. An upload is kept for 14 days.

## When something goes wrong

- **The job failed.** `error.message` says why. If `you_can_fix_it` is true, the scene or the request needs changing: say what to change. If it is false, the fault was CloudBake's, and it is not charged: start it again once.
- **The key.** If a tool says no key is set, or the key does not work: the person makes a key at https://cloudbake.ai/app/connections, then sets it in Claude Code with `/plugin configure cloudbake@cloudbake`. Never ask them to paste the key into the chat, and never print it.
- **Out of credit** (`out_of_credit`). Credit is added at https://cloudbake.ai/app/credits.
- **Too many jobs** (`too_many_jobs`). The account already has 3 jobs running; nothing was started or charged. The error lists the jobs running (`running`) and the limit (`limit`). Wait for one with `status` (`wait: true`), or cancel one, then start the job again. Do not retry at once: it is refused again until a job ends.
- **Rate limit.** 10 new jobs a minute, 120 calls a minute. The tools wait and try again themselves (not for `too_many_jobs`, which is said at once).

Every job is also on https://cloudbake.ai/app/requests, with its frames, and what it cost is on https://cloudbake.ai/app/credits.
