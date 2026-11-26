# CloudBake for Claude Code, Codex and Grok

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

This repository is a plugin for three coding agents, from the same files:

- **Claude Code**: the plugin below, with its own small server that sends the .blend and saves the frames.
- **Codex** (OpenAI): [Codex](#codex) further down. It uses CloudBake's hosted server and signs in with your
  CloudBake account: no key to make.
- **Grok Build** (xAI's coding agent): [Grok Build](#grok-build). It installs the Claude Code plugin as it is.

Grok through the xAI API is at [Grok through the xAI API](#grok-through-the-xai-api). ChatGPT and claude.ai
connect to CloudBake without a plugin: see [Connect AI](https://cloudbake.ai/docs/connect).

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
samples cost more. A convert runs on a CPU and is free. When a job ends, `status` says what it cost, so after a
test frame Claude can say what the whole job would cost.

An account runs 3 jobs at once, and a job beyond that is refused, not queued. Claude puts the frames of an
animation in one job (up to 2,000 frames) rather than starting many.

## Codex

CloudBake's plugin for Codex adds CloudBake's hosted server (`https://cloudbake.ai/mcp`) and a skill that tells
Codex how to render: check the scene, send it, render one test frame, show it, then the rest, and save the
frames and an MP4 into the project. You sign in with your CloudBake account in the browser; there is no key.

In a terminal:

```bash
codex plugin marketplace add Darkmatter-AI/cloudbake-claude-plugin
```

```bash
codex plugin add cloudbake@cloudbake
```

```bash
codex mcp login cloudbake
```

The last one opens CloudBake in your browser: sign in, check that it names Codex, and click **Allow**. In the Codex
app, the plugin is also under **Plugins**, once the first command has added the marketplace.

Then start Codex in a folder with a .blend and ask: **"Render frame 1 of scene.blend with CloudBake."** Codex sends
the file and saves the frames with `curl`, in the project folder. Those `curl` lines need the network: if your Codex
sandbox has none, Codex asks before running them.

- Update: `codex plugin marketplace upgrade cloudbake`.
- Remove: `codex plugin remove cloudbake@cloudbake`, then `codex plugin marketplace remove cloudbake`.
- Already added CloudBake with `codex mcp add cloudbake --url https://cloudbake.ai/mcp`? That works as it is; the
  plugin adds the skill. Use one or the other: `codex mcp remove cloudbake` takes the first one out.

## Grok Build

[Grok Build](https://docs.x.ai/build/overview), xAI's coding agent, reads Claude Code plugins, so it installs this
one as it is: the same server, which sends the .blend from your project and saves the frames into it.

```bash
grok plugin install Darkmatter-AI/cloudbake-claude-plugin
```

Grok cannot ask for a key at install. Make one at [Connections](https://cloudbake.ai/app/connections), click Copy,
and save it where the plugin looks for it (or set `CLOUDBAKE_API_KEY` in the shell that starts Grok):

```bash
mkdir -p ~/.config/cloudbake && pbpaste > ~/.config/cloudbake/api_key && chmod 600 ~/.config/cloudbake/api_key
```

On Linux, run `cat > ~/.config/cloudbake/api_key`, paste, then press Ctrl-D. `grok mcp doctor cloudbake` checks that
the server starts. Then ask Grok: **"Render frame 1 of scene.blend with CloudBake."**

Without the plugin, Grok Build can also use the hosted server, with a key:
`grok mcp add --transport http cloudbake https://cloudbake.ai/mcp --header 'Authorization: Bearer ${CLOUDBAKE_API_KEY}'`
(in single quotes: Grok fills in the variable each time it starts, so the key is not written in its config).

## Grok through the xAI API

The xAI API calls remote MCP servers itself ([Remote MCP tools](https://docs.x.ai/developers/tools/remote-mcp)):
you name CloudBake's server in the request, with your CloudBake key, and Grok renders. `grok/render-with-grok.mjs`
does it in one request, with plain Node:

```bash
XAI_API_KEY=xai-… CLOUDBAKE_API_KEY=cb_live_… node grok/render-with-grok.mjs
```

The tool it sends is:

```json
{
  "type": "mcp",
  "server_url": "https://cloudbake.ai/mcp",
  "server_label": "cloudbake",
  "allowed_tools": ["whoami", "render", "status", "download", "video"],
  "authorization": "cb_live_…"
}
```

xAI's servers call CloudBake, so the scene must be online: the sample, an upload made earlier (`upload: "up_…"`),
or a link to a .blend (`url`). The frames come back as links.

## Update or remove

- Update: `/plugin marketplace update cloudbake`, then `/plugin update cloudbake@cloudbake` and `/reload-plugins`.
- Remove: `/plugin uninstall cloudbake@cloudbake`, and `/plugin marketplace remove cloudbake`. Revoke the key in
  [Connections](https://cloudbake.ai/app/connections) if you no longer use it.

## The tools

| Tool | What it does |
| --- | --- |
| `render` | Uploads a .blend (or reuses an upload, or the hosted sample) and starts a render of the frames you name. |
| `convert` | The same for a convert to .glb, .fbx or .usdz. |
| `status` | How a job is going. With `wait`, it waits until the job ends, up to 5 minutes a call. A job that has ended says what it cost. |
| `download` | Saves what a job made into a folder: one PNG a frame, frames.zip, or the converted files. |
| `cancel` | Stops a job. Frames already made are kept. |
| `whoami` | Which account and key the plugin uses, its balance, the jobs running now, and the limits. |
| `video` | Makes an MP4 of a finished render's frames (all, or `frames` / `leave_out`), free in the beta, and saves it into `renders/<job id>/`. |

The plugin calls the same API as the [quickstart](https://cloudbake.ai/docs/quickstart) and the
[API reference](https://cloudbake.ai/docs/api). Your files go straight to storage, and the frames come straight
back.

## Develop

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin: name, version, and the API key it asks for (`userConfig.api_key`, sensitive). |
| `.claude-plugin/marketplace.json` | The marketplace this repository is, listing the plugin at its root. |
| `.agents/plugins/marketplace.json` | The marketplace Codex reads, listing the Codex plugin in `codex/`. |
| `codex/` | The Codex plugin, on its own so Codex installs only it: `.codex-plugin/plugin.json` (its listing), `.mcp.json` (the hosted server, with OAuth), `skills/render/SKILL.md` and `assets/icon.png`. |
| `.grok-plugin/plugin.json` | What Grok Build lists. It uses `.mcp.json` and `skills/` as Claude Code does. |
| `grok/render-with-grok.mjs` | Grok through the xAI API, in one request. |
| `.mcp.json` | Starts the server with `node`, and passes it the key and the project folder. |
| `server/cloudbake-mcp.mjs` | The MCP server for Claude Code and Grok Build: plain Node, no packages, over stdio. Its key comes from the plugin, `CLOUDBAKE_API_KEY`, or `~/.config/cloudbake/api_key`. |
| `skills/render/SKILL.md` | How Claude (and Grok Build) render with it: check the scene, one test frame first, follow, download, an MP4. |
| `test/` | Tests of the server against a fake API (`fake-api.mjs`). |

- **Test:** `node --test test/*.mjs` (Node 22 or later, for the fake API's PNG). Nothing is sent to CloudBake.
- **Check the manifests:** `claude plugin validate .` and `grok plugin validate .`. Codex has no validator:
  `codex plugin marketplace add /path/to/this/repo`, then `codex plugin add cloudbake@cloudbake`, installs it from here.
  `codex/` holds no server: Codex copies the whole plugin folder, and an agent that finds a server there may run it.
- **Try it in Claude Code without spending:** `node test/fake-api.mjs --serve` prints the variables to start
  Claude Code with. Then `claude --plugin-dir /path/to/this/repo` in a folder with a .blend. A `--plugin-dir`
  load does not ask for the key, so the shell's `CLOUDBAKE_API_KEY` is used.
- **Release a change:** bump `version` in `.claude-plugin/plugin.json`,
  `codex/.codex-plugin/plugin.json`, `.grok-plugin/plugin.json` and `VERSION` in the server, together. People stay on the version they have until it changes.

Questions and problems: [open an issue](https://github.com/Darkmatter-AI/cloudbake-claude-plugin/issues), or
write to hello@cloudbake.ai.

## License

MIT. See [LICENSE](LICENSE).
