// Separate physical connection and process. Only the temporary benchmark DB is opened.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec(
  "PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS perf_writes (id INTEGER PRIMARY KEY, value TEXT)",
);
const bounded = process.argv[3] === "bounded";
const write = db.prepare(
  bounded
    ? "INSERT INTO perf_writes(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
    : "INSERT INTO perf_writes(value) VALUES (?)",
);
let writes = 0;
let failures = 0;
const timer = setInterval(() => {
  try {
    if (bounded) write.run(writes % 1000, `write-${writes}`);
    else write.run(`write-${writes}`);
    writes++;
  } catch {
    failures++;
  }
}, 5);
process.send?.({ ready: true });
let closed = false;
function close() {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  db.close();
}
// An interrupted Vitest worker must not leave a background writer alive.
process.on("disconnect", close);
process.on("SIGINT", () => {
  close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  close();
  process.exit(0);
});
process.on("message", () => {
  close();
  process.send?.({ writes, failures }, () => process.disconnect());
});
