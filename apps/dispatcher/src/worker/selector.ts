import type { WorkerPool } from '@tryme/types';
import type { Redis } from 'ioredis';
import { healthKey, REGISTRY_KEY } from './registry.js';

const RR_CURSOR_KEY = 'worker:rr_cursor';

// Lua script: atomically round-robin to the next IDLE+healthy worker that accepts
// the given job type, mark BUSY, return {id, url, apiKey}.
// ARGV[1] = Date.now() timestamp, ARGV[2] = jobType ('catalogue' | 'tryon').
// Workers with an empty allowedJobTypes array accept any job type.
const CLAIM_LUA = `
local fields = redis.call('HGETALL', KEYS[1])
local n = #fields / 2
if n == 0 then return false end
local cursor = redis.call('INCR', KEYS[3])
local start = cursor % n
local jobType = ARGV[2]
for offset = 0, n - 1 do
  local i = ((start + offset) % n) * 2 + 1
  local id = fields[i]
  local ok, val = pcall(cjson.decode, fields[i+1])
  if ok and val.status == 'IDLE' then
    if redis.call('EXISTS', KEYS[2] .. id) == 1 then
      local eligible = true
      local allowed = val.allowedJobTypes
      if allowed and #allowed > 0 then
        eligible = false
        for _, t in ipairs(allowed) do
          if t == jobType then eligible = true break end
        end
      end
      if eligible then
        val.status = 'BUSY'
        val.lastSeen = tonumber(ARGV[1])
        redis.call('HSET', KEYS[1], id, cjson.encode(val))
        return {id, val.url, val.apiKey}
      end
    end
  end
end
return false
`;

export interface ClaimedWorker {
  id: string;
  url: string;
  apiKey: string;
}

export async function selectWorker(
  redis: Redis,
  jobType: WorkerPool,
): Promise<ClaimedWorker | null> {
  const healthPrefix = healthKey(''); // "worker:health:"
  const result = (await redis.eval(
    CLAIM_LUA,
    3,
    REGISTRY_KEY,
    healthPrefix,
    RR_CURSOR_KEY,
    String(Date.now()),
    jobType,
  )) as [string, string, string] | false | null;

  if (!result) return null;
  const [id, url, apiKey] = result;
  return { id, url, apiKey };
}
