import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cpuPercent, decodeThrottled, parseMeminfo, parseNetDev, parseProcStat, ResourceMonitor } from '../../src/system/resources.ts';

describe('recursos del equipo', () => {
  it('uso de CPU a partir de /proc/stat (total y por núcleo)', () => {
    const before = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nintr 1\n');
    const after = parseProcStat('cpu  250 0 150 900 0 0 0 0 0 0\ncpu0 150 0 75 425 0 0 0 0 0 0\ncpu1 100 0 75 475 0 0 0 0 0 0\n');
    assert.equal(before.length, 3);
    assert.equal(Math.round(cpuPercent(before[0]!, after[0]!) * 10) / 10, 66.7);
    assert.equal(Math.round(cpuPercent(before[1]!, after[1]!) * 10) / 10, 83.3);
    assert.equal(cpuPercent(before[0]!, before[0]!), 0, 'sin tiempo transcurrido: 0, nunca NaN');
  });

  it('memoria disponible (no «libre»: la caché se puede liberar)', () => {
    const memory = parseMeminfo('MemTotal:        8007400 kB\nMemFree:  100 kB\nMemAvailable:    7621484 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n');
    assert.deepEqual(memory, { total: 8007400 * 1024, available: 7621484 * 1024, swapTotal: 2097148 * 1024, swapFree: 2097148 * 1024 });
  });

  it('tráfico de red sin contar loopback', () => {
    const text = 'Inter-|   Receive\n face |bytes\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 100 1 0 0 0 0 0 0 40 1 0 0 0 0 0 0\n wlan0: 200 1 0 0 0 0 0 0 60 1 0 0 0 0 0 0\n';
    assert.deepEqual(parseNetDev(text), { rx: 300, tx: 100 });
  });

  it('alimentación de la Raspberry Pi (vcgencmd get_throttled)', () => {
    assert.deepEqual(decodeThrottled(0), { undervoltageNow: false, throttledNow: false, heatLimitNow: false, undervoltageSinceBoot: false, throttledSinceBoot: false, heatLimitSinceBoot: false });
    // 0x50005: subtensión ahora y desde el arranque, ralentizado ahora y desde el arranque.
    assert.deepEqual(decodeThrottled(0x50005), { undervoltageNow: true, throttledNow: true, heatLimitNow: false, undervoltageSinceBoot: true, throttledSinceBoot: true, heatLimitSinceBoot: false });
  });

  it('una instantánea siempre tiene forma completa (también fuera de Linux)', async () => {
    const monitor = new ResourceMonitor();
    await monitor.sample();
    await monitor.sample();
    const snap = await monitor.snapshot();
    assert.ok(snap.memory.totalBytes > 0);
    assert.ok(snap.cpu.percent >= 0 && snap.cpu.percent <= 100);
    assert.equal(snap.history.at.length, 2);
    assert.equal(snap.history.cpu.length, 2);
  });
});
