import { afterEach, describe, expect, it } from 'vitest';
import { connectSubagents } from '../src/integrations/gotgenes-subagents.ts';

const SERVICE_KEY = Symbol.for('@gotgenes/pi-subagents:service');
const globalRecord = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete globalRecord[SERVICE_KEY];
});

describe('connectSubagents', () => {
  it('reports unavailable when the service is not published', async () => {
    const integration = await connectSubagents();
    expect(integration.available).toBe(false);
    if (!integration.available) {
      expect(integration.reason).toContain('not published');
    }
  });

  it('exposes listAgents when the service is published', async () => {
    const records = [
      {
        id: 'a1',
        type: 'Explore',
        description: 'explore stuff',
        status: 'running',
        toolUses: 2,
        startedAt: 1000,
      },
    ];
    globalRecord[SERVICE_KEY] = { listAgents: () => records, steer: async () => true };

    const integration = await connectSubagents();
    expect(integration.available).toBe(true);
    if (integration.available) {
      expect(integration.listAgents()).toEqual(records);
    }
  });

  it('exposes steer when the service is published', async () => {
    const steered: Array<[string, string]> = [];
    globalRecord[SERVICE_KEY] = {
      listAgents: () => [],
      steer: async (id: string, message: string) => {
        steered.push([id, message]);
        return true;
      },
    };

    const integration = await connectSubagents();
    expect(integration.available).toBe(true);
    if (integration.available) {
      await expect(integration.steer('a1', 'wake up')).resolves.toBe(true);
      expect(steered).toEqual([['a1', 'wake up']]);
    }
  });
});
