// Connection lifecycle per binding: one transport instance, started lazily,
// restarted when its credentials change, stopped when the binding is disabled.
//
// Connection state lives in memory on purpose: a long-connection leg reconnects
// itself, and a rebuild after restart is acceptable. That is precisely why the
// long-connection leg is worth having — it has no passive window, so there is no
// "lose this state and the next answer cannot be delivered" table to persist
// (contrast paas `bot_reply_windows`).

export function createConnectionManager({ store, registry, acceptance, deliverer, buildEnvelope, tickets, log = console, onChange = null }) {
  const entries = new Map(); // bindingId -> { transport, binding, state }

  const stateOf = (bindingId) => entries.get(bindingId)?.state ?? null;

  function adopt(binding) {
    const entry = entries.get(binding.id);
    if (entry) return entry;
    const adapter = registry.get(binding.platform);
    if (!adapter) throw new Error(`no adapter for platform "${binding.platform}"`);
    const transport = adapter.createTransport(binding);
    const fresh = { transport, binding, state: { connected: false, inboundMode: binding.inboundMode, error: null } };
    entries.set(binding.id, fresh);
    return fresh;
  }

  // Inbound handler shared by every transport shape. Long connections call it
  // from their own loop; the callback route calls it directly.
  async function ingest(binding, message) {
    const envelope = buildEnvelope({ bindingId: binding.id, platform: binding.platform, message, tickets });
    const key = message?.platformMessageId ? `${binding.id}:${message.platformMessageId}` : null;

    let accepted;
    try {
      accepted = acceptance.accept({ bindingId: binding.id, key, payload: message });
    } catch (err) {
      // Disk-first: a full/sick store must make the PLATFORM retry, never be
      // swallowed. The caller turns this into a non-2xx for the callback path.
      err.retryable = true;
      throw err;
    }
    if (accepted.duplicate) {
      log.info(`[ingest] duplicate ${key} on binding ${binding.id}; confirmed without re-delivering`);
      return { duplicate: true };
    }
    // Deliberately not awaited by callers that must answer the platform fast.
    void deliverer
      .deliver({ envelope, subscriberUrl: binding.subscriberUrl, deliveryToken: binding.deliveryToken })
      .then((result) => {
        if (result.ok) acceptance.markDone(accepted.record.id);
        else acceptance.markFailed(accepted.record.id, `${result.status} ${result.detail ?? ""}`.trim());
      })
      .catch((err) => acceptance.markFailed(accepted.record.id, err.message));
    acceptance.markDispatched(accepted.record.id);
    return { duplicate: false, recordId: accepted.record.id };
  }

  async function startBinding(binding) {
    const entry = adopt(binding);
    if (entry.state.connected || typeof entry.transport.start !== "function") {
      entry.state.connected = Boolean(entry.transport.start);
      return entry.state;
    }
    try {
      await entry.transport.start((message) => {
        entry.state.connected = true;
        return ingest(binding, message).catch((err) =>
          log.warn(`[ingest] binding ${binding.id}: ${err.message}`),
        );
      });
      entry.state = { connected: true, inboundMode: binding.inboundMode, error: null };
    } catch (err) {
      entry.state = { connected: false, inboundMode: binding.inboundMode, error: err.message };
      log.warn(`[conn] binding ${binding.id} (${binding.platform}) failed to start: ${err.message}`);
    }
    onChange?.(binding.id, entry.state);
    return entry.state;
  }

  async function stopBinding(bindingId) {
    const entry = entries.get(bindingId);
    if (!entry) return;
    try {
      await entry.transport.stop?.();
    } catch (err) {
      log.warn(`[conn] binding ${bindingId} stop failed: ${err.message}`);
    }
    entries.delete(bindingId);
    onChange?.(bindingId, null);
  }

  async function startAll() {
    for (const binding of await store.list()) await startBinding(binding);
  }

  async function reconnect(bindingId) {
    await stopBinding(bindingId);
    const binding = await store.get(bindingId);
    if (!binding || binding.disabledAt) return null;
    return startBinding(binding);
  }

  async function stopAll() {
    for (const id of [...entries.keys()]) await stopBinding(id);
  }

  return { stateOf, ingest, startBinding, startAll, stopBinding, stopAll, reconnect, entries };
}
