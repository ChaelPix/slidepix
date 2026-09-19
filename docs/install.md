# Developer install (Linux and macOS)

This guide is for people who want to compile SlidePix and install the resulting
VSIX. It covers **Ubuntu and macOS with zsh**. Windows is out of scope. People
who only want to use a prebuilt VSIX should follow the root
[README](../README.md).

Day-to-day debugging, tests, and release checks stay in the
[development guide](development.md).

## What you need

- Git and `curl`
- Node.js 20 or newer (the extension build targets Node 20; stay on 20–24 so
  Corepack is available)
- pnpm 10.29.3 (pinned in the root `package.json` `packageManager` field)
- desktop [VS Code](https://code.visualstudio.com/) 1.99 or newer, or
  [Cursor](https://www.cursor.com/)

Do not use npm or Yarn to install this repository. Do not use Ubuntu’s default
`nodejs` package unless `node -v` already reports 20 or newer.

## 1. Install Git and curl

Ubuntu:

```zsh
sudo apt update
sudo apt install -y git curl
```

macOS: install Git from Xcode Command Line Tools or Homebrew. `curl` is already
present.

```zsh
xcode-select --install
# or: brew install git
```

## 2. Install Node.js 20

### Ubuntu (zsh)

Use [nvm](https://github.com/nvm-sh/nvm) so the Node binary is yours, not a
stale distro package:

```zsh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
source ~/.zshrc
nvm install 20
nvm alias default 20
```

Open a new terminal if `nvm` is still unknown after `source ~/.zshrc`. Confirm:

```zsh
node -v   # v20.x or newer
npm -v
```

### macOS (zsh)

Either use the same nvm commands as Ubuntu, or Homebrew:

```zsh
brew install node@20
```

If `node` is not on your PATH after Homebrew, follow the formula’s caveats
(`brew info node@20`) and then `source ~/.zshrc`.

## 3. Enable pnpm 10.29.3

Corepack ships with Node 20–24 and should install the version this repo pins:

```zsh
corepack enable
corepack prepare pnpm@10.29.3 --activate
pnpm -v   # 10.29.3
```

If `corepack` is missing or its signatures are stale:

```zsh
npm install -g corepack
corepack enable
corepack prepare pnpm@10.29.3 --activate
```

Do not run `corepack use` in this repository; that would rewrite
`packageManager`.

## 4. Clone, install, and compile

```zsh
git clone git@github.com:ChaelPix/slidepix.git
cd slidepix
pnpm install
pnpm build
```

`pnpm install` downloads workspace dependencies. `pnpm build` compiles `@slidepix/core`,
the React webview, the MCP server, and the VS Code extension, and writes generated
schema, `dist`, `media`, and vendored Playwright Core files. Do not hand-edit those
outputs.

Optional checks after a first build:

```zsh
pnpm test
pnpm typecheck
pnpm docs:check
```

## 5. Package the VSIX

```zsh
pnpm package
```

The artifact is `packages/extension/slidepix-0.1.0.vsix`.

## 6. Install the VSIX on Ubuntu (or macOS)

From the repository root, with VS Code or Cursor already installed:

```zsh
code --install-extension packages/extension/slidepix-0.1.0.vsix
# or
cursor --install-extension packages/extension/slidepix-0.1.0.vsix
```

If `code` or `cursor` is not found, open the editor and run **Shell Command:
Install 'code' command in PATH** (VS Code) or the matching Cursor command, then
retry in a new zsh session.

Without a CLI:

1. Open VS Code or Cursor.
2. Open the Extensions view.
3. Choose **… → Install from VSIX…**.
4. Select `packages/extension/slidepix-0.1.0.vsix`.
5. Reload the window if the editor asks.

After install, run **SlidePix: Create Deck** from the Command Palette
(`Ctrl+Shift+P` on Linux, `Cmd+Shift+P` on macOS).

## Iterate without reinstalling the VSIX

For local extension development, `pnpm build` (or `pnpm dev`) plus **F5** in VS
Code is enough; see [Debug the extension](development.md#debug-the-extension).
Re-run `pnpm package` and the VSIX install only when you want the built
extension in your normal Ubuntu/macOS editor.

PDF, PNG, MCP rendering, and `scripts/render-smoke.mjs` still need a later
**SlidePix: Install Export Renderer** consent download. That Chromium binary is
not part of `pnpm install` or the VSIX.
