/** Locate Git's subcommand without treating config values or pathspecs as commands. */
export function gitMutatesRefSnapshot(args: readonly string[]): boolean {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++]!;
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option))
      index++;
  }
  const command = args[index];
  const options = args.slice(index + 1);
  if (command === "worktree") return options[0] !== "list";
  if (command === "remote")
    return ![undefined, "-v", "--verbose", "get-url", "show"].includes(options[0]);
  if (command === "branch")
    return (
      options.some((arg) =>
        [
          "-d",
          "-D",
          "-m",
          "-M",
          "-c",
          "-C",
          "-f",
          "--delete",
          "--move",
          "--copy",
          "--force",
        ].includes(arg),
      ) ||
      (!options.some((arg) =>
        ["--list", "-a", "-r", "--all", "--remotes", "--show-current", "-v", "-vv"].includes(arg),
      ) &&
        options.some((arg) => !arg.startsWith("-")))
    );
  if (command === "tag")
    return (
      options.some((arg) => ["-d", "--delete", "-a", "-s", "-f", "--force"].includes(arg)) ||
      (options.length > 0 &&
        !options.some((arg) => ["-l", "--list", "-v", "--verify"].includes(arg)))
    );
  return (
    [
      "checkout",
      "switch",
      "fetch",
      "pull",
      "push",
      "commit",
      "reset",
      "update-ref",
      "merge",
      "rebase",
      "cherry-pick",
      "revert",
      "symbolic-ref",
    ].includes(command ?? "") &&
    !(
      command === "symbolic-ref" &&
      !options.includes("--delete") &&
      options.filter((arg) => !arg.startsWith("-")).length < 2
    )
  );
}
