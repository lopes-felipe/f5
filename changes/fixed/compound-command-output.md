- Expanded command cards highlight more file reads and searches:
  - `git show <rev>:<path>` reads, including ones narrowed with `sed -n` or `head`.
  - `git grep -n` results.
  - Commands that chain several reads and searches. Each read becomes its own highlighted file
    block, results are grouped by file, and output from other commands in the chain stays plain
    text. Before, one unrecognized command made the whole output plain.
