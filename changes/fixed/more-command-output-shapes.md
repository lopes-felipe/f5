- Expanded command cards highlight more agent commands:
  - Searches over a file from another revision or piped from a read, such as
    `git show main:a.ts | grep -n x` or `sed -n 40,80p a.ts | grep -n x`, are grouped under that
    file with its real line numbers.
  - Chains that print labels or counts (`echo "== x"`, `wc -l a.ts`) keep highlighting the reads and
    searches around them.
  - Commands that use shell variables (`H=abc123; git show $H:a.ts`) or `|| true` are followed.
  - Reads of a file written earlier in the same command show the original file's name, as in
    `git show A:a.ts > /tmp/a.ts` followed by `sed -n 1,9p /tmp/a.ts`.
  - One command the card cannot follow, such as `a || b`, no longer turns the output before it
    plain.
