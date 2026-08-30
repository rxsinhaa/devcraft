import Dexie, { type Table } from "dexie";
import { OrderRecord } from "@/schema";
import { getGlobalHLC, compareHLC } from "./hlc";

export interface Operation {
  operationId: string;
  deviceId: string;
  orderId: string;
  timestamp: number;
  type: "CREATE_ORDER" | "DELETE_ORDER" | "UPDATE_FIELD" | "RESOLVE_CONFLICT";
  field?: string;
  oldValue?: any;
  newValue?: any;
  synced: boolean;
}

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
    
    // Define the DB schema, including events log and conflict state table
    this.version(1).stores({
      orders: "id, created_at, due_date, sync_status, customer",
      event_log: "id, timestamp, order_id, action, node_id",
      conflict_state: "id, order_id, resolved"
    });

    this.version(2).stores({
      operations: "operationId, deviceId, orderId, timestamp, type, synced"
    });
  }
}

// Instantiate the database
export const db = new OrderDatabase();

/**
 * Retrieves or initializes a persistent device ID.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "server-device";
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}

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
 * Creates and logs a local operation, then triggers the replay engine.
 */
export async function logOperation(opData: Omit<Operation, "operationId" | "deviceId" | "timestamp" | "synced">): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const operationId = crypto.randomUUID();
  const timestamp = Date.now();
  
  const op: Operation = {
    ...opData,
    deviceId,
    operationId,
    timestamp,
    synced: false
  };

  await db.operations.add(op);
  await replayOperations();

  // Trigger push/pull sync to server in background
  triggerSync().catch(err => console.error("Immediate sync error:", err));
}

/**
 * Creates a new order locally, logging a CREATE_ORDER operation.
 */
export async function createOrder(rawMessage: string, parsed: OrderRecord): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
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

  try {
    await logOperation({
      orderId: id,
      type: "CREATE_ORDER",
      newValue: newOrder
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
 * Updates an order locally, generating individual field-level UPDATE_FIELD operations.
 */
export async function updateOrder(id: string, updates: Partial<OrderRecord>): Promise<void> {
  try {
    const existing = await db.orders.get(id);
    if (!existing) throw new Error(`Order with ID ${id} not found.`);

    for (const key of Object.keys(updates) as Array<keyof OrderRecord>) {
      const oldValue = existing.parsed_order[key];
      const newValue = updates[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        await logOperation({
          orderId: id,
          type: "UPDATE_FIELD",
          field: key,
          oldValue,
          newValue
        });
      }
    }
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space on your device to update this order.");
    }
    throw error;
  }
}

/**
 * Deletes an order, logging a DELETE_ORDER operation.
 */
export async function deleteOrder(id: string): Promise<void> {
  try {
    const existing = await db.orders.get(id);
    if (!existing) return;

    await logOperation({
      orderId: id,
      type: "DELETE_ORDER"
    });
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space to perform this deletion.");
    }
    throw error;
  }
}

/**
 * Replays event log entries (potentially containing remote sync events)
 * onto the local orders state. Suspends merge and logs conflicts into conflict_state
 * if two concurrent updates on the same field differ in value.
 */
/**
 * Replays event log entries (translates events to operations for backward compatibility)
 */
export async function replayEvents(incomingEvents: EventLogEntry[]): Promise<void> {
  for (const event of incomingEvents) {
    const timestamp = parseInt(event.timestamp.split(":")[0]) || Date.now();
    const type = event.action === "CREATE" ? "CREATE_ORDER" : (event.action === "DELETE" ? "DELETE_ORDER" : "UPDATE_FIELD");
    
    // Construct Operation
    const op: Operation = {
      operationId: event.id,
      deviceId: event.node_id,
      orderId: event.order_id,
      timestamp,
      type,
      field: event.field !== "all" ? event.field : undefined,
      newValue: event.value,
      synced: true
    };

    const existing = await db.operations.get(op.operationId);
    if (!existing) {
      await db.operations.add(op);
    }
  }
  await replayOperations();
}

/**
 * Deterministic operation replay engine. Rebuilds the database state from the operation log.
 */
export async function replayOperations(): Promise<void> {
  const allOps = await db.operations.toArray();

  // Deterministic ordering: timestamp -> deviceId -> operationId
  allOps.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.deviceId !== b.deviceId) {
      return a.deviceId.localeCompare(b.deviceId);
    }
    return a.operationId.localeCompare(b.operationId);
  });

  const ordersMap: Record<string, LocalOrder> = {};
  const conflictsMap: Record<string, ConflictRecord> = {};
  const deletedOrders = new Set<string>();
  const deleteOps: Record<string, Operation> = {};
  
  // Track field state history for conflict detection
  // Key: orderId:field -> { lastOp: Operation, value: any }
  const fieldHistory: Record<string, { lastOp: Operation; value: any }> = {};

  for (const op of allOps) {
    const { orderId, type, field, newValue, oldValue, deviceId } = op;

    if (type === "CREATE_ORDER") {
      ordersMap[orderId] = {
        ...newValue,
        is_completed: newValue.is_completed || false,
        payment_status: newValue.payment_status || "pending",
        sync_status: op.synced ? "synced" : "pending_insert"
      };
      deletedOrders.delete(orderId);
    } 
    else if (type === "DELETE_ORDER") {
      deletedOrders.add(orderId);
      deleteOps[orderId] = op;
      delete ordersMap[orderId];
      
      // Update vs Delete conflict check
      for (const [key, history] of Object.entries(fieldHistory)) {
        if (key.startsWith(`${orderId}:`) && history.lastOp.deviceId !== deviceId) {
          const conflictId = `${orderId}:delete`;
          conflictsMap[conflictId] = {
            conflictId,
            orderId,
            field: "delete",
            conflictingOperations: [
              {
                operationId: op.operationId,
                deviceId: op.deviceId,
                value: "delete"
              },
              {
                operationId: history.lastOp.operationId,
                deviceId: history.lastOp.deviceId,
                value: "update"
              }
            ],
            status: "pending"
          };
        }
      }
    } 
    else if (type === "UPDATE_FIELD" && field) {
      const fieldKey = `${orderId}:${field}`;

      // Update vs Delete conflict check
      if (deletedOrders.has(orderId)) {
        if (deleteOps[orderId] && deleteOps[orderId].deviceId !== deviceId) {
          const conflictId = `${orderId}:delete`;
          conflictsMap[conflictId] = {
            conflictId,
            orderId,
            field: "delete",
            conflictingOperations: [
              {
                operationId: deleteOps[orderId].operationId,
                deviceId: deleteOps[orderId].deviceId,
                value: "delete"
              },
              {
                operationId: op.operationId,
                deviceId: op.deviceId,
                value: "update"
              }
            ],
            status: "pending"
          };
        }
        continue;
      }

      const order = ordersMap[orderId];
      if (order) {
        const prev = fieldHistory[fieldKey];
        if (prev) {
          // Conflict criteria: concurrent updates from different devices proposing different values
          const isDifferentDevice = op.deviceId !== prev.lastOp.deviceId;
          const isConcurrent = op.oldValue !== prev.value;
          const isDifferentValue = op.newValue !== prev.value;

          if (isDifferentDevice && isConcurrent && isDifferentValue) {
            const conflictId = `${orderId}:${field}`;
            conflictsMap[conflictId] = {
              conflictId,
              orderId,
              field,
              conflictingOperations: [
                {
                  operationId: prev.lastOp.operationId,
                  deviceId: prev.lastOp.deviceId,
                  value: prev.value
                },
                {
                  operationId: op.operationId,
                  deviceId: op.deviceId,
                  value: op.newValue
                }
              ],
              status: "pending"
            };
          } else {
            applyFieldUpdate(order, field, newValue);
            if (!op.synced && order.sync_status === "synced") {
              order.sync_status = "pending_update";
            }
            fieldHistory[fieldKey] = { lastOp: op, value: newValue };
          }
        } else {
          applyFieldUpdate(order, field, newValue);
          if (!op.synced && order.sync_status === "synced") {
            order.sync_status = "pending_update";
          }
          fieldHistory[fieldKey] = { lastOp: op, value: newValue };
        }
      }
    } 
    else if (type === "RESOLVE_CONFLICT" && field) {
      const order = ordersMap[orderId];
      if (order) {
        applyFieldUpdate(order, field, newValue);
        if (!op.synced && order.sync_status === "synced") {
          order.sync_status = "pending_update";
        }
        fieldHistory[`${orderId}:${field}`] = { lastOp: op, value: newValue };
        delete conflictsMap[`${orderId}:${field}`];
      }

      if (field === "delete") {
        if (newValue === "delete") {
          deletedOrders.add(orderId);
          delete ordersMap[orderId];
        } else {
          deletedOrders.delete(orderId);
          if (!ordersMap[orderId] && deleteOps[orderId]) {
            const createOp = allOps.find(o => o.orderId === orderId && o.type === "CREATE_ORDER");
            if (createOp) {
              ordersMap[orderId] = {
                ...createOp.newValue,
                sync_status: op.synced ? "synced" : "pending_update"
              };
              for (const [key, history] of Object.entries(fieldHistory)) {
                if (key.startsWith(`${orderId}:`)) {
                  const f = key.split(":")[1];
                  applyFieldUpdate(ordersMap[orderId], f, history.value);
                }
              }
            }
          }
        }
        delete conflictsMap[`${orderId}:delete`];
      }
    }
  }

  // Rewrite database tables inside transaction
  await db.transaction("rw", [db.orders, db.conflict_state], async () => {
    await db.orders.clear();
    await db.conflict_state.clear();

    for (const order of Object.values(ordersMap)) {
      const hasConflicts = Object.values(conflictsMap).some(c => c.orderId === order.id && c.status === "pending");
      if (hasConflicts) {
        order.parsed_order.needs_clarification = true;
        order.parsed_order.confidence = 0.3;
      }
      await db.orders.add(order);
    }

    for (const conflict of Object.values(conflictsMap)) {
      if (conflict.status !== "pending") continue;
      
      const localDevice = getOrCreateDeviceId();
      const localOp = conflict.conflictingOperations.find(o => o.deviceId === localDevice);
      const remoteOp = conflict.conflictingOperations.find(o => o.deviceId !== localDevice);

      const conflictState: ConflictState = {
        id: conflict.conflictId,
        order_id: conflict.orderId,
        field: conflict.field,
        local_value: localOp !== undefined ? localOp.value : conflict.conflictingOperations[0].value,
        local_timestamp: localOp !== undefined ? `${localOp.deviceId}` : "local",
        remote_value: remoteOp !== undefined ? remoteOp.value : conflict.conflictingOperations[1].value,
        remote_timestamp: remoteOp !== undefined ? `${remoteOp.deviceId}` : "remote",
        resolved: false
      };
      await db.conflict_state.add(conflictState);
    }
  });
}

function applyFieldUpdate(order: LocalOrder, field: string, value: any) {
  (order as any)[field] = value;
  if (field === "customer" || field === "due_date" || field === "amount" || field === "needs_clarification") {
    (order.parsed_order as any)[field] = value;
  }
}

export interface ConflictRecord {
  conflictId: string;
  orderId: string;
  field: string;
  conflictingOperations: {
    operationId: string;
    deviceId: string;
    value: any;
  }[];
  status: "pending" | "resolved";
}

/**
 * Resolves a conflict by appending a RESOLVE_CONFLICT operation.
 */
export async function resolveConflict(orderId: string, field: string, resolvedValue: any): Promise<void> {
  await logOperation({
    orderId,
    type: "RESOLVE_CONFLICT",
    field,
    newValue: resolvedValue
  });
}

/**
 * Retrieves a single order record by ID.
 */
export async function getOrder(id: string): Promise<LocalOrder | undefined> {
  return db.orders.get(id);
}

/**
 * Retrieves all active orders.
 */
export async function getActiveOrders(): Promise<LocalOrder[]> {
  return db.orders.reverse().sortBy("created_at");
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
      await db.orders.update(id, {
        sync_status: "synced",
        updated_at: now
      });
    }
  });
}

/**
 * Toggles completion status of an order.
 */
export async function toggleOrderCompletion(id: string): Promise<void> {
  const existing = await db.orders.get(id);
  if (!existing) throw new Error(`Order with ID ${id} not found.`);

  const oldValue = existing.is_completed;
  const newValue = !oldValue;

  await logOperation({
    orderId: id,
    type: "UPDATE_FIELD",
    field: "is_completed",
    oldValue,
    newValue
  });
}

/**
 * Toggles payment status of an order.
 */
export async function togglePaymentStatus(id: string): Promise<void> {
  const existing = await db.orders.get(id);
  if (!existing) throw new Error(`Order with ID ${id} not found.`);

  const oldValue = existing.payment_status;
  const newValue = oldValue === "paid" ? "pending" : "paid";

  await logOperation({
    orderId: id,
    type: "UPDATE_FIELD",
    field: "payment_status",
    oldValue,
    newValue
  });
}

/**
 * Clears all records from IndexedDB tables.
 */
export async function clearAllData(): Promise<void> {
  await db.transaction("rw", [db.orders, db.event_log, db.conflict_state, db.operations], async () => {
    await db.orders.clear();
    await db.event_log.clear();
    await db.conflict_state.clear();
    await db.operations.clear();
  });
}

/**
 * Performs a push/pull sync of the operation log with the server.
 */
export async function triggerSync(): Promise<void> {
  if (typeof window === "undefined" || !navigator.onLine) return;

  try {
    const localOps = await db.operations.toArray();
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientOperations: localOps })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { serverOperations } = await res.json();

    let addedAny = false;
    for (const op of serverOperations) {
      const existing = await db.operations.get(op.operationId);
      if (!existing) {
        await db.operations.add(op);
        addedAny = true;
      }
    }

    // Mark all local ops as synced
    await db.operations.where("synced").equals(0).modify({ synced: true });

    if (addedAny) {
      await replayOperations();
    }
  } catch (err) {
    console.error("Sync failed:", err);
  }
}

