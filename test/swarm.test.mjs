
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CircuitBreaker } from '../src/swarm/circuit-breakers.mjs';
import { AgentHealthMonitor } from '../src/swarm/health-monitor.mjs';
import { SwarmMemory } from '../src/swarm/shared-memory.mjs';
import { TaskManager } from '../src/swarm/task-manager.mjs';
import { ConfigManager } from '../src/swarm/config-manager.mjs';

describe('Swarm Resilience Components', () => {
  
  describe('CircuitBreaker', () => {
    it('should pass through successful calls', async () => {
      const breaker = new CircuitBreaker();
      const result = await breaker.call('test-op', async () => 'success');
      assert.strictEqual(result, 'success');
    });

    it('should open after threshold failures', async () => {
      const breaker = new CircuitBreaker(3, 100);
      const fail = async () => { throw new Error('fail'); };

      // 3 failures
      await assert.rejects(breaker.call('test-op', fail));
      await assert.rejects(breaker.call('test-op', fail));
      await assert.rejects(breaker.call('test-op', fail));

      // Should be open now
      await assert.rejects(
        breaker.call('test-op', fail),
        /Circuit breaker OPEN/
      );
    });

    it('should reset after timeout', async () => {
      const breaker = new CircuitBreaker(1, 50);
      const fail = async () => { throw new Error('fail'); };
      
      await assert.rejects(breaker.call('test-op', fail));
      await assert.rejects(breaker.call('test-op', fail), /Circuit breaker OPEN/);

      // Wait for reset
      await new Promise(resolve => setTimeout(resolve, 60));

      // Should try again (half-open)
      // If success, it closes
      const result = await breaker.call('test-op', async () => 'recovered');
      assert.strictEqual(result, 'recovered');
      
      // Should be closed now
      const result2 = await breaker.call('test-op', async () => 'still-good');
      assert.strictEqual(result2, 'still-good');
    });
  });

  describe('AgentHealthMonitor', () => {
    it('should track agent health', () => {
      const monitor = new AgentHealthMonitor();
      monitor.registerAgent('agent-1');
      
      monitor.heartbeat('agent-1');
      monitor.checkHealth(); // Should be healthy
      
      // Simulate time passing by modifying lastHeartbeat manually (internal access for test)
      const agent = monitor.agents.get('agent-1');
      agent.lastHeartbeat = Date.now() - 61000;
      
      monitor.checkHealth();
      assert.strictEqual(agent.failures, 1);
    });
  });

  describe('SwarmMemory', () => {
    it('should store and retrieve values', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-memory-'));
      const storePath = path.join(dir, 'memory.json');
      try {
        const memory = new SwarmMemory({ storePath });
        await memory.update('key1', 'value1', 'agent-1', 'test');
        assert.strictEqual(memory.state.get('key1'), 'value1');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('TaskManager', () => {
    it('should assign tasks to capable agents', () => {
      const agents = new Map([
        ['agent-1', { capabilities: ['compute'], workload: 0 }],
        ['agent-2', { capabilities: ['storage'], workload: 0 }]
      ]);
      const manager = new TaskManager(agents);
      
      const task = { id: 't1', requiredCapabilities: ['compute'] };
      const assignedId = manager.assignTask(task);
      
      assert.strictEqual(assignedId, 'agent-1');
    });
  });

  describe('ConfigManager', () => {
    it('should update config and notify subscribers', async () => {
      const manager = new ConfigManager();
      let notified = null;
      
      manager.subscribe('agent-1', async (config) => {
        notified = config;
      });
      
      await manager.updateConfig({ newSetting: true }, 'admin', 'test');
      
      assert.ok(notified);
      assert.strictEqual(notified.newSetting, true);
      assert.strictEqual(manager.getCurrentConfig().newSetting, true);
    });
  });

});
