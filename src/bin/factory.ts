#!/usr/bin/env node
/**
 * factory CLI — dispatches a subcommand to the matching orchestrator.
 *
 *   factory triage      (issues: opened)
 *   factory implement   (build: plan → implement → validate gate)
 *   factory review      (risk gate on a PR)
 *   factory resume      (decide whether a human answer resumes the agent)
 *
 * All input comes from environment variables set by the workflow (ISSUE_NUMBER,
 * PR_NUMBER, GITHUB_TOKEN, OPENCODE_API_KEY, and the FACTORY_* config vars).
 */

const commands = {
  triage: () => import("../triage.js"),
  implement: () => import("../implement.js"),
  review: () => import("../review.js"),
  resume: () => import("../resume.js"),
} as const;

type Command = keyof typeof commands;

async function main() {
  const cmd = process.argv[2] as Command | undefined;
  if (!cmd || !(cmd in commands)) {
    console.error(`Usage: factory <command>\n\nCommands:\n  ${Object.keys(commands).join("\n  ")}`);
    process.exit(2);
  }
  const { log } = await import("../lib/log.js");
  log(`${cmd}: invoked (repo ${process.env.GITHUB_REPOSITORY ?? "?"})`);
  const mod = await commands[cmd]();
  await mod.run();
  log(`${cmd}: done`);
}

main()
  .then(async () => {
    // The work is done; don't let a stray handle (SDK sockets, a lingering child)
    // hold the Actions step open for the whole job timeout. Flush stdout first —
    // process.exit can truncate pending writes to a pipe, and CI logs are a pipe.
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
