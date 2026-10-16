import { $ } from "bun";

// `bun run release <patch|minor|major>`: bumps the version, commits, tags v<version> and pushes,
// once the check passes on a clean main. A repo picks it up with
// `bun add -d github:danmcfan/sandworm#v<version>`.
const part = process.argv[2];
if (part !== "patch" && part !== "minor" && part !== "major")
  throw new Error("Usage: bun run release <patch|minor|major>");
if ((await $`git branch --show-current`.text()).trim() !== "main") throw new Error("Release from main.");
if ((await $`git status --porcelain`.text()).trim() !== "") throw new Error("Commit or stash your changes first.");
await $`bun run check`;

const pkg: { version: string } = await Bun.file("package.json").json();
const [major = 0, minor = 0, patch = 0] = pkg.version.split(".").map(Number);
const version =
  part === "major"
    ? `${major + 1}.0.0`
    : part === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
const text = await Bun.file("package.json").text();
await Bun.write("package.json", text.replace(`"version": "${pkg.version}"`, `"version": "${version}"`));
await $`git commit -qam ${`Release v${version}`}`;
await $`git tag -m ${`v${version}`} v${version}`;
await $`git push -q origin main v${version}`;
console.log(`Released v${version}. In each repo: bun add -d github:danmcfan/sandworm#v${version}`);
