import { spawn } from "node:child_process";
const lifetime = Number(process.argv[2]);
const child = spawn(
  process.execPath,
  ["-e", `setInterval(()=>{},1000);setTimeout(()=>process.exit(0),${lifetime})`],
  { stdio: "ignore" },
);
const line = "terminal 🦊\r\n" + "x".repeat(1000) + "\r\n";
let timer;
const stop = () => {
  clearInterval(timer);
  child.kill();
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
process.stdout.write("native-terminal-ready\r\n");
timer = setInterval(() => process.stdout.write(line), 200);
setTimeout(stop, lifetime).unref();
