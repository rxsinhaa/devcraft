import Dexie, { type Table } from "dexie";
import { OrderRecord } from "@/schema";
import {
  Operation,
  ConflictRecord,
  createOperation,
  getDeviceId,
  reduceOperations,
  deepEquals
} from "./syncEngine";
import { getGlobalHLC, compareHLC } from "./hlc";

export interface LocalOrder {
  id: string; // UUIDv4 string
  raw_message: string;
  parsed_order: OrderRecord;
  // Extracted top-level fields to enable fast IndexedDB secondary indexes
  customer: string | null;
  due_date: string | null;
  sync_status: "synced" | "pending_insert" | "pending_update" | "pending_delete";
  created_at: number; // timestamp (ms)
  updated_at: number; // timestamp (ms)
  is_completed: boolean; // order completion state
  payment_status: "pending" | "paid"; // payment status tracking
}

export interface EventLogEntry {
  id: string; // UUIDv4 string
  timestamp: string; // HLC timestamp string
  order_id: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  field: string; // "all" for CREATE/DELETE, or the specific field name (e.g. "due_date") for UPDATE
  value: any; // JSON representation of the value or full parsed order
  node_id: string;
}

export interface ConflictState {
  id: string; // "order_id:field"
  order_id: string;
  field: string;
  local_value: any;
  local_timestamp: string;
  remote_value: any;
  remote_timestamp: string;
  resolved: boolean;
}

class OrderDatabase extends Dexie {
  orders!: Table<LocalOrder, string>;
  event_log!: Table<EventLogEntry, string>;
  conflict_state!: Table<ConflictState, string>;
  operations!: Table<Operation, string>;

  constructor() {
    super("OrderDatabase");

    // Define DB schema with version upgrades
    this.version(1).stores({
      orders: "id, created_at, due_date, sync_status, customer",
      event_log: "id, timestamp, order_id, action, node_id",
      conflict_state: "id, order_id, resolved"
    });

    this.version(2).stores({
      orders: "id, created_at, due_date, sync_status, customer",
      event_log: "id, timestamp, order_id, action, node_id",
      conflict_state: "id, order_id, resolved",
      operations: "operationId, orderId, timestamp, type, deviceId, synced"
    });
  }
}

// Instantiate the database
export const db = new OrderDatabase();

/**
 * Requests the browser to flag IndexedDB storage for this origin as persistent.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof window !== "undefined" && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`Persistent storage request result: ${isPersisted}`);
      return isPersisted;
    } catch (error) {
      console.error("Failed to request persistent storage:", error);
    }
  }
  return false;
}

// Request persistent storage when the database opens successfully
db.on("ready", () => {
  requestPersistentStorage();
});

/**
 * Creates a new order locally, logging an operation in the persistent local operation queue.
 */
export async function createOrder(rawMessage: string, parsed: OrderRecord): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const deviceId = getDeviceId();

  const newOrder: LocalOrder = {
    id,
    raw_message: rawMessage,
    parsed_order: parsed,
    customer: parsed.customer,
    due_date: parsed.due_date,
    sync_status: "pending_insert",
    created_at: now,
    updated_at: now,
    is_completed: false,
    payment_status: "pending"
  };

  const createOp: Operation = createOperation(deviceId, id, "CREATE_ORDER", {
    oldValue: rawMessage,
    newValue: parsed,
    timestamp: now
  });

  try {
    await db.transaction("rw", [db.orders, db.operations, db.event_log], async () => {
      // 1. Write the order record
      await db.orders.add(newOrder);

      // 2. Append operation to local queue
      await db.operations.add(createOp);

      // 3. Keep backwards compatibility with event_log
      const hlcTime = getGlobalHLC().increment();
      const createEvent: EventLogEntry = {
        id: createOp.operationId,
        timestamp: hlcTime,
        order_id: id,
        action: "CREATE",
        field: "all",
        value: parsed,
        node_id: deviceId
      };
      await db.event_log.add(createEvent);
    });
    return id;
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space on your device to save orders.");
    }
    throw error;
  }
}

/**
 * Updates an order locally, generating individual field-level UPDATE operations.
 */
export async function updateOrder(id: string, updates: Partial<OrderRecord>): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();

  try {
    await db.transaction("rw", [db.orders, db.operations, db.event_log], async () => {
      const existing = await db.orders.get(id);
      if (!existing) throw new Error(`Order with ID ${id} not found.`);

      const updatedParsed: OrderRecord = {
        ...existing.parsed_order,
        ...updates
      };

      const newSyncStatus = existing.sync_status === "pending_insert"
        ? "pending_insert"
        : "pending_update";

      // 1. Update local order record
      await db.orders.update(id, {
        parsed_order: updatedParsed,
        customer: updatedParsed.customer,
        due_date: updatedParsed.due_date,
        sync_status: newSyncStatus,
        updated_at: now
      });

      // 2. Append field-level operations to the local operation log
      for (const key of Object.keys(updates) as Array<keyof OrderRecord>) {
        const op = createOperation(deviceId, id, "UPDATE_FIELD", {
          field: key,
          oldValue: existing.parsed_order[key],
          newValue: updates[key],
          timestamp: now
        });
        await db.operations.add(op);

        const hlcTime = getGlobalHLC().increment();
        const updateEvent: EventLogEntry = {
          id: op.operationId,
          timestamp: hlcTime,
          order_id: id,
          action: "UPDATE",
          field: key,
          value: updates[key],
          node_id: deviceId
        };
        await db.event_log.add(updateEvent);
      }
    });
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space on your device to update this order.");
    }
    throw error;
  }
}

/**
 * Deletes an order locally, appending a DELETE_ORDER operation.
 */
export async function deleteOrder(id: string): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();

  try {
    await db.transaction("rw", [db.orders, db.operations, db.event_log], async () => {
      const existing = await db.orders.get(id);
      if (!existing) return;

      const deleteOp = createOperation(deviceId, id, "DELETE_ORDER", {
        timestamp: now
      });
      await db.operations.add(deleteOp);

      const hlcTime = getGlobalHLC().increment();
      const deleteEvent: EventLogEntry = {
        id: deleteOp.operationId,
        timestamp: hlcTime,
        order_id: id,
        action: "DELETE",
        field: "all",
        value: null,
        node_id: deviceId
      };
      await db.event_log.add(deleteEvent);

      if (existing.sync_status === "pending_insert") {
        // Purge immediately if it was never synced
        await db.orders.delete(id);
      } else {
        // Soft delete locally with pending_delete status
        await db.orders.update(id, {
          sync_status: "pending_delete",
          updated_at: now
        });
      }
    });
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space to perform this deletion.");
    }
    throw error;
  }
}

/**
 * Resolves a conflict by choosing the winning value.
 * Appends a RESOLVE_CONFLICT operation to the log.
 */
export async function resolveConflict(orderId: string, field: string, resolvedValue: any): Promise<void> {
  const conflictId = `conflict:${orderId}:${field}`;
  const now = Date.now();
  const deviceId = getDeviceId();

  await db.transaction("rw", [db.orders, db.conflict_state, db.operations, db.event_log], async () => {
    // 1. Remove the conflict state record (or mark resolved)
    await db.conflict_state.delete(`${orderId}:${field}`);
    await db.conflict_state.delete(conflictId);

    // 2. Append RESOLVE_CONFLICT operation to local operation log
    const resolveOp = createOperation(deviceId, orderId, "RESOLVE_CONFLICT", {
      field,
      newValue: resolvedValue,
      conflictId,
      timestamp: now
    });
    await db.operations.add(resolveOp);

    // 3. Update local order state
    const localOrder = await db.orders.get(orderId);
    if (localOrder) {
      const updatedParsed = {
        ...localOrder.parsed_order,
        [field]: resolvedValue
      };

      // Check if there are other unresolved conflicts for this order
      const remainingConflicts = await db.conflict_state
        .where("order_id")
        .equals(orderId)
        .toArray();

      const stillHasConflicts = remainingConflicts.length > 0;

      await db.orders.update(orderId, {
        parsed_order: updatedParsed,
        customer: field === "customer" ? resolvedValue : localOrder.customer,
        due_date: field === "due_date" ? resolvedValue : localOrder.due_date,
        "parsed_order.needs_clarification": stillHasConflicts,
        sync_status: "pending_update",
        updated_at: now
      });
    }
  });
}

/**
 * Synchronizes local operations with the remote server.
 * Reads unsynced local operations, sends them to /api/sync,
 * receives peer operations, and deterministically applies them.
 */
export async function syncWithServer(): Promise<{ syncedCount: number; peerOpsCount: number }> {
  try {
    const deviceId = getDeviceId();

    // 1. Retrieve all unsynced operations from local queue
    const allOps = await db.operations.toArray();
    const unsyncedOps = allOps.filter(op => !op.synced);

    // 2. Post to server sync endpoint
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        operations: unsyncedOps
      })
    });

    if (!response.ok) {
      throw new Error(`Sync API responded with status ${response.status}`);
    }

    const data = await response.json();
    const acknowledgedOpIds: string[] = data.acknowledgedOpIds || [];
    const serverOps: Operation[] = data.serverOperations || [];

    // 3. Mark acknowledged local operations as synced
    await db.transaction("rw", [db.operations, db.orders, db.conflict_state], async () => {
      for (const opId of acknowledgedOpIds) {
        const op = await db.operations.get(opId);
        if (op) {
          await db.operations.update(opId, { synced: true });
        }
      }

      // 4. Ingest new server operations into local queue
      for (const sOp of serverOps) {
        const exists = await db.operations.get(sOp.operationId);
        if (!exists) {
          await db.operations.add({ ...sOp, synced: true });
        }
      }

      // 5. Re-reduce all combined operations to update local order state & conflicts
      const combinedOps = await db.operations.toArray();
      const reduction = reduceOperations(combinedOps);

      // Write reduced orders
      for (const [orderId, rOrder] of reduction.orders.entries()) {
        const local = await db.orders.get(orderId);
        if (rOrder.is_deleted) {
          if (local) {
            await db.orders.delete(orderId);
          }
        } else if (local) {
          await db.orders.update(orderId, {
            parsed_order: rOrder.parsed_order,
            customer: rOrder.customer,
            due_date: rOrder.due_date,
            is_completed: rOrder.is_completed,
            payment_status: rOrder.payment_status,
            sync_status: "synced",
            updated_at: rOrder.updated_at
          });
        } else {
          await db.orders.add({
            id: orderId,
            raw_message: rOrder.raw_message,
            parsed_order: rOrder.parsed_order,
            customer: rOrder.customer,
            due_date: rOrder.due_date,
            sync_status: "synced",
            created_at: rOrder.created_at,
            updated_at: rOrder.updated_at,
            is_completed: rOrder.is_completed,
            payment_status: rOrder.payment_status
          });
        }
      }

      // Write reduced conflicts into conflict_state
      for (const [conflictId, cRecord] of reduction.conflicts.entries()) {
        if (cRecord.status === "pending") {
          const ops = cRecord.conflictingOperations;
          const localOp = ops.find(o => o.deviceId === deviceId) || ops[0];
          const remoteOp = ops.find(o => o.deviceId !== deviceId) || ops[1] || ops[0];

          await db.conflict_state.put({
            id: `${cRecord.orderId}:${cRecord.field}`,
            order_id: cRecord.orderId,
            field: cRecord.field,
            local_value: localOp ? localOp.value : null,
            local_timestamp: localOp ? String(localOp.timestamp) : String(Date.now()),
            remote_value: remoteOp ? remoteOp.value : null,
            remote_timestamp: remoteOp ? String(remoteOp.timestamp) : String(Date.now()),
            resolved: false
          });
        } else {
          await db.conflict_state.delete(`${cRecord.orderId}:${cRecord.field}`);
        }
      }
    });

    return {
      syncedCount: acknowledgedOpIds.length,
      peerOpsCount: serverOps.length
    };
  } catch (err) {
    console.error("syncWithServer failed (device may be offline):", err);
    return { syncedCount: 0, peerOpsCount: 0 };
  }
}

/**
 * Replays event log entries onto local state (for backwards compatibility / simulation).
 */
export async function replayEvents(incomingEvents: EventLogEntry[]): Promise<void> {
  const deviceId = getDeviceId();

  // Convert incoming EventLogEntries to Operations and apply them
  const incomingOps: Operation[] = incomingEvents.map(e => ({
    operationId: e.id,
    deviceId: e.node_id,
    orderId: e.order_id,
    timestamp: parseInt(e.timestamp.split(":")[0], 10) || Date.now(),
    type: e.action === "CREATE" ? "CREATE_ORDER" : e.action === "DELETE" ? "DELETE_ORDER" : "UPDATE_FIELD",
    field: e.field === "all" ? undefined : e.field,
    newValue: e.value,
    synced: false
  }));

  for (const op of incomingOps) {
    const exists = await db.operations.get(op.operationId);
    if (!exists) {
      await db.operations.add(op);
    }
  }

  // Re-reduce
  const allOps = await db.operations.toArray();
  const reduction = reduceOperations(allOps);

  for (const [orderId, rOrder] of reduction.orders.entries()) {
    const local = await db.orders.get(orderId);
    if (local) {
      await db.orders.update(orderId, {
        parsed_order: rOrder.parsed_order,
        customer: rOrder.customer,
        due_date: rOrder.due_date,
        is_completed: rOrder.is_completed,
        payment_status: rOrder.payment_status,
        updated_at: rOrder.updated_at
      });
    }
  }

  for (const [conflictId, cRecord] of reduction.conflicts.entries()) {
    if (cRecord.status === "pending") {
      const ops = cRecord.conflictingOperations;
      const localOp = ops.find(o => o.deviceId === deviceId) || ops[0];
      const remoteOp = ops.find(o => o.deviceId !== deviceId) || ops[1] || ops[0];

      await db.conflict_state.put({
        id: `${cRecord.orderId}:${cRecord.field}`,
        order_id: cRecord.orderId,
        field: cRecord.field,
        local_value: localOp ? localOp.value : null,
        local_timestamp: localOp ? String(localOp.timestamp) : String(Date.now()),
        remote_value: remoteOp ? remoteOp.value : null,
        remote_timestamp: remoteOp ? String(remoteOp.timestamp) : String(Date.now()),
        resolved: false
      });
    }
  }
}

/**
 * Retrieves a single order record by ID.
 */
export async function getOrder(id: string): Promise<LocalOrder | undefined> {
  return db.orders.get(id);
}

/**
 * Retrieves all active orders, excluding those flagged as pending_delete.
 * Sorted chronologically descending by creation date.
 */
export async function getActiveOrders(): Promise<LocalOrder[]> {
  return db.orders
    .where("sync_status")
    .noneOf(["pending_delete"])
    .reverse()
    .sortBy("created_at");
}

/**
 * Queries all local modifications that have not yet been synchronized.
 */
export async function getPendingChanges(): Promise<LocalOrder[]> {
  return db.orders
    .where("sync_status")
    .anyOf(["pending_insert", "pending_update", "pending_delete"])
    .toArray();
}

/**
 * Marks a batch of local orders as synchronized with the remote database.
 */
export async function markAsSynced(ids: string[]): Promise<void> {
  const now = Date.now();

  await db.transaction("rw", db.orders, async () => {
    for (const id of ids) {
      const existing = await db.orders.get(id);
      if (!existing) continue;

      if (existing.sync_status === "pending_delete") {
        await db.orders.delete(id);
      } else {
        await db.orders.update(id, {
          sync_status: "synced",
          updated_at: now
        });
      }
    }
  });
}

/**
 * Toggles the completion status of an order and appends an operation.
 */
export async function toggleOrderCompletion(id: string): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();

  await db.transaction("rw", [db.orders, db.operations, db.event_log], async () => {
    const existing = await db.orders.get(id);
    if (!existing) throw new Error(`Order with ID ${id} not found.`);

    const newCompleted = !existing.is_completed;

    // Update local order
    await db.orders.update(id, {
      is_completed: newCompleted,
      updated_at: now
    });

    // Append operation
    const op = createOperation(deviceId, id, "UPDATE_FIELD", {
      field: "is_completed",
      oldValue: existing.is_completed,
      newValue: newCompleted,
      timestamp: now
    });
    await db.operations.add(op);
  });
}

/**
 * Toggles the payment status of an order and appends an operation.
 */
export async function togglePaymentStatus(id: string): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();

  await db.transaction("rw", [db.orders, db.operations, db.event_log], async () => {
    const existing = await db.orders.get(id);
    if (!existing) throw new Error(`Order with ID ${id} not found.`);

    const newPaymentStatus = existing.payment_status === "paid" ? "pending" : "paid";

    // Update local order
    await db.orders.update(id, {
      payment_status: newPaymentStatus,
      updated_at: now
    });

    // Append operation
    const op = createOperation(deviceId, id, "UPDATE_FIELD", {
      field: "payment_status",
      oldValue: existing.payment_status,
      newValue: newPaymentStatus,
      timestamp: now
    });
    await db.operations.add(op);
  });
}
