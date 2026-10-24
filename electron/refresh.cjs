function startRefresh({ roots, local, remote, error }, timers = globalThis) {
  const running = new Set();
  let stopped = false;
  const tick = async (kind) => {
    for (const root of roots()) {
      if (stopped) return;
      const key = `${kind}:${root}`;
      // A local scan must not suppress a five-minute remote check merely
      // because the two intervals happen to fire together.
      if (running.has(key) || (kind === 'local' && running.has(`remote:${root}`))) continue;
      running.add(key);
      try { await (kind === 'local' ? local : remote)(root); }
      catch (failure) { if (!stopped) error(root, failure); }
      finally { running.delete(key); }
    }
  };
  const localTimer = timers.setInterval(() => tick('local'), 1000);
  const remoteTimer = timers.setInterval(() => tick('remote'), 5 * 60 * 1000);
  return () => { stopped = true; timers.clearInterval(localTimer); timers.clearInterval(remoteTimer); };
}
module.exports = { startRefresh };
