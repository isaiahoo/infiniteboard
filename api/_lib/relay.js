// Delivers board commands to the user's open tab and waits for the reply.
//
//   MCP function ──RPUSH──▶ queue:<board> ◀──BLPOP── board tab's long-poll
//   MCP function ──BLPOP──▶ result:<id>  ◀──RPUSH── board tab posts the result
//
// Blocking pops cost one Redis command however long they wait, which keeps idle boards cheap.
// Everything expires within a minute; board content is never stored.
import { randomToken } from "./http.js";
import { blpop, key, redis } from "./redis.js";

export const ACTIVE_TTL = 120; // a tab counts as online for this long after its last poll
const CALL_TIMEOUT = 25; // seconds to wait for the tab to answer

export const queueKey = (boardId) => key("queue", boardId);
export const activeKey = (boardId) => key("active", boardId);
export const resultKey = (id) => key("result", id);

export async function callBoard(boardId, method, params = {}) {
  const r = redis();
  if (!(await r.exists(activeKey(boardId)))) {
    throw new Error(
      "The board isn't open right now. Ask the user to open InfiniteBoard in the browser they connected from and keep the tab open.",
    );
  }
  const id = randomToken();
  const deadline = Date.now() + CALL_TIMEOUT * 1000;
  await r
    .multi()
    .rpush(queueKey(boardId), JSON.stringify({ id, method, params, deadline }))
    .expire(queueKey(boardId), 60)
    .exec();
  const raw = await blpop(resultKey(id), CALL_TIMEOUT);
  if (!raw) throw new Error(`The board didn't answer "${method}" in time. The tab may have been closed or put to sleep.`);
  const reply = JSON.parse(raw);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

export async function deliverResult(id, reply) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) return;
  await redis().multi().rpush(resultKey(id), JSON.stringify(reply)).expire(resultKey(id), 60).exec();
}
