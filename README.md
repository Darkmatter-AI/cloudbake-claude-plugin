# CloudBake for Claude Code

Render Blender scenes on cloud GPUs without leaving Claude Code. Ask for frames of a .blend in your project:
the file goes to [CloudBake](https://cloudbake.ai), a cloud GPU renders it, and the frames are saved back into
your project. It converts scenes to .glb, .fbx and .usdz too.

```
> Render frames 1 to 24 of kitchen.blend and put them in renders/

⏺ cloudbake - render (file: "kitchen.blend", frames: "1-24")
⏺ cloudbake - status (job: "rq_…", wait: true)
⏺ cloudbake - download (job: "rq_…", folder: "renders")
  ⎿ Saved 24 files in renders/
```

## What you need

- **Claude Code.** `claude --version` says which you have.
- **Node.js 20 or later.** The plugin's small server runs on it. `node --version` says which you have; get it
  from [nodejs.org](https://nodejs.org) or with `brew install node`.
- **A CloudBake account and an API key.** CloudBake is invite-only for now:
  [request access](https://cloudbake.ai/#access). Once you are in, open
  [Connections](https://cloudbake.ai/app/connections), make a key and copy it. It is shown once.
  Every account starts with $5 of credit.

## Install

In Claude Code, type these two commands:

```
/plugin marketplace add Darkmatter-AI/cloudbake-claude-plugin
```

```
/plugin install cloudbake@cloudbake
```

The install asks for your **CloudBake API key**: paste it there, never into the chat. Claude Code keeps it in
your system's credential store, not in a settings file. If it does not ask, run
`/plugin configure cloudbake@cloudbake`.

Then run `/reload-plugins`, or restart Claude Code, so the plugin's server starts.

On Claude Code 2.1.275 or later, one command does both: `/plugin install cloudbake --marketplace Darkmatter-AI/cloudbake-claude-plugin`.

To check it works, ask: **"Which CloudBake account am I using?"** Claude answers with your email address
and the last four characters of the key.

**From a shell instead of a session.** `claude plugin marketplace add Darkmatter-AI/cloudbake-claude-plugin`, then
`claude plugin install cloudbake@cloudbake`. The shell does not ask for the key: set it in a session with
`/plugin configure cloudbake@cloudbake`, or export `CLOUDBAKE_API_KEY` in the shell that starts Claude Code.

## Render

Ask in your own words:

- "Render frame 1 of kitchen.blend with CloudBake."
- "Render frames 1-120 of cave_walk.blend at 1920x1080, 128 samples, into renders/cave."
- "Convert kitchen.blend to .glb and .usdz."
- "Make an MP4 of that render, leaving out frames 25-30."
- `/cloudbake:render kitchen.blend 1-24`

The first time, Claude Code asks you to allow the cloudbake tools. Claude checks the scene, renders one test
frame first and shows it to you, then asks before the rest. A first frame takes about a minute, while a GPU
starts. Each
job also shows on [Requests](https://cloudbake.ai/app/requests), and what it cost on
[Credits](https://cloudbake.ai/app/credits).

### Before you send a scene

- Save it with **Blender 5.2 or older.** CloudBake runs Blender 5.2.
- Give it a **camera**, set as the scene's camera.
- **Pack its textures** into the file: File › External Data › Pack Resources, then save.
- A file can be 4 GiB at most, and a job 2,000 frames.

The job checks the scene on a CPU before any GPU starts. A scene that cannot render stops there, with a
sentence that says what to change, and costs nothing.

### What it costs

GPU time is paid from your CloudBake credit. A small test frame costs about a cent; big frames with many
samples cost more. A convert runs on a CPU and is free.

## Update or remove

- Update: `/plugin marketplace update cloudbake`, then `/plugin update cloudbake@cloudbake` and `/reload-plugins`.
- Remove: `/plugin uninstall cloudbake@cloudbake`, and `/plugin marketplace remove cloudbake`. Revoke the key in
  [Connections](https://cloudbake.ai/app/connections) if you no longer use it.

## The tools

| Tool | What it does |
| --- | --- |
| `render` | Uploads a .blend (or reuses an upload, or the hosted sample) and starts a render of the frames you name. |
| `convert` | The same for a convert to .glb, .fbx or .usdz. |
| `status` | How a job is going. With `wait`, it waits until the job ends, up to 5 minutes a call. |
| `download` | Saves what a job made into a folder: one PNG a frame, frames.zip, or the converted files. |
| `cancel` | Stops a job. Frames already made are kept. |
| `whoami` | Which account and key the plugin uses. |
| `video` | Makes an MP4 of a finished render's frames (all, or `frames` / `leave_out`), free in the beta, and saves it into `renders/<job id>/`. |

The plugin calls the same API as the [quickstart](https://cloudbake.ai/docs/quickstart) and the
[API reference](https://cloudbake.ai/docs/api). Your files go straight to storage, and the frames come straight
back.

## Develop

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin: name, version, and the API key it asks for (`userConfig.api_key`, sensitive). |
| `.claude-plugin/marketplace.json` | The marketplace this repository is, listing the plugin at its root. |
| `.mcp.json` | Starts the server with `node`, and passes it the key and the project folder. |
| `server/cloudbake-mcp.mjs` | The MCP server: plain Node, no packages, over stdio. |
| `skills/render/SKILL.md` | How Claude renders with it: check the scene, one test frame first, follow, download, an MP4. |
| `test/` | Tests of the server against a fake API (`fake-api.mjs`). |

- **Test:** `node --test test/` (Node 22 or later, for the fake API's PNG). Nothing is sent to CloudBake.
- **Check the manifests:** `claude plugin validate .`
- **Try it in Claude Code without spending:** `node test/fake-api.mjs --serve` prints the variables to start
  Claude Code with. Then `claude --plugin-dir /path/to/this/repo` in a folder with a .blend. A `--plugin-dir`
  load does not ask for the key, so the shell's `CLOUDBAKE_API_KEY` is used.
- **Release a change:** bump `version` in `.claude-plugin/plugin.json`. People stay on the version they have
  until it changes.

Questions and problems: [open an issue](https://github.com/Darkmatter-AI/cloudbake-claude-plugin/issues), or
write to hello@cloudbake.ai.

## License

MIT. See [LICENSE](LICENSE).
