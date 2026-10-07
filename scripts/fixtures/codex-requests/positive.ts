interface ThreadRevertParams {
  threadId: string;
  beforeTurnId: string;
}
const request = { threadId: "thread", beforeTurnId: "turn" };
const check: ThreadRevertParams = request;
void check;
export {};
