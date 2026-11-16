import { describe, expect, it } from "vitest";
import { checkComputerHelperProtocol } from "./computer-helper-protocol";

const check = (source: string) => checkComputerHelperProtocol(process.execPath, ["-e", source]);
const hello = 'console.log(JSON.stringify({type:"hello",protocolVersion:1}));';
describe("native helper protocol probe", () => {
  it("requires correlated permission and suspend replies", async () => {
    await check(`${hello}
      let buffer = ''; process.stdin.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const requestId = message.requestId ?? message.request?.requestId;
          console.log(JSON.stringify({type:'response',requestId,result:{available:false}}));
        }
      });`);
  });
  it("accepts a clean fail-closed startup refusal without crashing on a broken pipe", async () => {
    await check(
      `${hello} console.log(JSON.stringify({type:'status',status:{available:false,reason:'missing-permissions'}})); process.exit(0);`,
    );
  });
  it.each(["other-instance", "helper-crashed"])(
    "rejects an incomplete %s handshake",
    async (reason) => {
      await expect(
        check(
          `${hello} console.log(JSON.stringify({type:'status',status:{available:false,reason:${JSON.stringify(reason)}}})); process.exit(0);`,
        ),
      ).rejects.toThrow("exited");
    },
  );
  it("does not turn a crashed helper's permission refusal into success", async () => {
    await expect(
      check(
        `${hello} console.log(JSON.stringify({type:'status',status:{available:false,reason:'missing-permissions'}})); process.exit(1);`,
      ),
    ).rejects.toThrow("exited");
  });
  it("rejects mismatched protocol versions", async () => {
    await expect(
      check(
        'console.log(JSON.stringify({type:"hello",protocolVersion:2})); process.stdin.resume();',
      ),
    ).rejects.toThrow("mismatch");
  });
  it("rejects malformed messages without throwing from the data listener", async () => {
    await expect(check('console.log("null"); process.stdin.resume();')).rejects.toThrow(
      "Invalid helper",
    );
  });
});
